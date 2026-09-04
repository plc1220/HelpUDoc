"""Export agent spans to Cloud Trace and Cloud Logging alongside Langfuse.

Langfuse is the only destination for trace data today, which makes it a single
point of failure: when ``langfuse-web`` is down the agent's spans are dropped
after a retry storm, and nothing records that a run happened. This module adds a
second, independent path to GCP so trace data survives a Langfuse outage.

It works because the Langfuse SDK v3 is built on OpenTelemetry and *reuses* an
already-installed global TracerProvider rather than replacing it -- see
``langfuse._client.resource_manager._init_tracer_provider``, which only creates
its own provider when the global one is still a ``ProxyTracerProvider``. So if
``configure_tracing`` runs first, Langfuse attaches its span processor to the
provider built here, and the two processors then export the same spans
independently. A stalled Langfuse exporter cannot block or drop the GCP export.

Two processors are installed:

* ``BatchSpanProcessor(CloudTraceSpanExporter)`` sends spans to Cloud Trace,
  which keeps their hierarchy and latency waterfall.
* ``SpanLogProcessor`` emits one compact record per span through the stdlib
  ``logging`` module. ``logging_setup`` already renders that as a Cloud Logging
  JSON payload on stdout, so this half needs no exporter and no credentials --
  the GKE node logging agent is already collecting the container.

Because the log record carries ``logging.googleapis.com/trace``, an entry in
Logs Explorer links to its span in Cloud Trace.
"""

from __future__ import annotations

import logging
from typing import Optional

from opentelemetry import trace as otel_trace_api
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

from .config.env import env_trim

logger = logging.getLogger(__name__)
span_logger = logging.getLogger("helpudoc_agent.spans")

_TRUTHY = frozenset({"1", "true", "yes", "y", "on"})

# Span attributes whose values are prompt or completion bodies. They routinely
# exceed the 256 KiB Cloud Logging entry limit once documents are in context,
# and they are the most sensitive data the agent handles, so they stay out of
# the log record unless deliberately switched on.
_BODY_ATTRIBUTE_PREFIXES = (
    "langfuse.observation.input",
    "langfuse.observation.output",
    "gen_ai.prompt",
    "gen_ai.completion",
)

# Kept when payloads are excluded: enough to answer "which model, how many
# tokens, how long, did it fail" without carrying any conversation content.
_METADATA_ATTRIBUTE_PREFIXES = (
    "gen_ai.request",
    "gen_ai.response",
    "gen_ai.system",
    "gen_ai.usage",
    "langfuse.observation.type",
    "langfuse.observation.level",
    "langfuse.session",
    "langfuse.user",
)

_MAX_ATTRIBUTE_CHARS = 4096

_configured = False
_provider: Optional[TracerProvider] = None


def _flag(name: str) -> bool:
    return (env_trim(name) or "").lower() in _TRUTHY


def _tracing_enabled() -> bool:
    return _flag("GCP_TRACE_ENABLED")


def _project_id() -> Optional[str]:
    return env_trim("GOOGLE_CLOUD_PROJECT") or env_trim("GCLOUD_PROJECT")


def _sample_ratio() -> float:
    raw = env_trim("GCP_TRACE_SAMPLE_RATIO")
    if raw is None:
        return 1.0
    try:
        return min(max(float(raw), 0.0), 1.0)
    except ValueError:
        logger.warning("GCP_TRACE_SAMPLE_RATIO is not a number; sampling every span")
        return 1.0


def _keep_attribute(key: str, include_payloads: bool) -> bool:
    if key.startswith(_BODY_ATTRIBUTE_PREFIXES):
        return include_payloads
    return key.startswith(_METADATA_ATTRIBUTE_PREFIXES)


class SpanLogProcessor(SpanProcessor):
    """Emit one structured log record per finished span.

    Subclasses the SDK base rather than duck-typing the four public methods:
    the SDK also calls internal hooks such as ``_on_ending``, so a standalone
    class breaks on span end.
    """

    def __init__(self, project_id: Optional[str], *, include_payloads: bool = False) -> None:
        self._project_id = project_id
        self._include_payloads = include_payloads

    def on_end(self, span: ReadableSpan) -> None:
        try:
            span_logger.info(span.name, extra=self._record_fields(span))
        except Exception:
            # A logging failure must never break the span pipeline, which would
            # take the Cloud Trace export down with it.
            logger.debug("Failed to log span %s", getattr(span, "name", "?"), exc_info=True)

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True

    def _record_fields(self, span: ReadableSpan) -> dict:
        fields: dict = {"spanName": span.name}

        context = span.get_span_context()
        if context is not None and context.trace_id:
            trace_hex = format(context.trace_id, "032x")
            fields["logging.googleapis.com/spanId"] = format(context.span_id, "016x")
            if self._project_id:
                # This exact format is what links the entry to its Cloud Trace
                # span in the console; a bare trace id does not resolve.
                fields["logging.googleapis.com/trace"] = (
                    f"projects/{self._project_id}/traces/{trace_hex}"
                )
            else:
                fields["traceId"] = trace_hex

        if span.start_time is not None and span.end_time is not None:
            fields["durationMs"] = round((span.end_time - span.start_time) / 1_000_000, 3)
        if span.status is not None:
            fields["spanStatus"] = span.status.status_code.name

        for key, value in (span.attributes or {}).items():
            if not _keep_attribute(key, self._include_payloads):
                continue
            if isinstance(value, str) and len(value) > _MAX_ATTRIBUTE_CHARS:
                value = value[:_MAX_ATTRIBUTE_CHARS] + "…[truncated]"
            fields[key] = value

        return fields


def _build_cloud_trace_processor(project_id: Optional[str]) -> Optional[BatchSpanProcessor]:
    """Cloud Trace exporter, or None when the dependency is absent.

    CloudTraceSpanExporter is deprecated upstream in favour of OTLP to
    telemetry.googleapis.com and warns on construction. It is kept because it
    resolves credentials from ADC unaided, whereas the OTLP path needs manual
    google-auth token plumbing against an API that is still pre-GA. See the note
    in requirements-api.txt.
    """
    try:
        from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter
    except ModuleNotFoundError as exc:
        # A checkout without opentelemetry-exporter-gcp-trace should still boot;
        # the log half above works regardless.
        logger.warning("Cloud Trace exporter unavailable, spans go to logs only: %s", exc)
        return None
    kwargs = {"project_id": project_id} if project_id else {}
    return BatchSpanProcessor(CloudTraceSpanExporter(**kwargs))


def configure_tracing(*, force: bool = False) -> Optional[TracerProvider]:
    """Install the global TracerProvider that exports to GCP.

    Must run before the first Langfuse client is built so Langfuse attaches to
    this provider. Returns None when ``GCP_TRACE_ENABLED`` is unset, leaving
    Langfuse to set up its own provider exactly as before.
    """
    global _configured, _provider
    if _configured and not force:
        return _provider

    if not _tracing_enabled():
        _configured = True
        _provider = None
        return None

    project_id = _project_id()
    if not project_id:
        logger.warning(
            "GCP_TRACE_ENABLED is set but GOOGLE_CLOUD_PROJECT is not; "
            "spans will not carry a Cloud Trace correlation field"
        )

    ratio = _sample_ratio()
    provider = TracerProvider(
        resource=Resource.create(
            {
                k: v
                for k, v in {
                    "service.name": env_trim("OTEL_SERVICE_NAME") or "helpudoc-agent",
                    "service.version": env_trim("GIT_COMMIT"),
                }.items()
                if v
            }
        ),
        # ParentBased keeps a sampled trace whole: a child is not dropped
        # independently of the root it belongs to.
        sampler=ParentBased(TraceIdRatioBased(ratio)) if ratio < 1.0 else None,
    )

    provider.add_span_processor(
        SpanLogProcessor(project_id, include_payloads=_flag("GCP_TRACE_INCLUDE_PAYLOADS"))
    )
    cloud_trace = _build_cloud_trace_processor(project_id)
    if cloud_trace is not None:
        provider.add_span_processor(cloud_trace)

    otel_trace_api.set_tracer_provider(provider)
    if otel_trace_api.get_tracer_provider() is not provider:
        # OTel refuses to replace an already-installed provider and only logs a
        # warning. Say so plainly, because the symptom otherwise is silence.
        logger.warning(
            "A TracerProvider was already installed; GCP span export is inactive. "
            "configure_tracing must run before any other OpenTelemetry setup."
        )

    _provider = provider
    _configured = True
    return provider


def shutdown_tracing() -> None:
    """Flush buffered spans. Called on app shutdown so a terminating pod does
    not discard the spans still sitting in the batch processor's queue."""
    global _provider
    if _provider is None:
        return
    try:
        _provider.shutdown()
    except Exception:
        logger.exception("Failed to shut down the tracer provider cleanly")


def reset_tracing_for_tests() -> None:
    """Clear module state and OTel's global provider.

    OTel allows the global provider to be set once per process and only logs a
    warning on a second attempt, so tests cannot reconfigure without reaching
    for this private field.
    """
    global _configured, _provider
    _configured = False
    _provider = None
    otel_trace_api._TRACER_PROVIDER = None  # noqa: SLF001
    otel_trace_api._TRACER_PROVIDER_SET_ONCE._done = False  # noqa: SLF001

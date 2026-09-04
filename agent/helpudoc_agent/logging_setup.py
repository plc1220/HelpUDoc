"""Process-wide logging configuration for the agent service.

Without this module the agent has no logging handler at all. Uvicorn configures
only its own ``uvicorn*`` loggers, so every ``helpudoc_agent`` record propagates
to a bare root logger and falls through to ``logging.lastResort``: ``info`` and
``debug`` are discarded outright, and ``warning`` and above reach stderr as a
bare message with no level, logger name, or timestamp.

In GKE that is compounded twice. The node logging agent files anything on the
stderr stream as severity ERROR, so warnings are indistinguishable from errors,
and it splits on newlines, so one traceback becomes one entry per frame with no
way to reassemble them.

These problems are fixed by emitting one JSON object per record on **stdout**.
Cloud Logging parses such a line into ``jsonPayload`` and honours the reserved
``severity``, ``message``, and ``logging.googleapis.com/*`` fields, so severity
comes from the record rather than the stream, and an exception stays in the one
entry that carries it. This needs no OpenTelemetry SDK and no exporter: log
collection is a node-level platform capability, separate from tracing.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

from .config.env import env_trim

# Cloud Logging accepts a fixed severity enum. Map by numeric level so custom
# levels between the standard ones round down to the nearest real severity
# instead of being emitted as an unrecognised name.
_SEVERITY_THRESHOLDS: tuple[tuple[int, str], ...] = (
    (logging.CRITICAL, "CRITICAL"),
    (logging.ERROR, "ERROR"),
    (logging.WARNING, "WARNING"),
    (logging.INFO, "INFO"),
    (logging.DEBUG, "DEBUG"),
)

# Attributes LogRecord always carries, plus uvicorn's ``color_message``, which
# is the same text with ANSI escapes and is noise in a structured payload.
# Anything outside this set arrived via ``extra=`` and is a real field.
_RESERVED_RECORD_ATTRS = frozenset(
    {
        "color_message",
        "args", "asctime", "created", "exc_info", "exc_text", "filename",
        "funcName", "levelname", "levelno", "lineno", "message", "module",
        "msecs", "msg", "name", "pathname", "process", "processName",
        "relativeCreated", "stack_info", "taskName", "thread", "threadName",
    }
)

_TEXT_FORMAT = "%(asctime)s %(levelname)-8s %(name)s: %(message)s"

_configured = False


def _severity_for(levelno: int) -> str:
    for threshold, name in _SEVERITY_THRESHOLDS:
        if levelno >= threshold:
            return name
    return "DEFAULT"


class StdoutHandler(logging.StreamHandler):
    """StreamHandler that resolves ``sys.stdout`` at emit time.

    ``logging.StreamHandler(sys.stdout)`` captures whatever stdout is bound at
    construction. Anything that later replaces the stream -- a test harness,
    ``contextlib.redirect_stdout`` -- leaves the handler writing to a stale and
    possibly closed file. Looking it up per record keeps output following the
    process's real stdout.
    """

    def __init__(self) -> None:
        super().__init__(sys.stdout)

    @property
    def stream(self):  # type: ignore[override]
        return sys.stdout

    @stream.setter
    def stream(self, _value) -> None:
        # StreamHandler.__init__ assigns the stream; the property is the source
        # of truth, so discard it rather than shadowing the lookup above.
        pass


class StructuredFormatter(logging.Formatter):
    """Render a record as a single-line Cloud Logging structured payload."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "severity": _severity_for(record.levelno),
            "message": record.getMessage(),
            "logger": record.name,
            "logging.googleapis.com/sourceLocation": {
                "file": record.pathname,
                "line": str(record.lineno),
                "function": record.funcName,
            },
        }

        # Keep the traceback inside the message so the whole exception stays in
        # one log entry, and so Error Reporting can recognise it.
        if record.exc_info:
            payload["message"] += "\n" + self.formatException(record.exc_info)
        if record.stack_info:
            payload["message"] += "\n" + self.formatStack(record.stack_info)

        for key, value in record.__dict__.items():
            if key not in _RESERVED_RECORD_ATTRS and not key.startswith("_"):
                payload[key] = value

        # default=str keeps an unserialisable ``extra`` from raising inside the
        # handler, which would otherwise take down the caller.
        return json.dumps(payload, default=str, ensure_ascii=False)


def _use_json_format() -> bool:
    """JSON in-cluster, human-readable text elsewhere, LOG_FORMAT overrides both."""
    configured = (env_trim("LOG_FORMAT") or "").lower()
    if configured in {"json", "text"}:
        return configured == "json"
    return bool(env_trim("KUBERNETES_SERVICE_HOST"))


def _resolve_level() -> int:
    raw = (env_trim("LOG_LEVEL") or "INFO").upper()
    level = logging.getLevelName(raw)
    return level if isinstance(level, int) else logging.INFO


def configure_logging(*, force: bool = False) -> None:
    """Install the single root handler the process logs through.

    Idempotent: repeated calls are ignored so importing the app factory twice
    cannot stack duplicate handlers. Pass ``force=True`` to reconfigure.
    """
    global _configured
    if _configured and not force:
        return

    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)

    # stdout, not stderr: the GKE logging agent derives a default severity from
    # the stream, and only stdout leaves the explicit `severity` field to win.
    handler = StdoutHandler()
    handler.setFormatter(
        StructuredFormatter() if _use_json_format() else logging.Formatter(_TEXT_FORMAT)
    )
    root.addHandler(handler)
    root.setLevel(_resolve_level())

    # Uvicorn installs its own handlers and sets propagate=False, which would
    # keep its records out of the formatter above. Hand them back to the root.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True

    # Route warnings.warn() through logging so library warnings are formatted
    # and severity-tagged like everything else rather than landing raw on stderr.
    logging.captureWarnings(True)

    _configured = True


def reset_logging_for_tests() -> None:
    global _configured
    _configured = False

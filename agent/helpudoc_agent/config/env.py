"""Typed environment access for the agent process (os.environ)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple

if TYPE_CHECKING:  # `configuration` imports this module, so never import it at runtime.
    from ..configuration import ModelConfig

_LOCAL_DEV_NODE_ENVS = frozenset({"", "development", "test"})
_TRUTHY = frozenset({"1", "true", "yes", "y", "on"})


def env_trim(name: str, default: str | None = None) -> str | None:
    """Return stripped env value, or default if missing/blank."""
    value = os.getenv(name)
    if value is None:
        return default
    stripped = value.strip()
    return stripped if stripped else default


def env_bool(name: str, default: bool = False) -> bool:
    """Return a boolean env value (accepts 1/true/yes/y/on, case-insensitive)."""
    value = env_trim(name)
    return default if value is None else value.lower() in _TRUTHY


def is_local_dev_node_env() -> bool:
    return (env_trim("NODE_ENV") or "").lower() in _LOCAL_DEV_NODE_ENVS


@dataclass(frozen=True)
class AgentRuntimeEnv:
    node_env: str | None
    workspace_root_raw: str | None
    skills_root_raw: str | None
    plugins_root_raw: str | None
    gemini_api_key: str | None
    # None means "unset", which is distinct from an explicit false: only a var
    # that is actually present may override the runtime.yaml model block.
    google_genai_use_vertexai: bool | None
    google_cloud_project: str | None
    google_cloud_location: str | None


_runtime_cache: AgentRuntimeEnv | None = None


def load_agent_runtime_env() -> AgentRuntimeEnv:
    use_vertex_raw = env_trim("GOOGLE_GENAI_USE_VERTEXAI")
    return AgentRuntimeEnv(
        node_env=env_trim("NODE_ENV"),
        workspace_root_raw=env_trim("WORKSPACE_ROOT"),
        skills_root_raw=env_trim("SKILLS_ROOT"),
        plugins_root_raw=env_trim("PLUGINS_ROOT"),
        gemini_api_key=(
            env_trim("GEMINI_API_KEY")
            or env_trim("GOOGLE_API_KEY")
            or env_trim("GOOGLE_CLOUD_API_KEY")
        ),
        google_genai_use_vertexai=(
            None if use_vertex_raw is None else use_vertex_raw.lower() in _TRUTHY
        ),
        google_cloud_project=env_trim("GOOGLE_CLOUD_PROJECT"),
        google_cloud_location=env_trim("GOOGLE_CLOUD_LOCATION"),
    )


def get_agent_runtime_env() -> AgentRuntimeEnv:
    global _runtime_cache
    if _runtime_cache is None:
        _runtime_cache = load_agent_runtime_env()
    return _runtime_cache


def reset_agent_env_caches_for_tests() -> None:
    """Clear cached env reads (for tests that mutate os.environ)."""
    global _runtime_cache
    _runtime_cache = None


def _read_service_account_namespace() -> str | None:
    path = Path("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
    try:
        if path.is_file():
            return path.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None
    return None


@dataclass(frozen=True)
class SandboxK8sEnv:
    namespace: str
    image: str
    workspace_pvc: str
    runtime_class_name: str
    cpu_limit: str
    memory_limit: str
    ephemeral_storage_limit: str
    poll_interval_seconds: float
    allow_kubeconfig: bool


def load_sandbox_k8s_env() -> SandboxK8sEnv:
    namespace = (
        env_trim("HELPUDOC_SANDBOX_NAMESPACE")
        or env_trim("POD_NAMESPACE")
        or _read_service_account_namespace()
        or "helpudoc"
    )
    allow_raw = (os.getenv("HELPUDOC_SANDBOX_ALLOW_KUBECONFIG", "") or "").strip().lower()
    return SandboxK8sEnv(
        namespace=namespace,
        image=env_trim("HELPUDOC_SANDBOX_IMAGE") or "python:3.12-slim",
        workspace_pvc=env_trim("HELPUDOC_SANDBOX_WORKSPACE_PVC") or "workspace-pvc",
        # RuntimeClass is an optional hardening layer. An unconditional gVisor
        # default makes every sandbox job unschedulable on clusters whose node
        # pools do not provide the matching handler.
        runtime_class_name=env_trim("HELPUDOC_SANDBOX_RUNTIME_CLASS") or "",
        cpu_limit=env_trim("HELPUDOC_SANDBOX_CPU_LIMIT") or "500m",
        memory_limit=env_trim("HELPUDOC_SANDBOX_MEMORY_LIMIT") or "512Mi",
        ephemeral_storage_limit=env_trim("HELPUDOC_SANDBOX_EPHEMERAL_STORAGE_LIMIT") or "1Gi",
        poll_interval_seconds=max(
            0.25,
            float(env_trim("HELPUDOC_SANDBOX_POLL_INTERVAL_SECONDS") or "1"),
        ),
        allow_kubeconfig=allow_raw in {"1", "true", "yes"},
    )


class GoogleAuthMode(NamedTuple):
    """How a Gemini client should authenticate.

    `api_key` is None whenever `use_vertex` is true: Vertex authenticates through
    Application Default Credentials, and an AI Studio key is not a valid Vertex
    credential, so forwarding one alongside `vertexai=True` is always wrong.
    """

    use_vertex: bool
    api_key: str | None

    @property
    def configured(self) -> bool:
        """Whether a Gemini client can be built at all."""
        return self.use_vertex or bool(self.api_key)


def resolve_google_auth_mode(model_cfg: "ModelConfig") -> GoogleAuthMode:
    """Decide Vertex-vs-API-key once, for every Gemini client in the process.

    `use_vertex_ai` wins outright. It previously lost to any present API key,
    which made the flag inert in GKE because the manifests always inject
    GEMINI_API_KEY; the config asked for Vertex and silently got AI Studio.

    That guard was added in d1beb86 after Vertex broke in GKE, but the cause was
    a missing credential rather than the precedence: no service-account key was
    mounted, so ADC had nothing to bind to. The key is mounted now, so the flag
    can mean what it says.
    """
    configured_key = getattr(model_cfg, "api_key", None) or get_agent_runtime_env().gemini_api_key
    if getattr(model_cfg, "use_vertex_ai", False):
        return GoogleAuthMode(use_vertex=True, api_key=None)
    return GoogleAuthMode(use_vertex=False, api_key=configured_key)

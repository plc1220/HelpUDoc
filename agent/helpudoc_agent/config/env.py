"""Typed environment access for the agent process (os.environ)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_LOCAL_DEV_NODE_ENVS = frozenset({"", "development", "test"})


def env_trim(name: str, default: str | None = None) -> str | None:
    """Return stripped env value, or default if missing/blank."""
    value = os.getenv(name)
    if value is None:
        return default
    stripped = value.strip()
    return stripped if stripped else default


def is_local_dev_node_env() -> bool:
    return (env_trim("NODE_ENV") or "").lower() in _LOCAL_DEV_NODE_ENVS


@dataclass(frozen=True)
class AgentRuntimeEnv:
    node_env: str | None
    workspace_root_raw: str | None
    skills_root_raw: str | None
    gemini_api_key: str | None


_runtime_cache: AgentRuntimeEnv | None = None


def load_agent_runtime_env() -> AgentRuntimeEnv:
    return AgentRuntimeEnv(
        node_env=env_trim("NODE_ENV"),
        workspace_root_raw=env_trim("WORKSPACE_ROOT"),
        skills_root_raw=env_trim("SKILLS_ROOT"),
        gemini_api_key=(
            env_trim("GEMINI_API_KEY")
            or env_trim("GOOGLE_API_KEY")
            or env_trim("GOOGLE_CLOUD_API_KEY")
            or env_trim("LLM_BINDING_API_KEY")
        ),
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


def ensure_lightrag_postgres_env_defaults() -> None:
    """Set LightRAG + Postgres defaults expected by the HKU LightRAG stack."""
    os.environ.setdefault("LIGHTRAG_KV_STORAGE", "PGKVStorage")
    os.environ.setdefault("LIGHTRAG_DOC_STATUS_STORAGE", "PGDocStatusStorage")
    os.environ.setdefault("LIGHTRAG_GRAPH_STORAGE", "PGGraphStorage")
    os.environ.setdefault("LIGHTRAG_VECTOR_STORAGE", "PGVectorStorage")

    if "POSTGRES_DATABASE" not in os.environ and "POSTGRES_DB" in os.environ:
        os.environ["POSTGRES_DATABASE"] = os.environ["POSTGRES_DB"]

    os.environ.setdefault("POSTGRES_HOST", "localhost")
    os.environ.setdefault("POSTGRES_PORT", "5432")
    os.environ.setdefault("POSTGRES_USER", "helpudoc")
    os.environ.setdefault("POSTGRES_PASSWORD", "helpudoc")
    os.environ.setdefault("POSTGRES_DATABASE", "helpudoc")


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
        runtime_class_name=env_trim("HELPUDOC_SANDBOX_RUNTIME_CLASS") or "gvisor",
        cpu_limit=env_trim("HELPUDOC_SANDBOX_CPU_LIMIT") or "500m",
        memory_limit=env_trim("HELPUDOC_SANDBOX_MEMORY_LIMIT") or "512Mi",
        ephemeral_storage_limit=env_trim("HELPUDOC_SANDBOX_EPHEMERAL_STORAGE_LIMIT") or "1Gi",
        poll_interval_seconds=max(
            0.25,
            float(env_trim("HELPUDOC_SANDBOX_POLL_INTERVAL_SECONDS") or "1"),
        ),
        allow_kubeconfig=allow_raw in {"1", "true", "yes"},
    )


def gemini_key_for_embeddings(explicit: str | None) -> str | None:
    """Resolve Gemini API key for embedding calls (explicit arg wins)."""
    return (
        explicit
        or env_trim("GEMINI_API_KEY")
        or env_trim("GOOGLE_API_KEY")
        or env_trim("GOOGLE_CLOUD_API_KEY")
        or env_trim("LLM_BINDING_API_KEY")
    )

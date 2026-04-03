"""Configuration loading utilities for the agent service."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from pydantic import BaseModel, Field, validator, root_validator


PACKAGE_ROOT = Path(__file__).resolve().parent
AGENT_ROOT = PACKAGE_ROOT.parent
REPO_ROOT = AGENT_ROOT.parent
DEFAULT_CONFIG_PATH = AGENT_ROOT / "config" / "runtime.yaml"


class ModelConfig(BaseModel):
    provider: str = Field(default="gemini")
    name: str = Field(default="gemini-3-flash-preview")
    fast_name: Optional[str] = None
    lite_name: Optional[str] = None
    pro_name: Optional[str] = None
    image_name: Optional[str] = None
    project: Optional[str] = None
    location: Optional[str] = None
    api_key: Optional[str] = Field(default_factory=lambda: os.getenv("GEMINI_API_KEY"))
    use_vertex_ai: bool = Field(default=False)

    @property
    def chat_model_name(self) -> str:
        """Return the canonical chat model identifier."""
        return self.name

    def resolve_chat_model_name(self, mode: Optional[str]) -> str:
        """Resolve a chat model name for the requested mode."""
        if not mode:
            return self.name
        normalized = mode.strip().lower()
        if normalized == "lite":
            return self.lite_name or self.fast_name or self.name
        if normalized == "pro":
            return self.pro_name or self.name
        if normalized == "fast":
            return self.fast_name or self.name
        return self.name

    @property
    def image_model_name(self) -> str:
        """Return the canonical image model identifier (falls back to chat model)."""
        return self.image_name or self.name


class BackendConfig(BaseModel):
    workspace_root: Path
    virtual_mode: bool = Field(default=True)
    skills_root: Optional[Path] = None
    sync_skills_to_workspace: bool = Field(default=False)
    interrupt_on: Dict[str, Any] = Field(
        default_factory=lambda: {
            "request_plan_approval": {
                "allowed_decisions": ["approve", "edit", "reject"],
            },
            "write_file": True,
            "read_file": False,
            "edit_file": True,
        }
    )

    @validator("workspace_root", pre=True)
    def _resolve_workspace(cls, value: str | Path) -> Path:
        if isinstance(value, Path):
            return value.resolve()
        path = Path(value)
        if not path.is_absolute():
            path = REPO_ROOT / value
        return path.resolve()

    @validator("skills_root", pre=True)
    def _resolve_skills_root(cls, value: str | Path | None) -> Optional[Path]:
        if value is None:
            return (REPO_ROOT / "skills").resolve()
        if isinstance(value, Path):
            return value.resolve()
        path = Path(value)
        if not path.is_absolute():
            path = REPO_ROOT / value
        return path.resolve()


class MCPServerConfig(BaseModel):
    name: str
    transport: str  # "stdio" | "http" | "sse"

    # Back-compat (older configs used "endpoint" for remote servers).
    endpoint: Optional[str] = None

    # STDIO transport
    command: Optional[str] = None
    args: Optional[List[str]] = None
    description: Optional[str] = None
    env: Dict[str, str] = Field(default_factory=dict)
    env_passthrough: Optional[List[str]] = None
    cwd: Optional[str] = None

    # HTTP/SSE transport
    url: Optional[str] = None
    headers: Dict[str, str] = Field(default_factory=dict)
    headers_from_env: Dict[str, str] = Field(default_factory=dict)
    bearer_token_env_var: Optional[str] = None
    delegated_auth_provider: Optional[str] = None

    # RBAC metadata
    default_access: str = Field(default="allow")  # "allow" | "deny"

    @root_validator(pre=True)
    def _normalize_legacy_and_camelcase_keys(cls, values: dict) -> dict:
        """Accept both YAML styles (snake_case and camelCase) from the admin UI."""
        if not isinstance(values, dict):
            return values

        # Legacy/alternate keys from the frontend YAML editor.
        mapping = {
            "envPassthrough": "env_passthrough",
            "headersFromEnv": "headers_from_env",
            "bearerTokenEnvVar": "bearer_token_env_var",
            "delegatedAuthProvider": "delegated_auth_provider",
            "defaultAccess": "default_access",
        }
        for src, dst in mapping.items():
            if src in values and dst not in values:
                values[dst] = values.pop(src)

        # Legacy remote config key.
        if "endpoint" in values and "url" not in values:
            values["url"] = values.get("endpoint")

        return values

    @validator("default_access")
    def _validate_default_access(cls, value: str) -> str:
        normalized = (value or "").strip().lower()
        if normalized not in {"allow", "deny"}:
            raise ValueError("default_access must be 'allow' or 'deny'")
        return normalized

    @validator("transport")
    def _validate_transport(cls, value: str) -> str:
        normalized = (value or "").strip().lower()
        if normalized not in {"stdio", "http", "sse"}:
            raise ValueError("transport must be 'stdio', 'http', or 'sse'")
        return normalized

    @validator("delegated_auth_provider")
    def _validate_delegated_auth_provider(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip().lower()
        if not normalized:
            return None
        if normalized not in {"google"}:
            raise ValueError("delegated_auth_provider must be 'google'")
        return normalized


class ToolConfig(BaseModel):
    name: str
    kind: str = Field(default="builtin")
    entrypoint: Optional[str] = None
    description: Optional[str] = None
    mcp_server: Optional[str] = None


class Settings(BaseModel):
    model: ModelConfig
    backend: BackendConfig
    tools: Dict[str, ToolConfig]
    mcp_servers: Dict[str, MCPServerConfig] = Field(default_factory=dict)

    def get_tool(self, name: str) -> ToolConfig:
        try:
            return self.tools[name]
        except KeyError as exc:  # pragma: no cover - defensive
            raise ValueError(f"Unknown tool '{name}'") from exc


def _load_yaml(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        loaded = yaml.safe_load(handle)
    return loaded if isinstance(loaded, dict) else {}


def _merge_named_entries(base_entries: Any, override_entries: Any) -> List[dict]:
    merged: Dict[str, dict] = {}
    for source in (base_entries, override_entries):
        if not isinstance(source, list):
            continue
        for entry in source:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            prior = merged.get(name, {})
            merged[name] = {**prior, **entry}
    return list(merged.values())


def _merge_runtime_config(base_config: dict, override_config: dict) -> dict:
    merged = {**base_config, **override_config}
    merged_tools = _merge_named_entries(base_config.get("tools"), override_config.get("tools"))
    merged_mcp_servers = _merge_named_entries(base_config.get("mcp_servers"), override_config.get("mcp_servers"))
    if merged_tools:
        merged["tools"] = merged_tools
    if merged_mcp_servers:
        merged["mcp_servers"] = merged_mcp_servers
    return merged


def _expand_env_vars(data):
    if isinstance(data, dict):
        return {key: _expand_env_vars(value) for key, value in data.items()}
    if isinstance(data, list):
        return [_expand_env_vars(item) for item in data]
    if isinstance(data, str):
        return os.path.expandvars(data)
    return data


def _resolve_env_override_path(value: str, *, base_dir: Path) -> str:
    raw = (value or "").strip()
    if not raw:
        return raw
    path = Path(raw)
    if path.is_absolute():
        return str(path)
    return str((base_dir / path).resolve())


def load_settings(config_path: Path | None = None) -> Settings:
    path = config_path or DEFAULT_CONFIG_PATH
    base_config = _load_yaml(DEFAULT_CONFIG_PATH) if path != DEFAULT_CONFIG_PATH else {}
    config_dict = _load_yaml(path)
    if base_config:
        config_dict = _merge_runtime_config(base_config, config_dict)
    config_dict = _expand_env_vars(config_dict)
    override_base_dir = AGENT_ROOT

    # Allow runtime override for shared workspace volume paths (e.g., Docker Compose).
    workspace_root_override = os.getenv("WORKSPACE_ROOT")
    skills_root_override = os.getenv("SKILLS_ROOT")
    if workspace_root_override:
        backend_cfg = config_dict.get("backend") or {}
        if isinstance(backend_cfg, dict):
            backend_cfg["workspace_root"] = _resolve_env_override_path(
                workspace_root_override,
                base_dir=override_base_dir,
            )
            config_dict["backend"] = backend_cfg
    if skills_root_override:
        backend_cfg = config_dict.get("backend") or {}
        if isinstance(backend_cfg, dict):
            backend_cfg["skills_root"] = _resolve_env_override_path(
                skills_root_override,
                base_dir=override_base_dir,
            )
            config_dict["backend"] = backend_cfg

    payload = {
        "model": config_dict.get("model", {}),
        "backend": config_dict.get("backend", {}),
        "tools": {tool["name"]: tool for tool in config_dict.get("tools", [])},
        "mcp_servers": {srv["name"]: srv for srv in config_dict.get("mcp_servers", [])},
    }
    try:
        return Settings.model_validate(payload)  # type: ignore[attr-defined]
    except AttributeError:  # pragma: no cover - pydantic v1 fallback
        return Settings.parse_obj(payload)  # type: ignore[call-arg]

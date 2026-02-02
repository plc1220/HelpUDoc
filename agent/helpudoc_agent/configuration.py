"""Configuration loading utilities for the agent service."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, Optional

import yaml
from pydantic import BaseModel, Field, validator


PACKAGE_ROOT = Path(__file__).resolve().parent
AGENT_ROOT = PACKAGE_ROOT.parent
REPO_ROOT = AGENT_ROOT.parent
DEFAULT_CONFIG_PATH = AGENT_ROOT / "config" / "runtime.yaml"


class ModelConfig(BaseModel):
    provider: str = Field(default="gemini")
    name: str = Field(default="gemini-3-flash-preview")
    fast_name: Optional[str] = None
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
    interrupt_on: Dict[str, bool] = Field(
        default_factory=lambda: {
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
    transport: str
    endpoint: Optional[str] = None
    command: Optional[str] = None
    description: Optional[str] = None
    env: Dict[str, str] = Field(default_factory=dict)


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
        return yaml.safe_load(handle)


def _expand_env_vars(data):
    if isinstance(data, dict):
        return {key: _expand_env_vars(value) for key, value in data.items()}
    if isinstance(data, list):
        return [_expand_env_vars(item) for item in data]
    if isinstance(data, str):
        return os.path.expandvars(data)
    return data


def load_settings(config_path: Path | None = None) -> Settings:
    path = config_path or DEFAULT_CONFIG_PATH
    config_dict = _expand_env_vars(_load_yaml(path))

    # Allow runtime override for shared workspace volume paths (e.g., Docker Compose).
    workspace_root_override = os.getenv("WORKSPACE_ROOT")
    if workspace_root_override:
        backend_cfg = config_dict.get("backend") or {}
        if isinstance(backend_cfg, dict):
            backend_cfg["workspace_root"] = workspace_root_override
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

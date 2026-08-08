"""office-service configuration via environment variables."""

from pydantic import Field
from pydantic_settings import BaseSettings


class ServiceConfig(BaseSettings):
    """Configuration for the office-service sidecar."""

    port: int = Field(default=8002, ge=1, le=65535)
    workspace_root: str = Field(default="/app/workspaces", min_length=1)

    # OfficeCLI binary path (pinned in Dockerfile)
    officecli_bin: str = Field(default="/usr/local/bin/officecli", min_length=1)

    # Subprocess limits
    timeout_seconds: int = Field(default=60, gt=0)
    max_concurrent: int = Field(default=4, gt=0)
    max_operations: int = Field(default=50, gt=0)
    max_request_bytes: int = Field(default=2 * 1024 * 1024, gt=0)  # 2 MiB
    max_stdout_bytes: int = Field(default=10 * 1024 * 1024, gt=0)  # 10 MiB
    max_stderr_bytes: int = Field(default=256 * 1024, gt=0)  # 256 KiB

    model_config = {"env_prefix": "OFFICE_SERVICE_"}

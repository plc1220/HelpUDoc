"""Configuration for direct OfficeCLI execution in the agent process."""

from pydantic import Field
from pydantic_settings import BaseSettings


class OfficeRunnerConfig(BaseSettings):
    """Bounded subprocess configuration for the model-facing Office tool."""

    # OfficeCLI binary path (pinned in Dockerfile)
    officecli_bin: str = Field(default="/usr/local/bin/officecli", min_length=1)

    # Subprocess limits
    timeout_seconds: int = Field(default=60, gt=0)
    max_operations: int = Field(default=50, gt=0)
    max_request_bytes: int = Field(default=2 * 1024 * 1024, gt=0)  # 2 MiB
    max_stdout_bytes: int = Field(default=10 * 1024 * 1024, gt=0)  # 10 MiB
    max_stderr_bytes: int = Field(default=256 * 1024, gt=0)  # 256 KiB

    expected_version: str = Field(default="1.0.143", min_length=1)
    expected_sha256_amd64: str = Field(
        default="6a29c598a789b57c92c03e560907d3f131a4bd0a068785b1d338a86fc31a58a7",
        min_length=64,
        max_length=64,
    )
    expected_sha256_arm64: str = Field(
        default="c50298e4698fcd1b15fe1a0f096405ad260b5c84d4440882582d0bba1e57bd49",
        min_length=64,
        max_length=64,
    )

    model_config = {"env_prefix": "HELPUDOC_OFFICECLI_"}

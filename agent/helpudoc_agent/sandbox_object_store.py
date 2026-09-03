"""Run-scoped object-store transport for Kubernetes inline sandboxes."""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path, PurePosixPath
from typing import Any


class SandboxObjectStoreError(RuntimeError):
    """Raised when the inline sandbox object transport is unavailable."""


def _env(name: str, default: str | None = None) -> str | None:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip()
    return value if value else default


def _safe_key_segment(raw: str, label: str) -> str:
    value = str(raw or "").strip()
    if not value or value in {".", ".."} or "/" in value or "\\" in value:
        raise SandboxObjectStoreError(f"{label} must be a safe object-key segment")
    return value


@dataclass(frozen=True)
class SandboxObjectStoreConfig:
    endpoint: str
    bucket: str
    region: str
    force_path_style: bool
    presign_expiry_seconds: int

    @classmethod
    def from_env(cls) -> "SandboxObjectStoreConfig":
        endpoint = (
            _env("HELPUDOC_SANDBOX_S3_ENDPOINT")
            or _env("S3_ENDPOINT")
            or _env("MINIO_ENDPOINT")
            or ""
        )
        bucket = _env("S3_BUCKET_NAME") or ""
        if not endpoint:
            raise SandboxObjectStoreError(
                "HELPUDOC_SANDBOX_S3_ENDPOINT or S3_ENDPOINT is required for object-store transport"
            )
        if not bucket:
            raise SandboxObjectStoreError(
                "S3_BUCKET_NAME is required for object-store transport"
            )
        try:
            expiry = int(_env("HELPUDOC_SANDBOX_PRESIGN_EXPIRY_SECONDS", "600") or "600")
        except ValueError as exc:
            raise SandboxObjectStoreError(
                "HELPUDOC_SANDBOX_PRESIGN_EXPIRY_SECONDS must be an integer"
            ) from exc
        if expiry < 60 or expiry > 3600:
            raise SandboxObjectStoreError(
                "HELPUDOC_SANDBOX_PRESIGN_EXPIRY_SECONDS must be between 60 and 3600"
            )
        force_path = (_env("S3_FORCE_PATH_STYLE", "true") or "true").lower()
        return cls(
            endpoint=endpoint,
            bucket=bucket,
            region=_env("AWS_REGION", "us-east-1") or "us-east-1",
            force_path_style=force_path in {"1", "true", "yes", "on"},
            presign_expiry_seconds=expiry,
        )


class SandboxObjectStore:
    """Minimal S3 adapter; credentials remain in the trusted agent process."""

    def __init__(
        self,
        config: SandboxObjectStoreConfig | None = None,
        *,
        client: Any | None = None,
    ) -> None:
        self.config = config or SandboxObjectStoreConfig.from_env()
        if client is None:
            try:
                import boto3
                from botocore.config import Config
            except ImportError as exc:  # pragma: no cover - deployment dependency guard
                raise SandboxObjectStoreError(
                    "boto3 is required for inline sandbox object-store transport"
                ) from exc
            addressing_style = "path" if self.config.force_path_style else "auto"
            client = boto3.client(
                "s3",
                endpoint_url=self.config.endpoint,
                region_name=self.config.region,
                config=Config(
                    signature_version="s3v4",
                    s3={"addressing_style": addressing_style},
                ),
            )
        self.client = client

    def run_keys(self, workspace_id: str, run_id: str) -> tuple[str, str]:
        safe_workspace = _safe_key_segment(workspace_id, "workspace_id")
        safe_run = _safe_key_segment(run_id, "run_id")
        prefix = PurePosixPath("sandbox-runs", safe_workspace, safe_run)
        return (str(prefix / "input.tar"), str(prefix / "result.tar"))

    def upload(self, source: Path, key: str) -> None:
        try:
            self.client.upload_file(str(source), self.config.bucket, key)
        except Exception as exc:
            raise SandboxObjectStoreError(f"Unable to upload sandbox object {key}: {exc}") from exc

    def download(self, key: str, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.client.download_file(self.config.bucket, key, str(destination))
        except Exception as exc:
            raise SandboxObjectStoreError(f"Unable to download sandbox object {key}: {exc}") from exc

    def presign_download(self, key: str) -> str:
        try:
            return str(
                self.client.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": self.config.bucket, "Key": key},
                    ExpiresIn=self.config.presign_expiry_seconds,
                )
            )
        except Exception as exc:
            raise SandboxObjectStoreError(
                f"Unable to sign sandbox download {key}: {exc}"
            ) from exc

    def presign_upload(self, key: str) -> str:
        try:
            return str(
                self.client.generate_presigned_url(
                    "put_object",
                    Params={"Bucket": self.config.bucket, "Key": key},
                    ExpiresIn=self.config.presign_expiry_seconds,
                )
            )
        except Exception as exc:
            raise SandboxObjectStoreError(
                f"Unable to sign sandbox upload {key}: {exc}"
            ) from exc

    def delete(self, key: str) -> None:
        try:
            self.client.delete_object(Bucket=self.config.bucket, Key=key)
        except Exception as exc:
            raise SandboxObjectStoreError(f"Unable to delete sandbox object {key}: {exc}") from exc

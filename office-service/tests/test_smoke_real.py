"""Smoke tests using the real OfficeCLI binary.

These tests only run when OFFICECLI_BIN points to an executable.
In CI without the binary, they are skipped.

Run locally: OFFICECLI_BIN=/path/to/officecli pytest tests/test_smoke_real.py -v
"""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _real_binary_available() -> bool:
    bin_path = os.environ.get("OFFICECLI_BIN", "")
    return bool(bin_path) and os.path.isfile(bin_path) and os.access(bin_path, os.X_OK)


pytestmark = pytest.mark.skipif(
    not _real_binary_available(),
    reason="OFFICECLI_BIN not set or not executable (skipped in CI)",
)


@pytest.fixture
def real_app_client(workspace_root):
    """Create a test client pointing to the real OfficeCLI binary."""
    import executor

    executor.reset_caches()
    real_bin = os.environ["OFFICECLI_BIN"]
    os.environ["OFFICE_SERVICE_OFFICECLI_BIN"] = real_bin

    import app as app_mod
    from config import ServiceConfig

    app_mod.config = ServiceConfig()

    from fastapi.testclient import TestClient

    with TestClient(app_mod.app) as client:
        yield client

    os.environ.pop("OFFICE_SERVICE_OFFICECLI_BIN", None)


class TestRealBinarySmoke:
    def test_healthz_real_version(self, real_app_client):
        resp = real_app_client.get("/healthz")
        assert resp.status_code == 200
        data = resp.json()
        assert data["officecli_version"] == "1.0.143"
        assert len(data["binary_sha256"]) == 64

    def test_create_and_add(self, real_app_client, workspace_dir, workspace_root):
        resp = real_app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "output_path": "real-test.docx",
                "operations": [
                    {"command": "add", "parent": "/body", "type": "paragraph", "props": {"text": "Hello from smoke test"}},
                    {"command": "get", "path": "/body/p[1]"},
                ],
                "create_if_missing": True,
                "validate": True,
            },
        )
        assert resp.status_code == 200, f"Response: {resp.json()}"
        data = resp.json()
        assert data["success"] is True
        assert data["summary"]["succeeded"] == 2
        assert data["validation"]["success"] is True
        assert (workspace_root / "test-workspace" / "real-test.docx").exists()

    def test_batch_atomic_failure_no_publish(self, real_app_client, workspace_dir, workspace_root):
        resp = real_app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "output_path": "should-not-exist.docx",
                "operations": [
                    {"command": "add", "parent": "/body", "type": "paragraph", "props": {"text": "OK"}},
                    {"command": "remove", "path": "/body/p[999]"},
                ],
                "create_if_missing": True,
                "validate": False,
            },
        )
        data = resp.json()
        assert data["success"] is False
        assert not (workspace_root / "test-workspace" / "should-not-exist.docx").exists()

    def test_best_effort_publishes_only_a_contract_valid_partial_result(
        self, real_app_client, workspace_dir, workspace_root
    ):
        resp = real_app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "output_path": "best-effort.docx",
                "operations": [
                    {
                        "command": "add",
                        "parent": "/body",
                        "type": "paragraph",
                        "props": {"text": "Keep this successful operation"},
                    },
                    {"command": "remove", "path": "/body/p[999]"},
                ],
                "create_if_missing": True,
                "validate": True,
                "best_effort": True,
            },
        )
        assert resp.status_code == 200, f"Response: {resp.json()}"
        data = resp.json()
        assert data["success"] is False
        assert data["published"] is True
        assert data["summary"]["failed"] == 1
        assert data["validation"]["success"] is True
        assert (workspace_root / "test-workspace" / "best-effort.docx").exists()

    def test_validate_gates_publication(self, real_app_client, workspace_dir, workspace_root):
        resp = real_app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "output_path": "validated.docx",
                "operations": [
                    {"command": "add", "parent": "/body", "type": "paragraph", "props": {"text": "Valid"}},
                ],
                "create_if_missing": True,
                "validate": True,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["validation"]["success"] is True
        assert (workspace_root / "test-workspace" / "validated.docx").exists()

    def test_in_place_update(self, real_app_client, workspace_dir, workspace_root):
        # Create
        real_app_client.post("/v1/execute", json={
            "workspace_id": "test-workspace",
            "output_path": "inplace.docx",
            "operations": [{"command": "add", "parent": "/body", "type": "paragraph", "props": {"text": "Original"}}],
            "create_if_missing": True,
            "validate": False,
        })
        # Update
        resp = real_app_client.post("/v1/execute", json={
            "workspace_id": "test-workspace",
            "output_path": "inplace.docx",
            "operations": [
                {"command": "add", "parent": "/body", "type": "paragraph", "props": {"text": "Added"}},
                {"command": "get", "path": "/body"},
            ],
            "validate": False,
        })
        assert resp.status_code == 200
        assert resp.json()["success"] is True

    def test_large_batch_reads_officecli_spill_file(
        self, real_app_client, workspace_dir, workspace_root
    ):
        operations = [
            {
                "command": "add",
                "parent": "/body",
                "type": "paragraph",
                "props": {"text": f"{i}:" + ("spill-check-" * 60)},
            }
            for i in range(20)
        ]
        operations.append({"command": "get", "path": "/body"})

        resp = real_app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "output_path": "spill-test.docx",
                "operations": operations,
                "create_if_missing": True,
                "validate": False,
            },
        )
        assert resp.status_code == 200, f"Response: {resp.json()}"
        data = resp.json()
        assert data["success"] is True
        assert data["published"] is True
        assert data["summary"]["total"] == len(operations)
        assert (workspace_root / "test-workspace" / "spill-test.docx").exists()

    def test_batch_rc2_warning_is_preserved(
        self, real_app_client, workspace_dir, workspace_root
    ):
        resp = real_app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "output_path": "warning-test.docx",
                "operations": [
                    {
                        "command": "add",
                        "parent": "/body",
                        "type": "equation",
                        "props": {"formula": r"\notacommand{x}"},
                    }
                ],
                "create_if_missing": True,
                "validate": True,
            },
        )
        assert resp.status_code == 200, f"Response: {resp.json()}"
        data = resp.json()
        assert data["success"] is True
        assert data["published"] is True
        assert any("unrecognized_latex_command" in warning for warning in data["warnings"])
        assert (workspace_root / "test-workspace" / "warning-test.docx").exists()

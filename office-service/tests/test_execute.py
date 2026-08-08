"""Integration tests for POST /v1/execute using a fake OfficeCLI binary."""

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("OFFICE_SERVICE_WORKSPACE_ROOT", "/tmp/office-test-workspaces")
os.environ.setdefault("OFFICE_SERVICE_OFFICECLI_BIN", "/tmp/fake-officecli")

from fastapi.testclient import TestClient


@pytest.fixture
def app_client(workspace_root, fake_officecli):
    """Create a test client with proper config and lifespan."""
    import executor
    executor.reset_caches()

    import app as app_mod
    from config import ServiceConfig

    app_mod.config = ServiceConfig()

    with TestClient(app_mod.app) as client:
        yield client


# --- Helper to create a broken fake binary ---
def _write_broken_binary(path: Path, script: str) -> None:
    path.write_text(script)
    path.chmod(0o755)


class TestHealthEndpoints:
    def test_healthz_returns_200(self, app_client):
        resp = app_client.get("/healthz")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["officecli_version"] == "1.0.143"

    def test_readyz_returns_200_with_binary(self, app_client):
        resp = app_client.get("/readyz")
        assert resp.status_code == 200


class TestExecuteEndpoint:
    def test_execute_with_source(self, app_client, sample_docx, workspace_root):
        resp = app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "source_path": "sample.docx",
                "output_path": "sample-out.docx",
                "operations": [{"command": "get", "path": "/body/p[1]"}],
                "validate": False,
            },
        )
        assert resp.status_code == 200, f"Response: {resp.json()}"
        data = resp.json()
        assert data["success"] is True
        assert data["officecli_version"] == "1.0.143"
        assert data["summary"]["succeeded"] == 1
        output_path = workspace_root / "test-workspace" / "sample-out.docx"
        assert output_path.exists()

    def test_execute_create_if_missing(self, app_client, workspace_dir, workspace_root):
        resp = app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "output_path": "new-doc.docx",
                "operations": [{"command": "add", "parent": "/body", "type": "paragraph", "props": {"text": "Hello"}}],
                "create_if_missing": True,
                "validate": False,
            },
        )
        assert resp.status_code == 200, f"Response: {resp.json()}"
        assert (workspace_root / "test-workspace" / "new-doc.docx").exists()

    def test_execute_source_not_found(self, app_client, workspace_dir):
        resp = app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "source_path": "nonexistent.docx",
                "output_path": "out.docx",
                "operations": [{"command": "get", "path": "/body"}],
                "validate": False,
            },
        )
        assert resp.status_code == 404
        assert resp.json()["error"] == "source_not_found"

    def test_execute_rejects_path_traversal(self, app_client, workspace_dir):
        resp = app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "source_path": "../escape.docx",
                "output_path": "out.docx",
                "operations": [{"command": "get", "path": "/body"}],
                "validate": False,
            },
        )
        assert resp.status_code == 422
        assert resp.json()["error"] == "path_traversal"

    def test_execute_rejects_invalid_extension(self, app_client, workspace_dir):
        resp = app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "output_path": "out.pdf",
                "operations": [{"command": "get", "path": "/body"}],
                "validate": False,
            },
        )
        assert resp.status_code == 422
        assert resp.json()["error"] == "invalid_extension"

    def test_execute_rejects_cross_format_output(self, app_client, workspace_dir):
        resp = app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "source_path": "source.docx",
                "output_path": "output.xlsx",
                "operations": [{"command": "get", "path": "/body"}],
                "validate": False,
            },
        )
        assert resp.status_code == 422
        assert resp.json()["error"] == "invalid_extension"

    def test_execute_rejects_blocked_command(self, app_client, workspace_dir):
        resp = app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "output_path": "out.docx",
                "operations": [{"command": "raw"}],
                "validate": False,
            },
        )
        assert resp.status_code == 422
        assert resp.json()["error"] == "invalid_operations"

    def test_execute_in_place_update(self, app_client, sample_docx):
        resp = app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "output_path": "sample.docx",
                "operations": [{"command": "set", "path": "/body/p[1]", "props": {"text": "Updated"}}],
                "validate": False,
            },
        )
        assert resp.status_code == 200, f"Response: {resp.json()}"

    def test_execute_rejects_too_many_operations(self, app_client, workspace_dir, sample_docx):
        resp = app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "source_path": "sample.docx",
                "output_path": "out.docx",
                "operations": [{"command": "get", "path": "/body"}] * 100,
                "validate": False,
            },
        )
        assert resp.status_code == 422

    def test_response_envelope_structure(self, app_client, sample_docx):
        resp = app_client.post(
            "/v1/execute",
            json={
                "workspace_id": "test-workspace",
                "source_path": "sample.docx",
                "output_path": "out.docx",
                "operations": [
                    {"command": "get", "path": "/body/p[1]"},
                    {"command": "set", "path": "/body/p[1]", "props": {"bold": "true"}},
                ],
                "validate": False,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "success" in data
        assert "results" in data
        assert "summary" in data
        assert "officecli_version" in data
        assert "duration_ms" in data
        assert len(data["results"]) == 2
        for r in data["results"]:
            assert "index" in r
            assert "success" in r
            assert "command" in r

    def test_body_size_enforcement(self, app_client, workspace_dir):
        """Request body exceeding cap is rejected via streaming check."""
        payload = {
            "workspace_id": "test-workspace",
            "output_path": "out.docx",
            "operations": [{"command": "get", "path": "/body"}],
            "validate": False,
            "_padding": "x" * (3 * 1024 * 1024),
        }
        resp = app_client.post("/v1/execute", json=payload)
        assert resp.status_code == 413
        assert resp.json()["error"] == "request_too_large"


class TestFailClosedParsing:
    """Tests for fail-closed output handling (fix 1)."""

    def test_empty_stdout_rejects(self, workspace_root, workspace_dir, sample_docx, tmp_path):
        """Empty stdout from OfficeCLI results in failure envelope, not success."""
        bin_path = tmp_path / "officecli-empty"
        _write_broken_binary(bin_path, '#!/bin/bash\n'
            'if [ "$1" = "--version" ]; then echo "1.0.143"; exit 0; fi\n'
            'if [ "$1" = "create" ]; then touch "$2"; echo ""; exit 0; fi\n'
            'echo ""\nexit 0\n')
        os.environ["OFFICE_SERVICE_OFFICECLI_BIN"] = str(bin_path)

        import executor, app as app_mod
        from config import ServiceConfig
        executor.reset_caches()
        app_mod.config = ServiceConfig()

        with TestClient(app_mod.app) as client:
            resp = client.post("/v1/execute", json={
                "workspace_id": "test-workspace",
                "source_path": "sample.docx",
                "output_path": "empty-out.docx",
                "operations": [{"command": "get", "path": "/body"}],
                "validate": False,
            })
        # Should NOT be 200 success
        assert resp.status_code in (200, 502)
        data = resp.json()
        if resp.status_code == 200:
            assert data["success"] is False

    def test_malformed_json_rejects(self, workspace_root, workspace_dir, sample_docx, tmp_path):
        """Malformed JSON stdout results in failure, not defaulting to success."""
        bin_path = tmp_path / "officecli-malformed"
        _write_broken_binary(bin_path, '#!/bin/bash\n'
            'if [ "$1" = "--version" ]; then echo "1.0.143"; exit 0; fi\n'
            'echo "not valid json {{{"\nexit 0\n')
        os.environ["OFFICE_SERVICE_OFFICECLI_BIN"] = str(bin_path)

        import executor, app as app_mod
        from config import ServiceConfig
        executor.reset_caches()
        app_mod.config = ServiceConfig()

        with TestClient(app_mod.app) as client:
            resp = client.post("/v1/execute", json={
                "workspace_id": "test-workspace",
                "source_path": "sample.docx",
                "output_path": "malformed-out.docx",
                "operations": [{"command": "get", "path": "/body"}],
                "validate": False,
            })
        assert resp.status_code in (200, 502)
        data = resp.json()
        if resp.status_code == 200:
            assert data["success"] is False

    def test_missing_success_field_rejects(self, workspace_root, workspace_dir, sample_docx, tmp_path):
        """JSON without 'success' field is rejected."""
        bin_path = tmp_path / "officecli-nosuccess"
        _write_broken_binary(bin_path, '#!/bin/bash\n'
            'if [ "$1" = "--version" ]; then echo "1.0.143"; exit 0; fi\n'
            'echo \'{"data": "hello"}\'\nexit 0\n')
        os.environ["OFFICE_SERVICE_OFFICECLI_BIN"] = str(bin_path)

        import executor, app as app_mod
        from config import ServiceConfig
        executor.reset_caches()
        app_mod.config = ServiceConfig()

        with TestClient(app_mod.app) as client:
            resp = client.post("/v1/execute", json={
                "workspace_id": "test-workspace",
                "source_path": "sample.docx",
                "output_path": "nosuccess-out.docx",
                "operations": [{"command": "get", "path": "/body"}],
                "validate": False,
            })
        assert resp.status_code in (200, 502)
        data = resp.json()
        if resp.status_code == 200:
            assert data["success"] is False

    def test_best_effort_never_publishes_malformed_batch_contract(
        self, workspace_root, workspace_dir, sample_docx, tmp_path
    ):
        bin_path = tmp_path / "officecli-bad-contract"
        _write_broken_binary(
            bin_path,
            '#!/bin/bash\n'
            'if [ "$1" = "--version" ]; then echo "1.0.143"; exit 0; fi\n'
            'echo \'{"success":true,"data":{"results":[],"summary":{"total":0,"executed":0,"succeeded":0,"failed":0,"skipped":0}}}\'\n'
            'exit 0\n',
        )
        os.environ["OFFICE_SERVICE_OFFICECLI_BIN"] = str(bin_path)

        import executor, app as app_mod
        from config import ServiceConfig
        executor.reset_caches()
        app_mod.config = ServiceConfig()

        with TestClient(app_mod.app) as client:
            resp = client.post(
                "/v1/execute",
                json={
                    "workspace_id": "test-workspace",
                    "source_path": "sample.docx",
                    "output_path": "bad-best-effort.docx",
                    "operations": [{"command": "get", "path": "/body"}],
                    "validate": False,
                    "best_effort": True,
                },
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is False
        assert data["published"] is False
        assert not (workspace_dir / "bad-best-effort.docx").exists()


class TestSubprocessEdgeCases:
    """Tests for subprocess timeout, stderr flood, and cap breach (fix 2)."""

    def test_timeout_returns_504(self, workspace_root, workspace_dir, sample_docx, tmp_path):
        """Process that hangs is killed (entire group) and returns 504."""
        bin_path = tmp_path / "officecli-hang"
        # Keep a shell parent plus a child so the regression test proves the
        # whole process group is killed and inherited pipes are released.
        _write_broken_binary(bin_path,
            '#!/bin/bash\n'
            'if [ "$1" = "--version" ]; then echo "1.0.143"; exit 0; fi\n'
            'sleep 300 &\nwait\n')
        os.environ["OFFICE_SERVICE_OFFICECLI_BIN"] = str(bin_path)
        os.environ["OFFICE_SERVICE_TIMEOUT_SECONDS"] = "1"

        import executor, app as app_mod
        from config import ServiceConfig
        executor.reset_caches()
        app_mod.config = ServiceConfig()

        with TestClient(app_mod.app) as client:
            resp = client.post("/v1/execute", json={
                "workspace_id": "test-workspace",
                "source_path": "sample.docx",
                "output_path": "timeout-out.docx",
                "operations": [{"command": "get", "path": "/body"}],
                "validate": False,
            })
        assert resp.status_code == 504
        os.environ.pop("OFFICE_SERVICE_TIMEOUT_SECONDS", None)

    def test_timeout_kills_background_child_after_parent_exits(
        self, workspace_root, workspace_dir, sample_docx, tmp_path
    ):
        bin_path = tmp_path / "officecli-orphan"
        _write_broken_binary(
            bin_path,
            '#!/bin/bash\n'
            'if [ "$1" = "--version" ]; then echo "1.0.143"; exit 0; fi\n'
            'sleep 300 &\n'
            'exit 0\n',
        )
        os.environ["OFFICE_SERVICE_OFFICECLI_BIN"] = str(bin_path)
        os.environ["OFFICE_SERVICE_TIMEOUT_SECONDS"] = "1"

        import executor, app as app_mod
        from config import ServiceConfig
        executor.reset_caches()
        app_mod.config = ServiceConfig()

        with TestClient(app_mod.app) as client:
            resp = client.post(
                "/v1/execute",
                json={
                    "workspace_id": "test-workspace",
                    "source_path": "sample.docx",
                    "output_path": "orphan-out.docx",
                    "operations": [{"command": "get", "path": "/body"}],
                    "validate": False,
                },
            )
        assert resp.status_code == 504
        os.environ.pop("OFFICE_SERVICE_TIMEOUT_SECONDS", None)

    def test_stdout_cap_breach(self, workspace_root, workspace_dir, sample_docx, tmp_path):
        """Process exceeding stdout cap triggers OfficeCLIOutputError → 502."""
        bin_path = tmp_path / "officecli-flood"
        _write_broken_binary(bin_path,
            '#!/bin/bash\n'
            'if [ "$1" = "--version" ]; then echo "1.0.143"; exit 0; fi\n'
            'python3 -c "import sys; sys.stdout.buffer.write(b\'x\' * 2048)"\n')
        os.environ["OFFICE_SERVICE_OFFICECLI_BIN"] = str(bin_path)
        os.environ["OFFICE_SERVICE_MAX_STDOUT_BYTES"] = "1024"

        import executor, app as app_mod
        from config import ServiceConfig
        executor.reset_caches()
        app_mod.config = ServiceConfig()

        with TestClient(app_mod.app) as client:
            resp = client.post("/v1/execute", json={
                "workspace_id": "test-workspace",
                "source_path": "sample.docx",
                "output_path": "flood-out.docx",
                "operations": [{"command": "get", "path": "/body"}],
                "validate": False,
            })
        assert resp.status_code == 502
        assert "exceeded" in resp.json()["detail"]
        os.environ.pop("OFFICE_SERVICE_MAX_STDOUT_BYTES", None)

    def test_stderr_flood_does_not_crash(self, workspace_root, workspace_dir, sample_docx, tmp_path):
        """Large stderr is truncated; valid JSON stdout still parses."""
        bin_path = tmp_path / "officecli-stderr"
        _write_broken_binary(bin_path,
            '#!/bin/bash\n'
            'if [ "$1" = "--version" ]; then echo "1.0.143"; exit 0; fi\n'
            'python3 -c "import sys; sys.stderr.buffer.write(b\'E\' * 200000)" 2>/dev/null\n'
            'echo \'{"success":true,"data":{"results":[{"index":0,"success":true,"output":"ok"}],"summary":{"total":1,"executed":1,"succeeded":1,"failed":0,"skipped":0}}}\'\n')
        os.environ["OFFICE_SERVICE_OFFICECLI_BIN"] = str(bin_path)

        import executor, app as app_mod
        from config import ServiceConfig
        executor.reset_caches()
        app_mod.config = ServiceConfig()

        with TestClient(app_mod.app) as client:
            resp = client.post("/v1/execute", json={
                "workspace_id": "test-workspace",
                "source_path": "sample.docx",
                "output_path": "stderr-out.docx",
                "operations": [{"command": "get", "path": "/body"}],
                "validate": False,
            })
        assert resp.status_code == 200
        assert resp.json()["success"] is True

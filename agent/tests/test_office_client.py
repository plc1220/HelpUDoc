"""Tests for the internal office_client module."""

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from typing import Any

import pytest

from helpudoc_agent.office_client import (
    OfficeServiceError,
    OfficeServiceUnavailable,
    office_execute,
    office_healthz,
)


class _MockHandler(BaseHTTPRequestHandler):
    """Minimal mock HTTP handler for office-service responses."""

    response_code: int = 200
    response_body: dict[str, Any] = {}
    last_request_body: dict[str, Any] | None = None

    def do_GET(self):
        if self.path == "/healthz":
            self._respond(200, {"status": "ok", "officecli_version": "1.0.143", "binary_sha256": "abc" * 21 + "a"})
        else:
            self._respond(404, {"error": "not_found"})

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        _MockHandler.last_request_body = json.loads(body) if body else None

        self._respond(
            _MockHandler.response_code,
            _MockHandler.response_body,
        )

    def _respond(self, code: int, body: dict):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def log_message(self, format, *args):
        pass


@pytest.fixture
def mock_server():
    """Start a mock HTTP server and configure OFFICE_SERVICE_URL."""
    server = HTTPServer(("127.0.0.1", 0), _MockHandler)
    port = server.server_address[1]
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    os.environ["OFFICE_SERVICE_URL"] = f"http://127.0.0.1:{port}"
    yield server

    server.shutdown()
    os.environ.pop("OFFICE_SERVICE_URL", None)


class TestOfficeExecute:
    def test_successful_execute(self, mock_server):
        """Response uses real OfficeCLI envelope: success, results with command field."""
        _MockHandler.response_code = 200
        _MockHandler.response_body = {
            "success": True,
            "results": [
                {"index": 0, "success": True, "command": "get", "output": {"text": "Hello"}, "error": None, "code": None}
            ],
            "summary": {"total": 1, "executed": 1, "succeeded": 1, "failed": 0, "skipped": 0},
            "validation": None,
            "officecli_version": "1.0.143",
            "duration_ms": 42,
            "warnings": [],
        }

        result = office_execute(
            workspace_id="ws-1",
            output_path="doc.docx",
            operations=[{"command": "get", "path": "/body/p[1]"}],
            source_path="doc.docx",
        )

        assert result["success"] is True
        assert result["officecli_version"] == "1.0.143"
        assert result["results"][0]["success"] is True
        assert result["results"][0]["command"] == "get"
        # Verify request body
        assert _MockHandler.last_request_body["workspace_id"] == "ws-1"
        assert _MockHandler.last_request_body["source_path"] == "doc.docx"

    def test_create_if_missing(self, mock_server):
        _MockHandler.response_code = 200
        _MockHandler.response_body = {
            "success": True,
            "results": [{"index": 0, "success": True, "command": "add", "output": "Added paragraph"}],
            "summary": {"total": 1, "executed": 1, "succeeded": 1, "failed": 0, "skipped": 0},
            "validation": None,
            "officecli_version": "1.0.143",
            "duration_ms": 10,
            "warnings": [],
        }

        result = office_execute(
            workspace_id="ws-2",
            output_path="new.docx",
            operations=[{"command": "add", "parent": "/body", "type": "paragraph"}],
            create_if_missing=True,
            validate=False,
        )

        assert _MockHandler.last_request_body["create_if_missing"] is True
        assert _MockHandler.last_request_body["validate"] is False
        assert "source_path" not in _MockHandler.last_request_body

    def test_handles_4xx_error(self, mock_server):
        _MockHandler.response_code = 422
        _MockHandler.response_body = {"error": "invalid_operations", "detail": "raw not allowed"}

        with pytest.raises(OfficeServiceError) as exc_info:
            office_execute(
                workspace_id="ws-1",
                output_path="doc.docx",
                operations=[{"command": "get", "path": "/body"}],
            )

        assert exc_info.value.status_code == 422
        assert exc_info.value.error == "invalid_operations"

    def test_handles_5xx_error(self, mock_server):
        _MockHandler.response_code = 500
        _MockHandler.response_body = {"error": "officecli_error", "detail": "crash"}

        with pytest.raises(OfficeServiceError) as exc_info:
            office_execute(
                workspace_id="ws-1",
                output_path="doc.docx",
                operations=[{"command": "get", "path": "/body"}],
            )

        assert exc_info.value.status_code == 500

    def test_handles_connection_refused(self):
        os.environ["OFFICE_SERVICE_URL"] = "http://127.0.0.1:1"
        try:
            with pytest.raises(OfficeServiceUnavailable):
                office_execute(
                    workspace_id="ws-1",
                    output_path="doc.docx",
                    operations=[{"command": "get", "path": "/body"}],
                    timeout=2.0,
                )
        finally:
            os.environ.pop("OFFICE_SERVICE_URL", None)


class TestOfficeHealthz:
    def test_successful_health_check(self, mock_server):
        result = office_healthz()
        assert result["status"] == "ok"
        assert result["officecli_version"] == "1.0.143"

    def test_health_check_unavailable(self):
        os.environ["OFFICE_SERVICE_URL"] = "http://127.0.0.1:1"
        try:
            with pytest.raises(OfficeServiceUnavailable):
                office_healthz(timeout=2.0)
        finally:
            os.environ.pop("OFFICE_SERVICE_URL", None)

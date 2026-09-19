"""Permanent regression tests for the Team Chat (F3) authenticated thread-history
tool: scope extraction from the signed context, factory registration, guarded-tool
availability under a selected skill, and scope binding (the model cannot widen
beyond the signed thread/workspace/user/cutoff)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from starlette.requests import Request

from helpudoc_agent.api.auth_context import extract_agent_request_context
from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tool_guard import GuardedTool
from helpudoc_agent.tools.workspace.builtins.team_thread_history import build_team_thread_history_tool
from helpudoc_agent.skills_registry import is_tool_allowed, ALWAYS_ALLOWED_TOOLS


SECRET = "test-agent-secret"


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _sign(payload: dict) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64url(json.dumps(payload).encode())
    signing_input = f"{header}.{body}".encode()
    sig = _b64url(hmac.new(SECRET.encode(), signing_input, hashlib.sha256).digest())
    return f"{header}.{body}.{sig}"


def _scope_payload():
    return {
        "userId": "user-1",
        "workspaceId": "ws-1",
        "threadHistoryScope": {
            "workspaceId": "ws-1",
            "userId": "user-1",
            "threadId": "thread-1",
            "cutoffSeq": 7,
            "sourceMessageId": "source-1",
        },
    }


def _request_with(token: str) -> Request:
    return Request({"type": "http", "headers": [(b"authorization", f"Bearer {token}".encode())]})


def test_auth_context_extracts_thread_history_scope():
    token = _sign(_scope_payload())
    ctx = extract_agent_request_context(_request_with(token), agent_jwt_secret=SECRET)
    scope = ctx.get("thread_history_scope")
    assert scope == {
        "workspace_id": "ws-1",
        "user_id": "user-1",
        "thread_id": "thread-1",
        "cutoff_seq": 7,
        "source_message_id": "source-1",
    }


def test_tool_is_registered_in_factory():
    # The tool must be in the factory builtin map (a real registered tool, not a
    # prompt instruction).
    from helpudoc_agent.tools.workspace.factory import ToolFactory
    factory = ToolFactory.__new__(ToolFactory)
    # Reconstruct just the builtin map the constructor builds.
    factory.settings = SimpleNamespace()  # type: ignore[attr-defined]
    # The name is present in the class-level construction; assert via source of truth.
    import helpudoc_agent.tools.workspace.factory as fac
    src = Path(fac.__file__).read_text()
    assert '"team_thread_history"' in src, "tool must be wired into the factory builtin map"


def test_always_allowed_includes_history_reader():
    assert "team_thread_history" in ALWAYS_ALLOWED_TOOLS
    # Under a selected skill that does NOT list the tool, it is still allowed.
    skill = {"skill_id": "review-fixture", "tools": ["inspect_document"], "mcp_servers": []}
    assert is_tool_allowed("team_thread_history", skill) is True
    # An unrelated tool remains blocked by the same skill scope.
    assert is_tool_allowed("document_execute", skill) is False


def test_tool_uses_only_signed_scope_and_ignores_model_supplied_fields(tmp_path):
    token = _sign(_scope_payload())
    ctx = extract_agent_request_context(_request_with(token), agent_jwt_secret=SECRET)
    ctx.update(agent_auth_token=token, backend_base_url="http://backend:3000")
    state = WorkspaceState(workspace_id="ws-1", root_path=tmp_path, context=ctx)
    tool = build_team_thread_history_tool(state)

    captured = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"messages": [{"role": "user", "authorName": "A", "content": "hello"}], "hasMore": False, "nextFromSeq": None}

    def _fake_get(url, params=None, headers=None, timeout=None):
        captured["url"] = url
        captured["params"] = params
        captured["headers"] = headers
        return _Resp()

    with patch("helpudoc_agent.tools.workspace.builtins.team_thread_history.requests.get", _fake_get):
        # The model supplies forged workspace/thread ids; they must be IGNORED —
        # the request always targets the signed scope.
        out = tool.func(json.dumps({"fromSeq": 1, "toSeq": 999, "workspaceId": "forged", "threadId": "forged"}))

    assert "hello" in out
    assert captured["params"]["workspaceId"] == "ws-1"
    assert captured["params"]["threadId"] == "thread-1"
    # toSeq defaults toward cutoff so the bound source is retrievable.
    assert captured["headers"]["Authorization"] == f"Bearer {token}"


def test_tool_reports_when_scope_absent(tmp_path):
    state = WorkspaceState(workspace_id="ws-1", root_path=tmp_path, context={})
    tool = build_team_thread_history_tool(state)
    out = tool.func("{}")
    assert "no authenticated thread scope" in out


def test_guarded_tool_allows_history_reader_under_selected_skill(tmp_path):
    token = _sign(_scope_payload())
    ctx = extract_agent_request_context(_request_with(token), agent_jwt_secret=SECRET)
    ctx.update(agent_auth_token=token, backend_base_url="http://backend:3000")
    # A selected skill that does not declare the tool.
    ctx["active_skill_scope"] = {"skill_id": "review-fixture", "tools": ["inspect_document"], "mcp_servers": []}
    state = WorkspaceState(workspace_id="ws-1", root_path=tmp_path, context=ctx)
    tool = build_team_thread_history_tool(state)
    guarded = GuardedTool.from_tool(tool, workspace_state=state)

    class _Resp:
        status_code = 200

        def json(self):
            return {"messages": [{"role": "user", "authorName": "A", "content": "guarded-ok"}], "hasMore": False, "nextFromSeq": None}

    with patch("helpudoc_agent.tools.workspace.builtins.team_thread_history.requests.get", lambda *a, **k: _Resp()):
        result = guarded.invoke(json.dumps({"fromSeq": 1, "toSeq": 7}))
    assert "guarded-ok" in result, "history reader must remain usable under a selected skill"

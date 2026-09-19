"""Authenticated Team Chat thread-history reader tool (spec F3.4).

This is a REAL registered agent tool — not a prompt instruction. It reads exact
thread history for omitted/truncated messages by calling the backend's
agent-JWT-authenticated internal endpoint.

Security model:
  * The reader scope (workspace / user / thread / run cutoff) is taken from the
    SIGNED agent context token, surfaced by auth_context as
    ``thread_history_scope``. The model cannot supply or override it — this tool
    exposes no workspace/thread/user arguments at all, only a sequence range.
  * The tool authenticates the callback with the exact signed token it was
    issued (``agent_auth_token``); no forged identity is possible.
  * The backend re-verifies the token, re-checks CURRENT workspace access, and
    clamps the range to the immutable cutoff. Revocation and cross-scope attempts
    fail at the backend regardless of what the model requests.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

import requests
from langchain_core.tools import Tool

from ....state import WorkspaceState

logger = logging.getLogger(__name__)

_MAX_LIMIT = 100
_REQUEST_TIMEOUT_SECONDS = 15


def _scope(workspace_state: WorkspaceState) -> Optional[Dict[str, Any]]:
    context = workspace_state.context if isinstance(workspace_state.context, dict) else {}
    scope = context.get("thread_history_scope")
    if not isinstance(scope, dict):
        return None
    workspace_id = str(scope.get("workspace_id") or "").strip()
    thread_id = str(scope.get("thread_id") or "").strip()
    cutoff = scope.get("cutoff_seq")
    if not workspace_id or not thread_id or cutoff is None:
        return None
    return scope


def build_team_thread_history_tool(workspace_state: WorkspaceState) -> Tool:
    def _read_history(query: str = "") -> str:
        scope = _scope(workspace_state)
        if scope is None:
            return (
                "The thread-history reader is not available: this run has no "
                "authenticated thread scope."
            )
        context = workspace_state.context if isinstance(workspace_state.context, dict) else {}
        token = str(context.get("agent_auth_token") or "").strip()
        base_url = str(context.get("backend_base_url") or "").strip().rstrip("/")
        if not token or not base_url:
            return (
                "The thread-history reader is not configured (missing signed "
                "token or backend URL); it cannot retrieve messages this run."
            )

        # Parse the requested sequence range. The tool intentionally accepts ONLY
        # a range — never a thread/workspace/user — so the model cannot redirect
        # it outside the signed scope.
        from_seq = 0
        to_seq = 0
        limit = _MAX_LIMIT
        raw = (query or "").strip()
        if raw:
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    from_seq = int(parsed.get("fromSeq", parsed.get("from_seq", 0)) or 0)
                    to_seq = int(parsed.get("toSeq", parsed.get("to_seq", 0)) or 0)
                    if parsed.get("limit") is not None:
                        limit = int(parsed.get("limit"))
            except (ValueError, TypeError, json.JSONDecodeError):
                # Fall back to "from-to" or "from" plain forms.
                tokens = raw.replace("-", " ").split()
                nums = [int(t) for t in tokens if t.lstrip("-").isdigit()]
                if len(nums) >= 2:
                    from_seq, to_seq = nums[0], nums[1]
                elif len(nums) == 1:
                    from_seq = nums[0]
                    to_seq = nums[0]
        if to_seq <= 0:
            # Reach the cutoff so the run's own (excerpted) source request is
            # retrievable by its bound id. The backend still clamps ordinary
            # history to strictly-before-cutoff; only the bound source id is
            # returned at the cutoff sequence, and later messages remain denied.
            to_seq = int(scope["cutoff_seq"])
        limit = max(1, min(limit, _MAX_LIMIT))

        params = {
            "workspaceId": scope["workspace_id"],
            "threadId": scope["thread_id"],
            "fromSeq": max(0, from_seq),
            "toSeq": max(0, to_seq),
            "limit": limit,
        }
        headers = {"Authorization": f"Bearer {token}"}
        try:
            response = requests.get(
                f"{base_url}/api/internal/agent/team-chat/thread-history",
                params=params,
                headers=headers,
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
        except requests.RequestException as exc:
            logger.warning("team_thread_history request failed: %s", exc)
            return f"Could not reach the thread-history reader: {exc}"
        if response.status_code == 401:
            return "The thread-history reader rejected the request (unauthenticated)."
        if response.status_code == 403:
            return "The thread-history reader denied access to the requested scope."
        if response.status_code >= 400:
            return f"The thread-history reader returned an error ({response.status_code})."
        try:
            payload = response.json()
        except ValueError:
            return "The thread-history reader returned an unreadable response."
        messages = payload.get("messages") if isinstance(payload, dict) else None
        if not messages:
            return "No messages were found in that range within this thread."
        rendered = [
            f"[{item.get('role')}] {item.get('authorName')}: {item.get('content')}"
            for item in messages
            if isinstance(item, dict)
        ]
        footer = ""
        if isinstance(payload, dict) and payload.get("hasMore"):
            footer = f"\n(More messages available; continue from sequence {payload.get('nextFromSeq')}.)"
        return "\n\n".join(rendered) + footer

    return Tool(
        name="team_thread_history",
        description=(
            "Retrieve the exact, authorized text of omitted or truncated messages "
            "from THIS Team Chat thread. Input is a JSON object {\"fromSeq\": <int>, "
            "\"toSeq\": <int>, \"limit\": <int, optional, max 100>} or a plain "
            "\"from-to\" range. The thread, workspace, user, and cutoff are fixed by "
            "the run's signed context; you cannot read any other thread. Use this "
            "instead of guessing omitted content."
        ),
        func=_read_history,
    )

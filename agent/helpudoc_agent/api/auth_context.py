"""JWT-derived request context for agent routes."""
from __future__ import annotations

from typing import Any, Dict

from fastapi import HTTPException, Request

from helpudoc_agent.jwt_utils import decode_and_verify_hs256_jwt


def extract_agent_request_context(request: Request, *, agent_jwt_secret: str) -> Dict[str, Any]:
    """Extract backend-provided context (RBAC policy, user id) from JWT."""
    if not agent_jwt_secret:
        return {}
    raw_auth = request.headers.get("authorization") or ""
    token = ""
    if raw_auth.lower().startswith("bearer "):
        token = raw_auth.split(" ", 1)[1].strip()
    if not token:
        return {}
    payload = decode_and_verify_hs256_jwt(token, agent_jwt_secret)
    if not payload:
        return {}
    context: Dict[str, Any] = {}
    user_id = payload.get("userId") or payload.get("sub")
    if isinstance(user_id, str) and user_id.strip():
        context["user_id"] = user_id.strip()
    workspace_id = payload.get("workspaceId")
    if isinstance(workspace_id, str) and workspace_id.strip():
        context["workspace_id"] = workspace_id.strip()
    skill_allow_ids = payload.get("skillAllowIds") or []
    if isinstance(skill_allow_ids, list):
        context["skill_allow_ids"] = [str(x).strip() for x in skill_allow_ids if str(x).strip()]
    allow_ids = payload.get("mcpServerAllowIds") or []
    deny_ids = payload.get("mcpServerDenyIds") or []
    is_admin = bool(payload.get("isAdmin", False))
    allow_skill_sandbox = bool(
        payload.get("allowSkillSandbox")
        or payload.get("allow_skill_sandbox")
        or payload.get("allowScriptRunner")
        or payload.get("allow_script_runner")
    )
    if isinstance(allow_ids, list) or isinstance(deny_ids, list) or isinstance(is_admin, bool):
        context["mcp_policy"] = {
            "allowIds": [str(x) for x in (allow_ids or []) if str(x).strip()],
            "denyIds": [str(x) for x in (deny_ids or []) if str(x).strip()],
            "isAdmin": is_admin,
        }
    mcp_auth = payload.get("mcpAuth") or {}
    if isinstance(mcp_auth, dict):
        normalized_auth: Dict[str, Dict[str, str]] = {}
        for server_name, headers in mcp_auth.items():
            if not isinstance(server_name, str) or not server_name.strip():
                continue
            if not isinstance(headers, dict):
                continue
            normalized_headers: Dict[str, str] = {}
            for header_name, header_value in headers.items():
                if not isinstance(header_name, str) or not header_name.strip():
                    continue
                if isinstance(header_value, str) and header_value.strip():
                    normalized_headers[header_name] = header_value
            if normalized_headers:
                normalized_auth[server_name.strip()] = normalized_headers
        if normalized_auth:
            context["mcp_auth"] = normalized_auth
    mcp_auth_fingerprint = payload.get("mcpAuthFingerprint")
    if isinstance(mcp_auth_fingerprint, str) and mcp_auth_fingerprint.strip():
        context["mcp_auth_fingerprint"] = mcp_auth_fingerprint.strip()
    if allow_skill_sandbox:
        context["allow_skill_sandbox"] = True
    context["skip_plan_approvals"] = bool(payload.get("skipPlanApprovals", True))
    return context


def require_internal_user_context(request: Request, *, agent_jwt_secret: str) -> Dict[str, Any]:
    context = extract_agent_request_context(request, agent_jwt_secret=agent_jwt_secret)
    user_id = context.get("user_id")
    if not isinstance(user_id, str) or not user_id.strip():
        raise HTTPException(status_code=401, detail="Missing or invalid agent context token")
    return context

"""MCP Server Manager - manages connections and provides RBAC-filtered tools.

This follows the pattern used by ToolFactory.build_tools(): the agent builder
calls MCPServerManager.get_tools() to obtain MCP-provided tools for the request.
"""

from __future__ import annotations

import logging
import os
import json
from copy import deepcopy
from typing import Any, Dict, List, Optional

from langchain_core.tools import StructuredTool, Tool

from .configuration import MCPServerConfig, Settings
from .state import WorkspaceState

logger = logging.getLogger(__name__)

_GEMINI_ARRAY_TYPE = 5
_GEMINI_OBJECT_TYPE = 6


def _normalize_auth_header(value: str) -> str:
    """Normalize bearer auth values and collapse accidental double-prefixes."""
    raw = (value or "").strip()
    if not raw:
        return raw
    if raw.lower().startswith("bearer "):
        token = raw[7:].strip()
        # Guard against malformed values like: "Bearer Bearer <token>".
        while token.lower().startswith("bearer "):
            token = token[7:].strip()
        return f"Bearer {token}" if token else ""
    return raw


def _format_exception(exc: BaseException) -> str:
    """Flatten ExceptionGroup for readable logs."""
    if isinstance(exc, BaseExceptionGroup):  # py>=3.11
        parts: List[str] = []
        for inner in exc.exceptions:
            parts.append(_format_exception(inner))
        return "; ".join([p for p in parts if p]) or repr(exc)
    return str(exc) or repr(exc)


def _json_schema_for_tool(tool: Tool) -> Dict[str, Any]:
    try:
        from langchain_core.utils.json_schema import dereference_refs
    except Exception:  # pragma: no cover - optional fallback for older deps
        dereference_refs = None

    args_schema = getattr(tool, "args_schema", None)
    if isinstance(args_schema, dict):
        schema = args_schema
    elif args_schema is None:
        schema = {}
    elif hasattr(args_schema, "model_json_schema"):
        schema = args_schema.model_json_schema()
    elif hasattr(args_schema, "schema"):
        schema = args_schema.schema()
    else:
        raise TypeError(f"Unsupported args_schema for tool {getattr(tool, 'name', '<unknown>')}: {type(args_schema)!r}")
    if dereference_refs is not None:
        try:
            schema = dereference_refs(schema)
        except Exception:
            logger.debug("Failed to dereference tool schema for %s", getattr(tool, "name", "<unknown>"), exc_info=True)
    return schema


def _schema_type_name(raw_value: Any) -> str | None:
    if isinstance(raw_value, str):
        return raw_value
    if isinstance(raw_value, int):
        if raw_value == _GEMINI_ARRAY_TYPE:
            return "array"
        if raw_value == _GEMINI_OBJECT_TYPE:
            return "object"
    return None


def _non_null_anyof_members(raw_schema: Dict[str, Any]) -> List[Dict[str, Any]]:
    members = raw_schema.get("anyOf")
    if not isinstance(members, list):
        return []
    results: List[Dict[str, Any]] = []
    for item in members:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "null":
            continue
        results.append(item)
    return results


def _validate_gemini_schema_pair(
    raw_schema: Dict[str, Any],
    converted_schema: Dict[str, Any],
    *,
    path: str = "parameters",
) -> None:
    converted_type = _schema_type_name(converted_schema.get("type_"))
    if converted_type == "array" and not isinstance(converted_schema.get("items"), dict):
        raise ValueError(f"{path}.items missing after Gemini conversion")

    non_null_members = _non_null_anyof_members(raw_schema)
    if len(non_null_members) > 1 and converted_type in {"array", "object"}:
        has_scalar_member = any(member.get("type") in {"string", "number", "integer", "boolean"} for member in non_null_members)
        has_complex_member = any(member.get("type") in {"array", "object"} for member in non_null_members)
        if has_scalar_member and has_complex_member:
            raise ValueError(
                f"{path} preserves a mixed scalar/complex union that Gemini tool calling rejects"
            )

    if converted_type in {"array", "object"} and non_null_members:
        matching_members = [member for member in non_null_members if member.get("type") == converted_type]
        if matching_members:
            selected_raw_schema = matching_members[-1]
            if isinstance(selected_raw_schema, dict):
                raw_schema = {**selected_raw_schema}

    raw_type = raw_schema.get("type")
    if not raw_type and non_null_members:
        raw_type = non_null_members[-1].get("type")
    if raw_type == "object" and raw_schema.get("additionalProperties") and converted_type == "object":
        converted_properties = converted_schema.get("properties")
        if not isinstance(converted_properties, dict) or not converted_properties:
            raise ValueError(
                f"{path} degraded from additionalProperties object to an empty Gemini object schema"
            )

    raw_properties = raw_schema.get("properties")
    converted_properties = converted_schema.get("properties")
    if isinstance(raw_properties, dict):
        if converted_type == "object" and not isinstance(converted_properties, dict):
            raise ValueError(f"{path}.properties missing after Gemini conversion")
        for key, raw_child in raw_properties.items():
            if not isinstance(raw_child, dict):
                continue
            if not isinstance(converted_properties, dict) or key not in converted_properties:
                raise ValueError(f"{path}.properties.{key} missing after Gemini conversion")
            converted_child = converted_properties[key]
            if not isinstance(converted_child, dict):
                raise ValueError(f"{path}.properties.{key} is not a Gemini schema object")
            _validate_gemini_schema_pair(
                raw_child,
                converted_child,
                path=f"{path}.properties.{key}",
            )

    raw_items = raw_schema.get("items")
    converted_items = converted_schema.get("items")
    if isinstance(raw_items, dict):
        if not isinstance(converted_items, dict):
            raise ValueError(f"{path}.items missing after Gemini conversion")
        _validate_gemini_schema_pair(raw_items, converted_items, path=f"{path}.items")


def _preflight_gemini_tools(tools: List[Tool]) -> None:
    try:
        from langchain_google_genai._function_utils import (  # type: ignore
            convert_to_genai_function_declarations,
            tool_to_dict,
        )
    except Exception as exc:  # pragma: no cover - dependency is required in prod
        raise RuntimeError(f"Gemini conversion helpers unavailable: {exc}") from exc

    declarations = convert_to_genai_function_declarations(tools)
    payload = tool_to_dict(declarations)
    declaration_map = {
        str(item.get("name") or ""): item
        for item in payload.get("function_declarations", [])
        if isinstance(item, dict)
    }

    for tool in tools:
        tool_name = str(getattr(tool, "name", "") or "")
        raw_schema = _json_schema_for_tool(tool)
        declaration = declaration_map.get(tool_name)
        if declaration is None:
            raise ValueError(f"tool '{tool_name}' missing from Gemini function declarations")
        converted_schema = declaration.get("parameters") or {}
        if not isinstance(converted_schema, dict):
            raise ValueError(f"tool '{tool_name}' produced non-dict Gemini parameters")
        _validate_gemini_schema_pair(raw_schema, converted_schema, path="parameters")


def _remove_null_union(schema: Dict[str, Any]) -> Dict[str, Any]:
    any_of = schema.get("anyOf")
    if not isinstance(any_of, list):
        return schema
    non_null = [item for item in any_of if isinstance(item, dict) and item.get("type") != "null"]
    if not non_null:
        return schema
    if len(non_null) == 1:
        merged = deepcopy(non_null[0])
    else:
        preferred = next((item for item in non_null if item.get("type") == "array"), None)
        preferred = preferred or next((item for item in non_null if item.get("type") == "object"), None)
        preferred = preferred or non_null[-1]
        merged = deepcopy(preferred)
    for key in ("description", "title", "default"):
        if key in schema and key not in merged:
            merged[key] = schema[key]
    return merged


def _sanitize_schema_for_gemini(schema: Dict[str, Any]) -> Dict[str, Any]:
    schema = deepcopy(schema)
    if "anyOf" in schema:
        schema = _remove_null_union(schema)
    properties = schema.get("properties")
    if isinstance(properties, dict):
        schema["properties"] = {
            key: _sanitize_schema_for_gemini(value)
            if isinstance(value, dict)
            else value
            for key, value in properties.items()
        }
    items = schema.get("items")
    if isinstance(items, dict):
        schema["items"] = _sanitize_schema_for_gemini(items)
    return schema


def _normalize_pricing_region(payload: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(payload)
    region = result.get("region")
    if isinstance(region, list):
        cleaned = [str(item).strip() for item in region if str(item).strip()]
        if not cleaned:
            result.pop("region", None)
        elif len(cleaned) == 1:
            result["region"] = cleaned[0]
        else:
            result["region"] = cleaned
    return result


def _normalize_pricing_filters(payload: Dict[str, Any]) -> Dict[str, Any]:
    result = _normalize_pricing_region(payload)
    raw_filters = result.get("filters")
    if not isinstance(raw_filters, list):
        return result
    normalized_filters: List[Dict[str, Any]] = []
    for raw_filter in raw_filters:
        if not isinstance(raw_filter, dict):
            continue
        item = dict(raw_filter)
        filter_type = str(item.get("Type") or "EQUALS").strip().upper()
        value = item.get("Value")
        if isinstance(value, list):
            cleaned = [str(entry).strip() for entry in value if str(entry).strip()]
            if filter_type in {"ANY_OF", "NONE_OF"}:
                item["Value"] = cleaned
            elif cleaned:
                item["Value"] = cleaned[0]
            else:
                item.pop("Value", None)
        normalized_filters.append(item)
    result["filters"] = normalized_filters
    return result


def _normalize_attribute_value_filters(payload: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(payload)
    raw_filters = result.get("filters")
    if not isinstance(raw_filters, list):
        return result
    mapped: Dict[str, str] = {}
    for item in raw_filters:
        if not isinstance(item, dict):
            continue
        key = str(item.get("attribute") or item.get("name") or "").strip()
        value = str(item.get("pattern") or item.get("value") or "").strip()
        if key and value:
            mapped[key] = value
    result["filters"] = mapped or None
    return result


def _pairs_to_mapping(value: Any) -> Any:
    if not isinstance(value, list):
        return value
    mapped: Dict[str, Any] = {}
    for item in value:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or item.get("name") or "").strip()
        if not key:
            continue
        mapped[key] = item.get("value")
    return mapped


def _normalize_cost_report_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(payload)
    for key in ("pricing_data", "detailed_cost_data", "recommendations"):
        if key in result:
            result[key] = _pairs_to_mapping(result.get(key))
    return result


def _key_value_array_schema(
    *,
    description: str | None = None,
    title: str | None = None,
    value_description: str | None = None,
) -> Dict[str, Any]:
    return {
        "type": "array",
        "description": description,
        "title": title,
        "items": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "Map key"},
                "value": {"type": "string", "description": value_description or "Map value serialized as text"},
            },
            "required": ["key", "value"],
        },
    }


def _stringify_tool_result(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        if isinstance(result.get("text"), str):
            return result["text"]
        if isinstance(result.get("content"), str):
            return result["content"]
        return json.dumps(result, ensure_ascii=False, default=str)
    if isinstance(result, list):
        parts: List[str] = []
        for item in result:
            if item is None:
                continue
            if isinstance(item, str):
                parts.append(item)
                continue
            if isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    parts.append(item["text"])
                    continue
                if isinstance(item.get("content"), str):
                    parts.append(item["content"])
                    continue
            parts.append(json.dumps(item, ensure_ascii=False, default=str) if isinstance(item, (dict, list)) else str(item))
        return "\n".join(part for part in parts if part).strip()
    return str(result)


def _coerce_tool_result_for_response_format(result: Any, response_format: str) -> Any:
    if response_format != "content_and_artifact":
        return result
    if isinstance(result, tuple) and len(result) == 2:
        return result
    return (_stringify_tool_result(result), result)


def _aws_pricing_tool_overrides(tool_name: str, raw_schema: Dict[str, Any]) -> tuple[Dict[str, Any], Any]:
    sanitized = _sanitize_schema_for_gemini(raw_schema)
    transform = lambda payload: dict(payload)

    if tool_name == "get_pricing":
        region_schema = sanitized.get("properties", {}).get("region")
        if isinstance(region_schema, dict):
            sanitized["properties"]["region"] = {
                "type": "array",
                "items": {"type": "string"},
                "description": region_schema.get("description"),
                "title": region_schema.get("title"),
            }
        filters_schema = sanitized.get("properties", {}).get("filters")
        if isinstance(filters_schema, dict):
            sanitized["properties"]["filters"] = {
                "type": "array",
                "description": filters_schema.get("description"),
                "title": filters_schema.get("title"),
                "items": {
                    "type": "object",
                    "description": "Filter model for AWS Price List API queries.",
                    "properties": {
                        "Field": {"type": "string", "description": "The field to filter on (e.g., 'instanceType', 'location')"},
                        "Type": {"type": "string", "description": "The type of filter match", "default": "EQUALS"},
                        "Value": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Values to match. Use a single-item list for EQUALS/CONTAINS, multi-item list for ANY_OF/NONE_OF.",
                        },
                    },
                    "required": ["Field", "Value"],
                },
            }
        transform = _normalize_pricing_filters
    elif tool_name == "get_pricing_attribute_values":
        filters_schema = sanitized.get("properties", {}).get("filters")
        if isinstance(filters_schema, dict):
            sanitized["properties"]["filters"] = {
                "type": "array",
                "description": filters_schema.get("description"),
                "title": filters_schema.get("title"),
                "items": {
                    "type": "object",
                    "properties": {
                        "attribute": {"type": "string", "description": "Attribute name to filter, e.g. instanceType"},
                        "pattern": {"type": "string", "description": "Regex or substring pattern for the attribute values"},
                    },
                    "required": ["attribute", "pattern"],
                },
            }
        transform = _normalize_attribute_value_filters
    elif tool_name == "generate_cost_report":
        properties = sanitized.get("properties", {})
        if isinstance(properties, dict):
            for key in ("pricing_data", "detailed_cost_data", "recommendations"):
                raw_field = properties.get(key)
                if isinstance(raw_field, dict):
                    properties[key] = _key_value_array_schema(
                        description=raw_field.get("description"),
                        title=raw_field.get("title"),
                        value_description="JSON-serialized or plain-text value",
                    )
        transform = _normalize_cost_report_payload

    return sanitized, transform


def _wrap_tool_for_gemini(
    server_name: str,
    tool: Tool,
) -> tuple[Tool, Dict[str, Any]]:
    raw_schema = _json_schema_for_tool(tool)
    sanitized_schema = deepcopy(raw_schema)
    transform = lambda payload: dict(payload)

    if server_name == "aws-pricing":
        sanitized_schema, transform = _aws_pricing_tool_overrides(tool.name, raw_schema)

    async def _async_call(**kwargs: Any) -> Any:
        payload = transform(kwargs)
        response_format = str(getattr(tool, "response_format", "content") or "content")
        if hasattr(tool, "ainvoke"):
            result = await tool.ainvoke(payload)
        else:
            result = tool.invoke(payload)
        return _coerce_tool_result_for_response_format(result, response_format)

    def _call(**kwargs: Any) -> Any:
        response_format = str(getattr(tool, "response_format", "content") or "content")
        result = tool.invoke(transform(kwargs))
        return _coerce_tool_result_for_response_format(result, response_format)

    wrapped = StructuredTool(
        name=tool.name,
        description=tool.description,
        args_schema=sanitized_schema,
        return_direct=bool(getattr(tool, "return_direct", False)),
        response_format=str(getattr(tool, "response_format", "content") or "content"),
        func=_call,
        coroutine=_async_call,
    )
    return wrapped, sanitized_schema


def describe_mcp_servers(settings: Settings) -> List[Dict[str, Any]]:
    """Return MCP server metadata for UI/debugging (no secrets)."""
    result: List[Dict[str, Any]] = []
    for cfg in (settings.mcp_servers or {}).values():
        endpoint = cfg.url or cfg.endpoint
        result.append(
            {
                "name": cfg.name,
                "transport": cfg.transport,
                "endpoint": endpoint,
                "description": cfg.description,
                "delegated_auth_provider": getattr(cfg, "delegated_auth_provider", None),
                "default_access": getattr(cfg, "default_access", "allow"),
            }
        )
    return result


class MCPServerManager:
    """Manages MCP server connections and provides RBAC-filtered tools."""

    def __init__(self, settings: Settings, workspace_state: WorkspaceState):
        self.settings = settings
        self.workspace_state = workspace_state
        self._allowed_servers: Dict[str, MCPServerConfig] = {}
        self._tools_by_server: Dict[str, List[Tool]] = {}
        self._clients_by_server: Dict[str, Any] = {}
        self._rejected_servers: Dict[str, str] = {}

    def _filter_by_policy(self) -> Dict[str, MCPServerConfig]:
        """Filter configured servers based on workspace RBAC policy."""
        mcp_policy = self.workspace_state.context.get("mcp_policy", {}) or {}
        deny_ids = set(mcp_policy.get("denyIds", []) or [])
        allow_ids = set(mcp_policy.get("allowIds", []) or [])
        is_admin = bool(mcp_policy.get("isAdmin", False))

        allowed: Dict[str, MCPServerConfig] = {}
        for name, cfg in (self.settings.mcp_servers or {}).items():
            # Admin gets everything.
            if is_admin:
                allowed[name] = cfg
                continue
            # Explicit deny always wins.
            if name in deny_ids:
                continue
            # Default deny requires explicit allow.
            if getattr(cfg, "default_access", "allow") == "deny" and name not in allow_ids:
                continue
            allowed[name] = cfg
        return allowed

    def _build_langchain_mcp_config(self, cfg: MCPServerConfig) -> Dict[str, Any]:
        """Build a single-server config payload for langchain-mcp-adapters."""
        if cfg.transport == "stdio":
            env = dict(cfg.env or {})
            passthrough = cfg.env_passthrough or []
            for key in passthrough:
                if not key:
                    continue
                if key in os.environ and key not in env:
                    env[key] = os.environ[key]
            return {
                "transport": "stdio",
                "command": cfg.command,
                "args": cfg.args or [],
                "env": env,
                "cwd": cfg.cwd,
            }

        runtime_auth = self.workspace_state.context.get("mcp_auth", {}) or {}
        runtime_headers: Dict[str, str] = {}
        if isinstance(runtime_auth, dict):
            candidate = runtime_auth.get(cfg.name)
            if isinstance(candidate, dict):
                for header_name, header_value in candidate.items():
                    if not header_name or not isinstance(header_name, str):
                        continue
                    if isinstance(header_value, str) and header_value:
                        if header_name.lower() == "authorization":
                            normalized = _normalize_auth_header(header_value)
                            if normalized:
                                runtime_headers[header_name] = normalized
                        else:
                            runtime_headers[header_name] = header_value

        headers: Dict[str, str] = dict(runtime_headers)
        for header_name, header_value in (cfg.headers or {}).items():
            if not header_name or not isinstance(header_name, str):
                continue
            if isinstance(header_value, str) and header_value:
                if header_name.lower() == "authorization":
                    normalized = _normalize_auth_header(header_value)
                    if normalized:
                        headers.setdefault(header_name, normalized)
                else:
                    headers.setdefault(header_name, header_value)
        # Inject headers from environment variables (value = env var name).
        for header_name, env_var in (cfg.headers_from_env or {}).items():
            if not header_name or not env_var:
                continue
            value = os.environ.get(str(env_var), "")
            if value:
                headers.setdefault(str(header_name), value)

        if cfg.bearer_token_env_var:
            token = os.environ.get(cfg.bearer_token_env_var, "")
            has_auth_header = any(str(name).lower() == "authorization" for name in headers.keys())
            if token and not has_auth_header:
                normalized = _normalize_auth_header(f"Bearer {token}")
                if normalized:
                    headers.setdefault("Authorization", normalized)

        return {
            "transport": cfg.transport,  # "http" or "sse"
            "url": cfg.url or cfg.endpoint,
            "headers": headers,
        }

    async def initialize(
        self,
        *,
        candidate_server_names: Optional[List[str]] = None,
        preflight_gemini: bool = False,
    ) -> None:
        """Connect to all allowed MCP servers and cache their tools."""
        allowed_servers = self._filter_by_policy()
        candidate_names = [str(name).strip() for name in (candidate_server_names or []) if str(name).strip()]
        if candidate_server_names is not None:
            allowed_servers = {
                name: cfg
                for name, cfg in allowed_servers.items()
                if name in set(candidate_names)
            }
        self._allowed_servers = allowed_servers
        self._tools_by_server = {}
        self._clients_by_server = {}
        self._rejected_servers = {}

        if not self._allowed_servers:
            return

        try:
            # Optional dependency; if missing, registry remains empty.
            from langchain_mcp_adapters.client import MultiServerMCPClient  # type: ignore
        except Exception as exc:  # pragma: no cover - optional dependency
            logger.warning("langchain-mcp-adapters not installed; MCP tools disabled (%s)", exc)
            return

        for name, cfg in self._allowed_servers.items():
            try:
                server_config = self._build_langchain_mcp_config(cfg)
                if not server_config.get("url") and cfg.transport in {"http", "sse"}:
                    raise ValueError("Missing url for http/sse MCP server")
                if cfg.transport == "stdio" and not server_config.get("command"):
                    raise ValueError("Missing command for stdio MCP server")

                client = MultiServerMCPClient({name: server_config})
                tools = await client.get_tools()
                wrapped_tools = list(tools or [])
                if preflight_gemini:
                    try:
                        wrapped_tools = []
                        for original_tool in list(tools or []):
                            wrapped_tool, _sanitized_schema = _wrap_tool_for_gemini(name, original_tool)
                            wrapped_tools.append(wrapped_tool)
                        _preflight_gemini_tools(wrapped_tools)
                    except Exception as exc:
                        reason = _format_exception(exc)
                        self._rejected_servers[name] = reason
                        logger.warning(
                            "Rejected MCP server during Gemini preflight (server=%s reason=%s)",
                            name,
                            reason,
                        )
                        continue
                self._clients_by_server[name] = client
                self._tools_by_server[name] = wrapped_tools
            except Exception as exc:
                self._rejected_servers[name] = _format_exception(exc)
                logger.warning(
                    "Failed to connect to MCP server; excluding from available tools (server=%s error=%s)",
                    name,
                    _format_exception(exc),
                )

    async def get_tools(self) -> List[Tool]:
        """Return tools from all connected MCP servers."""
        if not self._tools_by_server:
            return []
        tools: List[Tool] = []
        for items in self._tools_by_server.values():
            tools.extend(items)
        return tools

    def get_tools_by_server(self) -> Dict[str, List[Tool]]:
        return self._tools_by_server

    def get_allowed_server_names(self) -> List[str]:
        return list(self._allowed_servers.keys())

    def get_rejected_servers(self) -> Dict[str, str]:
        return dict(self._rejected_servers)

    async def cleanup(self) -> None:
        """Clean up MCP connections (best-effort)."""
        # MultiServerMCPClient should manage its own lifecycle; drop references.
        self._clients_by_server = {}
        self._tools_by_server = {}
        self._allowed_servers = {}

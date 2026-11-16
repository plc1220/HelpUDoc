"""Calendar writes go through Lumo's provider-backed domain, never raw MCP."""
from __future__ import annotations
import json
import re
from typing import Any


def calendar_mcp_write_error(name: str, server: str | None, payload: Any = None) -> str | None:
    if not server:
        return None
    label = name.lower()
    data = json.dumps(payload or {}, default=str).lower()
    google_events = any(part in server.lower() for part in ('google', 'gws')) and any(part in label for part in ('event', 'meeting'))
    if 'calendar' not in label and 'calendar' not in data and not google_events:
        return None
    # Typed read tools are retained. Ambiguous/generic calls fail closed rather
    # than accepting a model-provided claim of approval or write entitlement.
    read = re.search(r'(?:^|_)(?:get|list|search|freebusy|free_busy|query)(?:_|$)', label)
    mutation = re.search(r'(?:insert|create|update|patch|delete|remove|move|cancel|import|quick_add|quickadd|clear|watch|stop)', label)
    def structured_write(value: Any) -> bool:
        if isinstance(value, dict):
            for key, entry in value.items():
                if str(key).lower() in {'method', 'http_method', 'operation', 'action', 'command'} and re.search(r'(?:insert|create|update|patch|delete|remove|move|cancel|import|quickadd|clear|watch|stop|post|put)', str(entry).lower()):
                    return True
                if structured_write(entry):
                    return True
        if isinstance(value, list):
            return any(structured_write(entry) for entry in value)
        return False
    if read and not mutation and not structured_write(payload):
        return None
    return 'Calendar changes require user review and Save in My Calendar. Direct Calendar MCP mutations are disabled; use calendar_read for permitted meeting context.'

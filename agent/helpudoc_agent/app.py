"""Compatibility shim for the legacy `helpudoc_agent.app` import path.

The FastAPI application factory and HTTP helpers live under `helpudoc_agent.api`.
Import `create_app` from `helpudoc_agent.api.app` in new code.
"""
from __future__ import annotations

from helpudoc_agent.api.app import create_app
from helpudoc_agent.api.attachment_processing import _docling_available
from helpudoc_agent.api.directives import _extract_directive_from_text
from helpudoc_agent.api.message_utils import _inject_host_datetime_context
from helpudoc_agent.api.tagged_context import (
    _append_tagged_file_guidance,
    _build_dashboard_runtime_guidance,
    _extract_html_outline_from_path,
    _filter_rag_prefetchable_tagged_files,
)
from helpudoc_agent.api.text_utils import _format_exception

__all__ = [
    "create_app",
    "_append_tagged_file_guidance",
    "_build_dashboard_runtime_guidance",
    "_docling_available",
    "_extract_directive_from_text",
    "_extract_html_outline_from_path",
    "_filter_rag_prefetchable_tagged_files",
    "_format_exception",
    "_inject_host_datetime_context",
]

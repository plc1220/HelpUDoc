"""Compatibility shim — HTML renderers moved to ``helpudoc_agent.tools.data.renderers``."""
from __future__ import annotations

from helpudoc_agent.tools.data.renderers import render_dashboard_html, render_summary_html

__all__ = ["render_dashboard_html", "render_summary_html"]

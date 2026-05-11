"""Filesystem anchors for the agent package and agent project root."""
from __future__ import annotations

from pathlib import Path

# helpudoc_agent/api/paths.py -> parents[1] == helpudoc_agent package dir
HELPUDOC_AGENT_DIR: Path = Path(__file__).resolve().parents[1]
# Directory that contains the `helpudoc_agent` package (historically `agent/`)
AGENT_PROJECT_ROOT: Path = HELPUDOC_AGENT_DIR.parent

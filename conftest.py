"""Pytest repo-wide configuration.

Ensures in-repo Python packages under ./agent are importable without installing.
"""

from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent
AGENT_DIR = (REPO_ROOT / "agent").resolve()

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))


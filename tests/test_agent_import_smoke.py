from __future__ import annotations

import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
AGENT_DIR = REPO_ROOT / "agent"


def test_agent_runtime_dependency_imports() -> None:
    script = AGENT_DIR / "scripts" / "smoke_import.py"
    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=str(AGENT_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    assert "AGENT_IMPORT_SMOKE_OK" in result.stdout

"""Prompt loading utilities (archived)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parent
AGENT_ROOT = PACKAGE_ROOT.parent
DEFAULT_PROMPT_DIR = AGENT_ROOT / "prompts"
PROMPT_ALIASES = {
    "general_assistant": "general/core",
}

# NOTE: This module and the prompts directory are archived. The runtime now uses
# skills under /skills via skills_registry. Keep this loader only for backwards
# compatibility with older references.


class PromptStore:
    """Simple file-based prompt registry."""

    def __init__(self, base_dir: Path | None = None):
        self.base_dir = base_dir or DEFAULT_PROMPT_DIR
        self.base_dir.mkdir(parents=True, exist_ok=True)

    @lru_cache(maxsize=128)
    def load(self, prompt_id: str) -> str:
        resolved_id = PROMPT_ALIASES.get(prompt_id, prompt_id)
        path = self.base_dir / f"{resolved_id}.md"
        if not path.exists():
            raise FileNotFoundError(
                f"Prompt '{prompt_id}' not found; expected file at {path}"
            )
        return path.read_text(encoding="utf-8")

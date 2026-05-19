"""Shared limits and defaults for workspace tools."""
from __future__ import annotations

MAX_SKILL_LOAD_ATTEMPTS_PER_TURN = 8
MAX_DISTINCT_SKILLS_PER_TURN = 3

# Gemini's backend enforces a minimum deadline for some operations (notably search).
MIN_GEMINI_TIMEOUT_S = 10

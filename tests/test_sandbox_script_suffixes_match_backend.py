"""The backend validator and the agent sandbox must agree on runnable scripts.

The validator rejects a script type at review time; the sandbox decides at run
time. If they drift, a skill either validates and then fails when run, or is
refused although the sandbox could run it.
"""
from __future__ import annotations

import re
from pathlib import Path

from agent.helpudoc_agent.sandbox_runner import SCRIPT_LANGUAGE_BY_SUFFIX

VALIDATOR = Path(__file__).resolve().parents[1] / "backend/src/services/governance/skillPackageValidator.ts"


def test_validator_suffixes_match_the_sandbox() -> None:
    source = VALIDATOR.read_text(encoding="utf-8")
    match = re.search(r"SANDBOX_SCRIPT_SUFFIXES = \[([^\]]*)\]", source)
    assert match, "SANDBOX_SCRIPT_SUFFIXES not found in skillPackageValidator.ts"
    backend = set(re.findall(r"'(\.[a-z]+)'", match.group(1)))
    assert backend == set(SCRIPT_LANGUAGE_BY_SUFFIX)

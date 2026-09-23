"""A signed version pin that cannot be verified must fail loudly, never silently.

Regression coverage for the incident where the skills PVC sync deleted
`.governed-versions/`, leaving every `skill_versions` row pointing at a materialized package that
no longer existed. `_load_governed_pin` correctly refused to fall back to the mutable registry, but
returned a bare `None`, which `load_skill` reported as "not found". The agent then answered without
the skill for 38 hours with no error anywhere.
"""
from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path

from agent.helpudoc_agent.skills_registry import (
    _load_governed_pin,
    find_skill_for_context,
    governed_pin_for,
)

VERSION_ID = "7fa3e378-6d8f-44c7-a53e-2cb4ec38097b"


def _skill_md(name: str = "research") -> str:
    return f"---\nname: {name}\ndescription: Test skill\ntools:\n  - google_search\n---\n\n# {name}\n"


def _manifest_hash(package_root: Path) -> str:
    """Mirror the backend's byte-ordered manifest hash."""
    manifest = []
    for candidate in sorted(package_root.rglob("*"), key=lambda item: item.as_posix()):
        if not candidate.is_file():
            continue
        content = candidate.read_bytes()
        manifest.append({
            "path": candidate.relative_to(package_root).as_posix(),
            "contentHash": hashlib.sha256(content).hexdigest(),
            "mode": candidate.stat().st_mode & 0o777,
            "sizeBytes": len(content),
        })
    encoded = json.dumps(manifest, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _materialize(skills_root: Path, *, extra_file: bool = False) -> str:
    package = skills_root / ".governed-versions" / "packages" / "research" / VERSION_ID
    package.mkdir(parents=True, exist_ok=True)
    (package / "SKILL.md").write_text(_skill_md(), encoding="utf-8")
    if extra_file:
        scripts = package / "scripts"
        scripts.mkdir(exist_ok=True)
        (scripts / "count_words.py").write_text("print(1)\n", encoding="utf-8")
    return _manifest_hash(package)


def _pin(manifest_hash: str) -> dict:
    return {
        "skill_version_pins": {
            "research": {
                "skillId": "s",
                "versionId": VERSION_ID,
                "semanticVersion": "1.0.2",
                "manifestHash": manifest_hash,
            }
        }
    }


def test_missing_materialized_package_logs_the_reason(tmp_path: Path, caplog) -> None:
    # Registry file exists, but the immutable package was destroyed.
    (tmp_path / "research").mkdir()
    (tmp_path / "research" / "SKILL.md").write_text(_skill_md(), encoding="utf-8")

    with caplog.at_level(logging.WARNING):
        resolved = _load_governed_pin(tmp_path, "research", _pin("a" * 64)["skill_version_pins"]["research"])

    assert resolved is None, "an unverifiable pin must never resolve"
    assert "package_not_materialized" in caplog.text
    assert "research" in caplog.text


def test_pin_never_falls_back_to_the_mutable_registry(tmp_path: Path) -> None:
    """The security property: a stranded pin must not silently run unreviewed content."""
    (tmp_path / "research").mkdir()
    (tmp_path / "research" / "SKILL.md").write_text(_skill_md(), encoding="utf-8")

    assert find_skill_for_context(tmp_path, "research", _pin("a" * 64)) is None
    # Without a pin the mutable default is still allowed.
    assert find_skill_for_context(tmp_path, "research", {"skill_version_pins": {}}) is not None


def test_manifest_hash_mismatch_logs_expected_and_computed(tmp_path: Path, caplog) -> None:
    _materialize(tmp_path)

    with caplog.at_level(logging.WARNING):
        resolved = _load_governed_pin(tmp_path, "research", _pin("b" * 64)["skill_version_pins"]["research"])

    assert resolved is None
    assert "manifest_hash_mismatch" in caplog.text
    assert "computed=" in caplog.text


def test_multi_file_package_resolves_under_byte_ordered_hash(tmp_path: Path) -> None:
    """`SKILL.md` beside a lowercase `scripts/` dir is where locale vs byte ordering diverged.

    The backend previously sorted manifest paths with `localeCompare`, which orders
    'scripts/count_words.py' before 'SKILL.md'; Python sorts the other way. Every multi-file
    package therefore failed verification.
    """
    manifest_hash = _materialize(tmp_path, extra_file=True)

    resolved = find_skill_for_context(tmp_path, "research", _pin(manifest_hash))

    assert resolved is not None, "a byte-ordered manifest hash must verify"
    assert resolved.skill_id == "research"


def test_governed_pin_for_distinguishes_pinned_from_absent() -> None:
    context = _pin("a" * 64)
    assert governed_pin_for(context, "research") is not None
    assert governed_pin_for(context, "docx") is None
    assert governed_pin_for({}, "research") is None
    assert governed_pin_for(None, "research") is None

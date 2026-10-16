from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from uuid import uuid4

from helpudoc_agent.skills_registry import (
    _compute_governed_manifest_hash,
    find_skill_for_context,
    is_skill_allowed,
    load_skills,
)
from helpudoc_agent.tools.workspace.builtins.skills import _pinned_only_skills


def _write_skill(root: Path, name: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: governed resolution test\n---\n\n# {name}\n",
        encoding="utf-8",
    )


def test_exact_governed_pin_resolves_only_when_manifest_matches(tmp_path: Path) -> None:
    skill_key = "test/governed"
    version_id = str(uuid4())
    _write_skill(tmp_path / skill_key, "Mutable default")
    version_root = tmp_path / ".governed-versions" / "packages" / skill_key / version_id
    _write_skill(version_root, "Exact governed version")
    manifest_hash = _compute_governed_manifest_hash(version_root)
    assert manifest_hash

    context = {
        "skill_version_pins": {
            skill_key: {
                "skillId": "stable-skill-id",
                "versionId": version_id,
                "semanticVersion": "1.2.3",
                "manifestHash": manifest_hash,
            }
        }
    }
    resolved = find_skill_for_context(tmp_path, skill_key, context)
    assert resolved is not None
    assert resolved.skill_id == skill_key
    assert resolved.name == "Exact governed version"

    context["skill_version_pins"][skill_key]["manifestHash"] = "0" * 64
    assert find_skill_for_context(tmp_path, skill_key, context) is None


def test_missing_exact_pin_never_falls_back_to_default(tmp_path: Path) -> None:
    skill_key = "test/governed"
    _write_skill(tmp_path / skill_key, "Mutable default")
    context = {
        "skill_version_pins": {
            skill_key: {
                "skillId": "stable-skill-id",
                "versionId": str(uuid4()),
                "semanticVersion": "1.2.3",
                "manifestHash": "1" * 64,
            }
        }
    }
    assert find_skill_for_context(tmp_path, skill_key, context) is None


def test_governed_pin_resolves_display_name_to_exact_version(tmp_path: Path) -> None:
    skill_key = "test/governed"
    version_id = str(uuid4())
    _write_skill(tmp_path / skill_key, "Mutable default")
    version_root = tmp_path / ".governed-versions" / "packages" / skill_key / version_id
    _write_skill(version_root, "Pinned display name")
    manifest_hash = _compute_governed_manifest_hash(version_root)
    assert manifest_hash
    context = {
        "workspace_mode": "published_read_only",
        "skill_version_pins": {
            skill_key: {
                "skillId": "stable-skill-id",
                "versionId": version_id,
                "semanticVersion": "1.2.3",
                "manifestHash": manifest_hash,
            }
        },
    }

    resolved = find_skill_for_context(tmp_path, "Pinned display name", context)
    assert resolved is not None
    assert resolved.skill_id == skill_key
    assert resolved.name == "Pinned display name"


def test_governed_pin_does_not_fall_back_by_mutable_display_name(tmp_path: Path) -> None:
    skill_key = "test/governed"
    _write_skill(tmp_path / skill_key, "Mutable display name")
    context = {
        "workspace_mode": "published_read_only",
        "skill_version_pins": {
            skill_key: {
                "skillId": "stable-skill-id",
                "versionId": str(uuid4()),
                "semanticVersion": "1.2.3",
                "manifestHash": "1" * 64,
            }
        },
    }

    assert find_skill_for_context(tmp_path, "Mutable display name", context) is None


def test_private_draft_pin_resolves_without_a_mutable_default(tmp_path: Path) -> None:
    """A new-skill draft has no folder under ``skills/`` at all.

    The backend materializes it beside the approved packages and signs the draft
    revision id as the version. Nothing else on disk names it.
    """
    skill_key = "my-private-skill"
    revision_id = str(uuid4())
    package_root = tmp_path / ".governed-versions" / "packages" / skill_key / revision_id
    _write_skill(package_root, "My private skill")
    manifest_hash = _compute_governed_manifest_hash(package_root)
    assert manifest_hash

    context = {
        "skill_allow_ids": [skill_key],
        "skill_version_pins": {
            skill_key: {
                "skillId": "draft-1",
                "versionId": revision_id,
                "semanticVersion": "0.0.0-draft",
                "manifestHash": manifest_hash,
            }
        },
    }
    resolved = find_skill_for_context(tmp_path, skill_key, context)
    assert resolved is not None
    assert resolved.skill_id == skill_key
    assert resolved.name == "My private skill"

    # The dot-directory keeps it out of the mutable catalogue, so it stays
    # invisible to anyone whose token does not carry the pin.
    assert [skill.skill_id for skill in load_skills(tmp_path)] == []


def test_list_skills_surfaces_a_pin_that_has_no_folder(tmp_path: Path) -> None:
    skill_key = "my-private-skill"
    revision_id = str(uuid4())
    _write_skill(tmp_path / "research", "Research")
    package_root = tmp_path / ".governed-versions" / "packages" / skill_key / revision_id
    _write_skill(package_root, "My private skill")
    manifest_hash = _compute_governed_manifest_hash(package_root)

    context = {
        "skill_allow_ids": ["research", skill_key],
        "skill_version_pins": {
            skill_key: {
                "skillId": "draft-1",
                "versionId": revision_id,
                "semanticVersion": "0.0.0-draft",
                "manifestHash": manifest_hash,
            }
        },
    }
    listed = [skill for skill in load_skills(tmp_path) if is_skill_allowed(skill, context)]
    assert [skill.skill_id for skill in listed] == ["research"]

    listed.extend(_pinned_only_skills(tmp_path, listed, context))
    assert sorted(skill.skill_id for skill in listed) == [skill_key, "research"]

    # Without the pin the id is allowed but unresolvable, so it must not appear.
    unpinned = [skill for skill in load_skills(tmp_path) if is_skill_allowed(skill, context)]
    unpinned.extend(_pinned_only_skills(tmp_path, unpinned, {"skill_allow_ids": ["research", skill_key]}))
    assert [skill.skill_id for skill in unpinned] == ["research"]


# Shared with backend/tests/skillPackageStore.test.ts, which asserts that the
# backend hashes these files to the same value.
PARITY_FILES = {
    "SKILL.md": "---\nname: Manifest parity\ndescription: cross-runtime fixture\n---\n\n# Manifest parity\n",
    "references/guide.md": "# Guide\n",
    "scripts/run.js": "console.log(24);\n",
}
PARITY_MANIFEST_HASH = "291d4b7acf8e5cc6d88af50f822b0237d90f49e6b54a0ec165408e2a4da64717"
# The backend sorts with `localeCompare`, which puts `SKILL.md` last.
BACKEND_ORDER = ["references/guide.md", "scripts/run.js", "SKILL.md"]


def _write_parity_package(tmp_path: Path, *, sidecar: bool = True) -> tuple[Path, dict]:
    skill_key = "new-skill-parity"
    revision_id = str(uuid4())
    package_root = tmp_path / ".governed-versions" / "packages" / skill_key / revision_id
    for relative, content in PARITY_FILES.items():
        target = package_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        target.chmod(0o644)
    if sidecar:
        manifest = [
            {
                "path": relative,
                "contentHash": hashlib.sha256(PARITY_FILES[relative].encode("utf-8")).hexdigest(),
                "mode": 0o644,
                "sizeBytes": len(PARITY_FILES[relative].encode("utf-8")),
            }
            for relative in BACKEND_ORDER
        ]
        # The same bytes as the backend's `JSON.stringify`.
        text = json.dumps(manifest, separators=(",", ":"), ensure_ascii=False)
        package_root.with_name(f"{revision_id}.manifest.json").write_text(text, encoding="utf-8")
    context = {
        "skill_allow_ids": [skill_key],
        "skill_version_pins": {
            skill_key: {
                "skillId": "draft-parity",
                "versionId": revision_id,
                "semanticVersion": "0.0.0-draft",
                "manifestHash": PARITY_MANIFEST_HASH,
            }
        },
    }
    return package_root, context


def test_sidecar_text_hashes_to_the_backend_manifest_hash(tmp_path: Path) -> None:
    package_root, _ = _write_parity_package(tmp_path)
    sidecar = package_root.with_name(f"{package_root.name}.manifest.json").read_bytes()
    assert hashlib.sha256(sidecar).hexdigest() == PARITY_MANIFEST_HASH
    # Code-point order differs from the backend's, which is the bug the sidecar fixes.
    assert _compute_governed_manifest_hash(package_root) != PARITY_MANIFEST_HASH


def test_multi_file_draft_resolves_through_its_manifest_sidecar(tmp_path: Path) -> None:
    _, context = _write_parity_package(tmp_path)
    resolved = find_skill_for_context(tmp_path, "new-skill-parity", context)
    assert resolved is not None
    assert resolved.skill_id == "new-skill-parity"
    assert resolved.name == "Manifest parity"
    assert [skill.skill_id for skill in _pinned_only_skills(tmp_path, [], context)] == ["new-skill-parity"]


def test_multi_file_draft_without_a_sidecar_stays_unresolved(tmp_path: Path, caplog) -> None:
    _, context = _write_parity_package(tmp_path, sidecar=False)
    with caplog.at_level(logging.WARNING, logger="helpudoc_agent.skills_registry"):
        assert find_skill_for_context(tmp_path, "new-skill-parity", context) is None
    assert "failed its manifest check" in caplog.text
    assert "new-skill-parity" in caplog.text


def test_sidecar_rejects_a_changed_file(tmp_path: Path) -> None:
    package_root, context = _write_parity_package(tmp_path)
    (package_root / "scripts" / "run.js").write_text("console.log(25);\n", encoding="utf-8")
    assert find_skill_for_context(tmp_path, "new-skill-parity", context) is None


def test_sidecar_rejects_an_extra_file(tmp_path: Path) -> None:
    package_root, context = _write_parity_package(tmp_path)
    (package_root / "scripts" / "extra.js").write_text("// not signed\n", encoding="utf-8")
    assert find_skill_for_context(tmp_path, "new-skill-parity", context) is None


def test_sidecar_rejects_a_missing_file(tmp_path: Path) -> None:
    package_root, context = _write_parity_package(tmp_path)
    (package_root / "references" / "guide.md").unlink()
    assert find_skill_for_context(tmp_path, "new-skill-parity", context) is None


def test_sidecar_rejects_a_changed_mode(tmp_path: Path) -> None:
    package_root, context = _write_parity_package(tmp_path)
    (package_root / "scripts" / "run.js").chmod(0o755)
    assert find_skill_for_context(tmp_path, "new-skill-parity", context) is None


def test_sidecar_that_does_not_match_the_signed_hash_is_ignored(tmp_path: Path) -> None:
    package_root, context = _write_parity_package(tmp_path)
    sidecar = package_root.with_name(f"{package_root.name}.manifest.json")
    # Rewrite the manifest to describe a tampered file: it now matches the disk but
    # no longer hashes to the signed value.
    (package_root / "scripts" / "run.js").write_text("console.log(25);\n", encoding="utf-8")
    entries = json.loads(sidecar.read_text(encoding="utf-8"))
    for entry in entries:
        if entry["path"] == "scripts/run.js":
            entry["contentHash"] = hashlib.sha256(b"console.log(25);\n").hexdigest()
    sidecar.write_text(json.dumps(entries, separators=(",", ":")), encoding="utf-8")
    assert find_skill_for_context(tmp_path, "new-skill-parity", context) is None

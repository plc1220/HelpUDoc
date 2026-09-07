from __future__ import annotations

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

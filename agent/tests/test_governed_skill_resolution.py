from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from helpudoc_agent.skills_registry import (
    _compute_governed_manifest_hash,
    find_skill_for_context,
)


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


def test_personal_skills_are_discovered_only_with_owner_pins(tmp_path: Path) -> None:
    from helpudoc_agent.skills_registry import load_context_skills
    key = f"personal/{uuid4()}"
    version = str(uuid4())
    root = tmp_path / ".governed-versions" / "packages" / key / version
    _write_skill(root, "My personal skill")
    pin = {"versionId": version, "manifestHash": _compute_governed_manifest_hash(root)}
    owner = {"skill_allow_ids": [key], "skill_version_pins": {key: pin}}
    assert [skill.skill_id for skill in load_context_skills(tmp_path, owner)] == [key]
    assert load_context_skills(tmp_path, {"skill_allow_ids": [], "skill_version_pins": {}}) == []
    assert find_skill_for_context(tmp_path, key, {}) is None


def test_blocked_package_cannot_load_by_key_or_name_with_existing_pin(tmp_path: Path) -> None:
    from helpudoc_agent.skills_registry import skill_block_paths, load_context_skills
    key = f"personal/{uuid4()}"
    version = str(uuid4())
    root = tmp_path / ".governed-versions" / "packages" / key / version
    _write_skill(root, "Blocked name")
    manifest = _compute_governed_manifest_hash(root)
    context = {"skill_allow_ids": [key], "skill_version_pins": {key: {"versionId": version, "manifestHash": manifest}}}
    marker = Path(skill_block_paths(tmp_path, key, manifest)[1])
    marker.parent.mkdir(parents=True)
    marker.write_text("Anomaly")
    assert find_skill_for_context(tmp_path, key, context) is None
    assert find_skill_for_context(tmp_path, "Blocked name", context) is None
    assert load_context_skills(tmp_path, context) == []


def test_personal_pin_rejects_path_traversal(tmp_path: Path) -> None:
    from helpudoc_agent.skills_registry import _load_governed_pin
    assert _load_governed_pin(tmp_path, "../escape", {"versionId": str(uuid4()), "manifestHash": "a" * 64}) is None


def test_workspace_sync_never_copies_private_storage(tmp_path: Path) -> None:
    from helpudoc_agent.skills_registry import sync_skills_to_workspace
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    _write_skill(source / "team-skill", "Team skill")
    private = source / ".governed-versions" / "packages" / "personal" / str(uuid4()) / str(uuid4())
    _write_skill(private, "Private instructions")
    leaked = workspace / "skills" / ".governed-versions" / "old-copy"
    _write_skill(leaked, "Old private copy")
    sync_skills_to_workspace(source, workspace)
    assert (workspace / "skills" / "team-skill" / "SKILL.md").is_file()
    assert not (workspace / "skills" / ".governed-versions").exists()

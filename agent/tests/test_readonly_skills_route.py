"""The agent may read the shared skill catalog at /skills/ but never change it.

A chat on aiengine-dev asked the agent to convert a Word document into skills, and the
agent wrote ten folders into /skills/. The backend's startup backfill then published
them to every user as governed skills with no creator.
"""
import asyncio

from deepagents.backends import CompositeBackend, FilesystemBackend

from helpudoc_agent.runtime.agent_registry import ReadOnlySkillsBackend


def _catalog(tmp_path):
    skills = tmp_path / "skills"
    (skills / "tos-analysis").mkdir(parents=True)
    (skills / "tos-analysis" / "SKILL.md").write_text("---\nname: tos-analysis\n---\nRead me.", encoding="utf-8")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    return skills, workspace


def _composite(skills, workspace) -> CompositeBackend:
    # Same shape as AgentRegistry's make_backend.
    return CompositeBackend(
        default=FilesystemBackend(root_dir=str(workspace), virtual_mode=True),
        routes={"/skills/": ReadOnlySkillsBackend(root_dir=str(skills), virtual_mode=True)},
    )


def test_skill_files_stay_readable(tmp_path):
    skills, workspace = _catalog(tmp_path)
    backend = _composite(skills, workspace)

    assert "Read me." in str(backend.read("/skills/tos-analysis/SKILL.md").file_data)
    listed = str(backend.ls("/skills/"))
    assert "tos-analysis" in listed


def test_writes_into_the_catalog_are_refused_and_change_nothing(tmp_path):
    skills, workspace = _catalog(tmp_path)
    backend = _composite(skills, workspace)

    new_skill = backend.write("/skills/rating-escalation/SKILL.md", "---\nname: rating-escalation\n---\n")
    edited = backend.edit("/skills/tos-analysis/SKILL.md", "Read me.", "Changed.")
    uploaded = backend.upload_files([("/skills/tos-analysis/scripts/run.py", b"print(1)")])

    for error in (new_skill.error, edited.error, uploaded[0].error):
        assert error and "read-only" in error and "Skill Creator" in error
    assert "/skills/rating-escalation/SKILL.md" in new_skill.error
    assert not (skills / "rating-escalation").exists()
    assert not (skills / "tos-analysis" / "scripts").exists()
    assert (skills / "tos-analysis" / "SKILL.md").read_text(encoding="utf-8").endswith("Read me.")


def test_async_writes_used_by_the_file_tools_are_refused(tmp_path):
    skills, workspace = _catalog(tmp_path)
    backend = _composite(skills, workspace)

    async def scenario():
        return (
            await backend.awrite("/skills/new-skill/SKILL.md", "x"),
            await backend.aedit("/skills/tos-analysis/SKILL.md", "Read me.", "Changed."),
            await backend.aupload_files([("/skills/new-skill/a.txt", b"x")]),
        )

    written, edited, uploaded = asyncio.run(scenario())

    assert written.error and edited.error and uploaded[0].error
    assert not (skills / "new-skill").exists()


def test_workspace_writes_are_unaffected(tmp_path):
    skills, workspace = _catalog(tmp_path)
    backend = _composite(skills, workspace)

    result = backend.write("/notes/skill-ideas.md", "Draft ideas")

    assert not result.error
    assert (workspace / "notes" / "skill-ideas.md").read_text(encoding="utf-8") == "Draft ideas"


# -- ScopedSkillsBackend: only this user's skills, read from the package they load ----

from pathlib import Path
from uuid import uuid4

from helpudoc_agent.runtime.agent_registry import ScopedSkillsBackend
from helpudoc_agent.skills_registry import _compute_governed_manifest_hash
from helpudoc_agent.state import WorkspaceState


def _skill(root: Path, name: str, files: dict[str, str] | None = None) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(f"---\nname: {name}\ndescription: scoped route test\n---\n\n# {name}\n", encoding="utf-8")
    for relative, content in (files or {}).items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return root


def _pin(skills: Path, key: str, files: dict[str, str]) -> dict:
    version_id = str(uuid4())
    root = _skill(skills / ".governed-versions" / "packages" / key / version_id, key, files)
    return {"versionId": version_id, "manifestHash": _compute_governed_manifest_hash(root)}


def _scoped(tmp_path: Path, context: dict) -> tuple[CompositeBackend, Path]:
    skills = tmp_path / "skills"
    _skill(skills / "tos-analysis", "tos-analysis", {"references/guide.md": "ToS guide"})
    _skill(skills / "secret-team-skill", "secret-team-skill", {"references/plan.md": "Other team's plan"})
    _skill(skills / "data", "data", {"references/hub.md": "Data hub"})
    _skill(skills / "data" / "analyze", "data/analyze", {"references/private.md": "Analyze only"})
    _skill(skills / "data" / "query", "data/query", {"references/sql.md": "Query guide"})
    _skill(skills / "pinned-skill", "pinned-skill", {"references/ref.md": "DEFAULT version"})
    pins = {
        "pinned-skill": _pin(skills, "pinned-skill", {"references/ref.md": "PINNED version"}),
        "my-draft": _pin(skills, "my-draft", {"references/draft.md": "Draft notes"}),
    }
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state = WorkspaceState(workspace_id="scoped-test", root_path=workspace)
    state.context.update({"skill_version_pins": pins, **context})
    backend = CompositeBackend(
        default=FilesystemBackend(root_dir=str(workspace), virtual_mode=True),
        routes={"/skills/": ScopedSkillsBackend(workspace_state=state, root_dir=str(skills), virtual_mode=True)},
    )
    return backend, skills


ALLOWED = {"skill_allow_ids": ["tos-analysis", "data", "data/query", "pinned-skill", "my-draft"]}


def _paths(entries) -> set[str]:
    return {entry["path"] for entry in entries or []}


def test_listing_shows_only_allowed_skills_and_no_internal_folders(tmp_path):
    backend, _ = _scoped(tmp_path, ALLOWED)

    top = _paths(backend.ls("/skills/").entries)

    assert top == {"/skills/tos-analysis/", "/skills/data/", "/skills/pinned-skill/", "/skills/my-draft/"}
    data = _paths(backend.ls("/skills/data/").entries)
    assert "/skills/data/query/" in data and "/skills/data/references/" in data
    assert not any("analyze" in path for path in data)


def test_other_teams_skills_and_governed_versions_read_as_not_found(tmp_path):
    backend, _ = _scoped(tmp_path, ALLOWED)

    assert "ToS guide" in str(backend.read("/skills/tos-analysis/references/guide.md").file_data)
    for path in (
        "/skills/secret-team-skill/references/plan.md",
        "/skills/data/analyze/references/private.md",
        "/skills/.governed-versions/packages/my-draft",
        "/skills/tos-analysis/../secret-team-skill/SKILL.md",
    ):
        result = backend.read(path)
        assert result.error and "not found" in result.error, path
    assert backend.ls("/skills/secret-team-skill/").error
    assert backend.download_files(["/skills/secret-team-skill/references/plan.md"])[0].error == "file_not_found"


def test_pinned_version_and_draft_read_their_own_package(tmp_path):
    backend, _ = _scoped(tmp_path, ALLOWED)

    assert "PINNED version" in str(backend.read("/skills/pinned-skill/references/ref.md").file_data)
    assert "Draft notes" in str(backend.read("/skills/my-draft/references/draft.md").file_data)


def test_search_from_the_root_covers_only_allowed_skills(tmp_path):
    backend, _ = _scoped(tmp_path, ALLOWED)

    globbed = _paths(backend.glob("**/*.md", "/skills/").matches)
    # grep is a literal search in deepagents, not a regex.
    version_hits = {match["path"] for match in backend.grep("version", "/skills/").matches}
    hidden_hits = [backend.grep(text, "/skills/").matches for text in ("Other team's plan", "Analyze only")]

    assert not any("secret-team-skill" in path or "analyze" in path or ".governed" in path for path in globbed), globbed
    assert "/skills/tos-analysis/references/guide.md" in globbed
    assert version_hits == {"/skills/pinned-skill/references/ref.md"}  # the pinned copy, not DEFAULT
    assert hidden_hits == [[], []]


def test_scoped_route_still_refuses_writes(tmp_path):
    backend, skills = _scoped(tmp_path, ALLOWED)

    assert backend.write("/skills/tos-analysis/new.md", "x").error
    assert backend.write("/skills/brand-new/SKILL.md", "x").error
    assert not (skills / "brand-new").exists()


def test_without_an_allow_list_every_catalog_skill_is_visible(tmp_path):
    # Local runs carry no skill_allow_ids; is_skill_allowed treats that as unrestricted.
    backend, _ = _scoped(tmp_path, {})

    top = _paths(backend.ls("/skills/").entries)

    assert {"/skills/tos-analysis/", "/skills/secret-team-skill/", "/skills/data/"} <= top
    assert not any(".governed" in path for path in top)


def test_an_empty_allow_list_shows_no_skills(tmp_path):
    backend, _ = _scoped(tmp_path, {"skill_allow_ids": []})

    assert backend.ls("/skills/").error
    assert backend.read("/skills/tos-analysis/SKILL.md").error

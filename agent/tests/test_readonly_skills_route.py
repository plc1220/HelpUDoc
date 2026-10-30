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

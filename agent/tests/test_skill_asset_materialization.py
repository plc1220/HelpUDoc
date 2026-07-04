from types import SimpleNamespace

from deepagents.backends import CompositeBackend, FilesystemBackend

from helpudoc_agent.tools.workspace.builtins.skills import (
    _format_skill_asset_manifest,
    _skill_asset_backend_paths,
)


def test_skill_asset_paths_use_backend_route_and_format_manifest(tmp_path):
    skills_root = tmp_path / "skills" / "frontend-slides"
    skills_root.mkdir(parents=True)
    (skills_root / "SKILL.md").write_text("---\nname: frontend-slides\n---\n", encoding="utf-8")
    (skills_root / "viewport-base.css").write_text(".deck { width: 100%; }\n", encoding="utf-8")
    (skills_root / "html-template.md").write_text("# Template\n", encoding="utf-8")
    (skills_root / "bold-template-pack").mkdir()
    (skills_root / "bold-template-pack" / "selection-index.json").write_text("[]\n", encoding="utf-8")

    skill = SimpleNamespace(skill_id="frontend-slides", path=skills_root / "SKILL.md")

    asset_paths = _skill_asset_backend_paths(skill)
    manifest = _format_skill_asset_manifest(skill.skill_id, asset_paths)

    assert "/skills/frontend-slides/viewport-base.css" in asset_paths
    assert "/skills/frontend-slides/html-template.md" in asset_paths
    assert "/skills/frontend-slides/bold-template-pack/selection-index.json" in asset_paths
    assert "/skills/frontend-slides/SKILL.md" not in asset_paths
    assert "available through the skill backend" in manifest
    assert "Do not use web search to fetch these bundled assets" in manifest
    assert "/skills/frontend-slides/viewport-base.css" in manifest


def test_skills_route_reads_configured_skills_root(tmp_path):
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "frontend-slides"
    skill_dir.mkdir(parents=True)
    (skill_dir / "viewport-base.css").write_text(".deck { width: 100%; }\n", encoding="utf-8")

    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    backend = CompositeBackend(
        default=FilesystemBackend(root_dir=str(workspace_root), virtual_mode=True),
        routes={"/skills/": FilesystemBackend(root_dir=str(skills_root), virtual_mode=True)},
    )

    result = backend.read("/skills/frontend-slides/viewport-base.css")

    assert result.error is None
    assert result.file_data is not None
    assert ".deck { width: 100%; }" in result.file_data["content"]

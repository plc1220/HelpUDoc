from types import SimpleNamespace

import fitz
from PIL import Image

from helpudoc_agent.configuration import ToolConfig
from helpudoc_agent.tools_and_schemas import ToolFactory


class SettingsStub:
    def __init__(self, tools):
        self._tools = tools

    def get_tool(self, name: str) -> ToolConfig:
        return self._tools[name]


def test_build_tools_skips_missing_entrypoint(monkeypatch):
    factory = ToolFactory(
        SettingsStub(
            {
                "missing_tool": ToolConfig(
                    name="missing_tool",
                    entrypoint="helpudoc_agent.arxiv_tools:build_arxiv_tools",
                )
            }
        ),
        source_tracker=SimpleNamespace(),
        gemini_manager=SimpleNamespace(),
    )

    def fake_import_module(module_path: str):
        raise ModuleNotFoundError(f"No module named '{module_path}'", name=module_path)

    monkeypatch.setattr("helpudoc_agent.tools_and_schemas.import_module", fake_import_module)

    built = factory.build_tools(["missing_tool"], workspace_state=SimpleNamespace())

    assert built == []


def test_create_pdf_from_images_builds_one_page_per_image(tmp_path):
    for index, color in enumerate(("red", "green", "blue"), start=1):
        Image.new("RGB", (80 + index, 120 + index), color=color).save(tmp_path / f"page-{index}.png")

    factory = ToolFactory(
        SettingsStub(
            {
                "create_pdf_from_images": ToolConfig(
                    name="create_pdf_from_images",
                    kind="builtin",
                )
            }
        ),
        source_tracker=SimpleNamespace(),
        gemini_manager=SimpleNamespace(),
    )
    workspace = SimpleNamespace(root_path=tmp_path, workspace_id="ws-1", context={})
    tool = factory.build_tools(["create_pdf_from_images"], workspace_state=workspace)[0]

    result = tool.invoke(
        {
            "image_paths": ["page-1.png", "page-2.png", "page-3.png"],
            "output_path": "/stitched.pdf",
        }
    )

    assert "Created PDF /stitched.pdf with 3 pages" in result
    pdf = fitz.open(tmp_path / "stitched.pdf")
    try:
        assert pdf.page_count == 3
    finally:
        pdf.close()


def test_load_skill_limits_runaway_skill_switches(tmp_path):
    for name in ("pdf", "data", "general", "image"):
        skill_dir = tmp_path / name
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            f"---\nname: {name}\ntools:\n  - request_clarification\n---\n\n# {name}\n",
            encoding="utf-8",
        )

    settings = SettingsStub(
        {
            "load_skill": ToolConfig(
                name="load_skill",
                kind="builtin",
            )
        }
    )
    settings.backend = SimpleNamespace(skills_root=tmp_path)
    factory = ToolFactory(settings, source_tracker=SimpleNamespace(), gemini_manager=SimpleNamespace())
    workspace = SimpleNamespace(root_path=tmp_path, workspace_id="ws-1", context={})
    tool = factory.build_tools(["load_skill"], workspace_state=workspace)[0]

    assert "Loaded skill: pdf" in tool.invoke({"skill_id": "pdf"})
    assert "Loaded skill: data" in tool.invoke({"skill_id": "data"})
    assert "Loaded skill: general" in tool.invoke({"skill_id": "general"})
    blocked = tool.invoke({"skill_id": "image"})

    assert "Skill switch limit reached" in blocked
    assert workspace.context["active_skill"] == "general"

from types import SimpleNamespace

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

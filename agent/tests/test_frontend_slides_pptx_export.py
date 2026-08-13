import base64
import json
from pathlib import Path
from types import SimpleNamespace

from helpudoc_agent.sandbox_runner import run_skill_python_script_locally
from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools.workspace.builtins.skills import build_run_skill_python_script_tool


ONE_PIXEL_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


def test_frontend_slides_blocks_inline_sandbox_execution(tmp_path):
    repo_root = Path(__file__).resolve().parents[2]
    workspace = WorkspaceState(workspace_id="slides-inline-block", root_path=tmp_path)
    workspace.context["active_skill"] = "frontend-slides"
    settings = SimpleNamespace(
        backend=SimpleNamespace(
            skills_root=repo_root / "skills",
            plugins_root=repo_root / "plugins",
        )
    )
    tool = build_run_skill_python_script_tool(settings, workspace)

    result = tool.invoke(
        {
            "inline_code": "print('render preview')",
            "output_paths": ["preview.html"],
        }
    )

    payload = json.loads(result)
    assert payload["errorCode"] == "FRONTEND_SLIDES_INLINE_SANDBOX_BLOCKED"
    assert not (tmp_path / "sandbox-runs").exists()


def test_frontend_slides_pptx_export_copies_workspace_output_and_declares_artifact(tmp_path):
    repo_root = Path(__file__).resolve().parents[2]
    workspace = WorkspaceState(workspace_id="pptx-export-test", root_path=tmp_path)
    workspace.context["active_skill"] = "frontend-slides"

    (tmp_path / "demo-deck.html").write_text(
        '<!doctype html><html><body><section class="slide active">Demo</section></body></html>',
        encoding="utf-8",
    )
    screenshots_dir = tmp_path / "screenshots"
    screenshots_dir.mkdir()
    (screenshots_dir / "slide-001.png").write_bytes(base64.b64decode(ONE_PIXEL_PNG))

    result = run_skill_python_script_locally(
        skills_root=repo_root / "skills",
        workspace_state=workspace,
        script_name="export-pptx",
        args=[
            "demo-deck.html",
            "demo-deck.pptx",
            "--screenshots-dir",
            str(screenshots_dir),
        ],
    )

    pptx_path = tmp_path / "demo-deck.pptx"
    assert pptx_path.exists()
    assert pptx_path.stat().st_size > 0
    assert result.output_files
    assert result.output_files[0].path.endswith("/out/tool_artifacts.json")

    artifact_payload_path = tmp_path / result.output_files[0].path.lstrip("/")
    payload = json.loads(artifact_payload_path.read_text(encoding="utf-8"))
    assert payload["files"][0]["path"] == "demo-deck.pptx"
    assert payload["files"][0]["mimeType"] == "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    assert payload["files"][0]["metadata"]["slideCount"] == 1


def test_frontend_slides_pptx_export_accepts_virtual_absolute_workspace_paths(tmp_path):
    repo_root = Path(__file__).resolve().parents[2]
    workspace = WorkspaceState(workspace_id="pptx-export-absolute-test", root_path=tmp_path)
    workspace.context["active_skill"] = "frontend-slides"

    (tmp_path / "demo-deck.html").write_text(
        '<!doctype html><html><body><section class="slide active">Demo</section></body></html>',
        encoding="utf-8",
    )
    screenshots_dir = tmp_path / "screenshots"
    screenshots_dir.mkdir()
    (screenshots_dir / "slide-001.png").write_bytes(base64.b64decode(ONE_PIXEL_PNG))

    run_skill_python_script_locally(
        skills_root=repo_root / "skills",
        workspace_state=workspace,
        script_name="export-pptx",
        input_paths=["/demo-deck.html"],
        args=[
            "/demo-deck.html",
            "/demo-deck.pptx",
            "--screenshots-dir",
            str(screenshots_dir),
        ],
    )

    assert (tmp_path / "demo-deck.pptx").exists()

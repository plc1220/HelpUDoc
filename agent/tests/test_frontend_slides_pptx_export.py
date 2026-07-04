import base64
import json
from pathlib import Path

from helpudoc_agent.sandbox_runner import run_skill_python_script_locally
from helpudoc_agent.state import WorkspaceState


ONE_PIXEL_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


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

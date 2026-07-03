from __future__ import annotations

import base64
import subprocess
import sys
from pathlib import Path
from zipfile import ZipFile


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPORT_SCRIPT = REPO_ROOT / "skills" / "frontend-slides" / "scripts" / "export-pptx.py"

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


def test_export_pptx_assembles_screenshots_into_valid_deck(tmp_path: Path) -> None:
    html = tmp_path / "deck.html"
    html.write_text("<html><body><section class='slide'>One</section></body></html>", encoding="utf-8")

    screenshots = tmp_path / "screenshots"
    screenshots.mkdir()
    (screenshots / "slide-001.png").write_bytes(PNG_1X1)
    (screenshots / "slide-002.png").write_bytes(PNG_1X1)

    output = tmp_path / "deck.pptx"

    result = subprocess.run(
        [
            sys.executable,
            str(EXPORT_SCRIPT),
            str(html),
            str(output),
            "--screenshots-dir",
            str(screenshots),
        ],
        check=True,
        text=True,
        capture_output=True,
    )

    assert "Exported 2 slides" in result.stdout
    assert output.exists()

    with ZipFile(output) as pptx:
        names = set(pptx.namelist())
        assert "ppt/slides/slide1.xml" in names
        assert "ppt/slides/slide2.xml" in names
        assert "ppt/slides/slide3.xml" not in names
        assert "ppt/media/image1.png" in names

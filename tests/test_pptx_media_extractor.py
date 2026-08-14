from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import zipfile


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "skills" / "pptx" / "scripts" / "extract_pptx_media.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("extract_pptx_media", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_extract_pptx_media_categorizes_images_and_writes_manifest(tmp_path: Path) -> None:
    source = tmp_path / "campaign.pptx"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("ppt/media/image1.png", b"png-image")
        archive.writestr("ppt/media/image2.svg", b"<svg></svg>")
        archive.writestr("ppt/media/video1.mp4", b"not-an-image")
        archive.writestr("docProps/core.xml", b"<core/>")

    output_root = tmp_path / "workspace-output"
    module = _load_module()
    manifest = module.extract_pptx_media(source, output_root, Path("extracted_images"))

    assert manifest["imageCount"] == 2
    assert manifest["categories"] == {"raster": 1, "vector": 1}
    assert (output_root / "extracted_images" / "raster" / "image1.png").read_bytes() == b"png-image"
    assert (output_root / "extracted_images" / "vector" / "image2.svg").read_bytes() == b"<svg></svg>"
    assert not (output_root / "extracted_images" / "video1.mp4").exists()

    persisted = json.loads((output_root / "extracted_images" / "manifest.json").read_text())
    assert persisted["imageCount"] == 2
    assert {item["sourceMember"] for item in persisted["files"]} == {
        "ppt/media/image1.png",
        "ppt/media/image2.svg",
    }

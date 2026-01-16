import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image

from paper2slides.utils.export_service import ExportService


class SlideAssetsPPTXTest(unittest.TestCase):
    def test_create_editable_pptx_from_slide_assets(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            slide_dir = root / "slides-slide-01"
            assets_dir = slide_dir / "assets"
            assets_dir.mkdir(parents=True, exist_ok=True)

            background_path = slide_dir / "background.png"
            Image.new("RGB", (640, 360), (240, 240, 240)).save(background_path)

            asset_path = assets_dir / "asset-001.png"
            Image.new("RGB", (200, 100), (120, 120, 120)).save(asset_path)

            layout = {
                "version": "1",
                "canvas": {"width": 640, "height": 360},
                "background": "background.png",
                "elements": [
                    {
                        "type": "text",
                        "bbox": [40, 30, 600, 90],
                        "text": "Editable title",
                        "align": "left",
                        "font_size": 24,
                        "bold": True,
                        "color_rgb": [0, 0, 0],
                    },
                    {
                        "type": "image",
                        "bbox": [40, 110, 240, 210],
                        "asset_path": "assets/asset-001.png",
                    },
                    {
                        "type": "table",
                        "bbox": [260, 110, 600, 210],
                        "cells": [["A", "B"], ["1", "2"]],
                    },
                ],
            }

            layout_path = slide_dir / "layout.json"
            with open(layout_path, "w", encoding="utf-8") as handle:
                json.dump(layout, handle, ensure_ascii=False, indent=2)

            output_pptx = root / "out.pptx"
            ExportService.create_editable_pptx_from_slide_assets(
                [str(slide_dir)], str(output_pptx)
            )

            self.assertTrue(output_pptx.exists())
            with zipfile.ZipFile(output_pptx, "r") as archive:
                slide_xml = archive.read("ppt/slides/slide1.xml").decode("utf-8")
            self.assertIn("Editable title", slide_xml)


if __name__ == "__main__":
    unittest.main()

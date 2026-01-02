"""
Export utilities for Paper2Slides outputs.
"""
import io
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


class ExportService:
    """Service for exporting slides to PPTX."""

    @staticmethod
    def create_pptx_from_images(image_paths: List[str], output_file: Optional[str] = None) -> Optional[bytes]:
        """
        Create a PPTX file from image paths.

        Args:
            image_paths: Ordered list of image paths.
            output_file: Optional output file path (if None, returns bytes).

        Returns:
            PPTX bytes if output_file is None, otherwise None.
        """
        if not image_paths:
            raise ValueError("No image paths provided for PPTX export")

        from pptx import Presentation
        from pptx.util import Inches

        # Validate and preserve order
        valid_paths = []
        for image_path in image_paths:
            if os.path.exists(image_path):
                valid_paths.append(image_path)
            else:
                logger.warning("Image not found for PPTX export: %s", image_path)

        if not valid_paths:
            raise ValueError("No valid images found for PPTX export")

        prs = Presentation()
        prs.slide_width = Inches(10)
        prs.slide_height = Inches(5.625)

        blank_slide_layout = prs.slide_layouts[6]
        for image_path in valid_paths:
            slide = prs.slides.add_slide(blank_slide_layout)
            slide.shapes.add_picture(
                image_path,
                left=0,
                top=0,
                width=prs.slide_width,
                height=prs.slide_height,
            )

        if output_file:
            prs.save(output_file)
            return None

        pptx_bytes = io.BytesIO()
        prs.save(pptx_bytes)
        pptx_bytes.seek(0)
        return pptx_bytes.getvalue()

    @staticmethod
    def find_mineru_result_dir(search_root: str) -> Optional[str]:
        """
        Find the most recent MinerU result directory containing *_content_list.json.
        """
        root = Path(search_root)
        if not root.exists():
            return None

        candidates = list(root.rglob("*_content_list.json"))
        if not candidates:
            return None

        def score(path: Path) -> float:
            mtime = path.stat().st_mtime
            bonus = 1 if "auto" in path.parts else 0
            return mtime + bonus

        best = max(candidates, key=score)
        return str(best.parent)

    @staticmethod
    def _infer_page_dimensions(content_list: List[Dict[str, Any]]) -> Optional[Tuple[int, int]]:
        max_x = 0
        max_y = 0
        for item in content_list:
            bbox = item.get("bbox")
            if not bbox or len(bbox) != 4:
                continue
            max_x = max(max_x, int(bbox[2]))
            max_y = max(max_y, int(bbox[3]))
        if max_x <= 0 or max_y <= 0:
            return None
        return max_x, max_y

    @staticmethod
    def _find_source_file(mineru_dir: Path, base_stem: str, extensions: List[str]) -> Optional[Path]:
        for parent in [mineru_dir, mineru_dir.parent, mineru_dir.parent.parent]:
            for ext in extensions:
                candidate = parent / f"{base_stem}{ext}"
                if candidate.exists():
                    return candidate
        return None

    @staticmethod
    def _render_pdf_backgrounds(
        pdf_path: Path,
        target_width_px: int,
        target_height_px: int,
    ) -> Tuple[List[str], Optional[Path]]:
        try:
            import fitz  # type: ignore
        except Exception as exc:
            logger.warning("PyMuPDF not available for background rendering: %s", exc)
            return [], None

        doc = fitz.open(str(pdf_path))
        temp_dir = Path(tempfile.mkdtemp(prefix="paper2slides-bg-"))
        image_paths = []
        for page_index in range(len(doc)):
            page = doc[page_index]
            rect = page.rect
            scale_x = target_width_px / rect.width
            scale_y = target_height_px / rect.height
            matrix = fitz.Matrix(scale_x, scale_y)
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            path = temp_dir / f"page_{page_index + 1:03d}.png"
            pix.save(str(path))
            image_paths.append(str(path))
        return image_paths, temp_dir

    @staticmethod
    def create_editable_pptx_from_mineru(
        mineru_result_dir: str,
        output_file: str = None,
        slide_width_pixels: int = 1920,
        slide_height_pixels: int = 1080,
        background_images: List[str] = None,
    ) -> Optional[bytes]:
        """
        Create editable PPTX file from MinerU parsing results.
        """
        from paper2slides.utils.pptx_builder import PPTXBuilder

        mineru_dir = Path(mineru_result_dir)

        content_list_files = list(mineru_dir.glob("*_content_list.json"))
        if not content_list_files:
            raise FileNotFoundError(f"No content_list.json found in {mineru_result_dir}")

        content_list_file = content_list_files[0]
        logger.info("Loading MinerU content from: %s", content_list_file)

        with open(content_list_file, "r", encoding="utf-8") as f:
            content_list = json.load(f)

        if not content_list:
            raise ValueError("Empty content list from MinerU")

        logger.info("Loaded %s items from MinerU content_list", len(content_list))

        base_stem = content_list_file.name.replace("_content_list.json", "")

        layout_file = mineru_dir / "layout.json"
        layout_data = None
        actual_page_width = slide_width_pixels
        actual_page_height = slide_height_pixels
        use_layout_coords = False

        if layout_file.exists():
            try:
                with open(layout_file, "r", encoding="utf-8") as f:
                    layout_data = json.load(f)
                    if "pdf_info" in layout_data and len(layout_data["pdf_info"]) > 0:
                        page_size = layout_data["pdf_info"][0].get("page_size")
                        if page_size and len(page_size) == 2:
                            actual_page_width, actual_page_height = page_size
                            use_layout_coords = True
                            logger.info(
                                "Using layout.json for coordinates: %sx%s",
                                actual_page_width,
                                actual_page_height,
                            )
                        else:
                            logger.warning("page_size not found in layout.json")
                    else:
                        logger.warning("pdf_info not found in layout.json")
            except Exception as exc:
                logger.warning("Failed to read layout.json: %s", exc)
        else:
            logger.warning("layout.json not found, using content_list coordinates")

        inferred = ExportService._infer_page_dimensions(content_list)
        if not use_layout_coords and inferred:
            actual_page_width, actual_page_height = inferred
            if slide_width_pixels == 1920 and slide_height_pixels == 1080:
                slide_width_pixels, slide_height_pixels = inferred

        logger.info("Target slide dimensions: %sx%s", slide_width_pixels, slide_height_pixels)
        logger.info("Actual page dimensions: %sx%s", actual_page_width, actual_page_height)

        temp_dir = None
        if background_images is None:
            background_images = []
            pdf_path = ExportService._find_source_file(mineru_dir, base_stem, [".pdf"])
            if pdf_path:
                background_images, temp_dir = ExportService._render_pdf_backgrounds(
                    pdf_path,
                    slide_width_pixels,
                    slide_height_pixels,
                )
            if not background_images:
                image_path = ExportService._find_source_file(
                    mineru_dir,
                    base_stem,
                    [".png", ".jpg", ".jpeg", ".webp"],
                )
                if image_path:
                    background_images = [str(image_path)]

        text_level_map = {}
        for item in content_list:
            if item.get("type") == "text" and "text" in item:
                text = item["text"].strip()
                text_level_map[text] = item.get("text_level")

        pages_content: Dict[int, List[Dict[str, Any]]] = {}

        if use_layout_coords and layout_data:
            logger.info("Using layout.json coordinates (accurate)")
            for page_info in layout_data.get("pdf_info", []):
                page_idx = page_info.get("page_idx", 0)
                pages_content[page_idx] = []

                for block in page_info.get("para_blocks", []):
                    block_type = block.get("type", "text")
                    bbox = block.get("bbox")
                    if not bbox:
                        continue

                    if block_type in ["text", "title"] and block.get("lines"):
                        for line in block["lines"]:
                            for span in line.get("spans", []):
                                if span.get("type") == "text" and span.get("content"):
                                    text = span["content"].strip()
                                    text_level = text_level_map.get(text)
                                    pages_content[page_idx].append(
                                        {
                                            "type": block_type,
                                            "text": text,
                                            "text_level": text_level,
                                            "bbox": bbox,
                                            "page_idx": page_idx,
                                        }
                                    )
                    elif block_type in ["image", "table", "equation"]:
                        img_path = block.get("image_path")
                        if not img_path and block.get("blocks"):
                            for sub_block in block["blocks"]:
                                for line in sub_block.get("lines", []):
                                    for span in line.get("spans", []):
                                        if span.get("image_path"):
                                            img_path = span["image_path"]
                                            break
                                    if img_path:
                                        break
                                if img_path:
                                    break
                        if img_path:
                            pages_content[page_idx].append(
                                {
                                    "type": block_type,
                                    "img_path": img_path,
                                    "bbox": bbox,
                                    "page_idx": page_idx,
                                    "html_table": block.get("html_table"),
                                }
                            )
        else:
            logger.info("Using content_list.json coordinates (need scaling)")
            for item in content_list:
                page_idx = item.get("page_idx", 0)
                pages_content.setdefault(page_idx, []).append(item)

        scale_x = slide_width_pixels / actual_page_width
        scale_y = slide_height_pixels / actual_page_height

        builder = PPTXBuilder()
        builder.create_presentation()
        builder.setup_presentation_size(slide_width_pixels, slide_height_pixels)

        for page_idx in sorted(pages_content.keys()):
            slide = builder.add_blank_slide()

            if background_images and page_idx < len(background_images):
                bg_image_path = background_images[page_idx]
                if bg_image_path and os.path.exists(bg_image_path):
                    try:
                        slide.shapes.add_picture(
                            bg_image_path,
                            left=0,
                            top=0,
                            width=builder.prs.slide_width,
                            height=builder.prs.slide_height,
                        )
                    except Exception as exc:
                        logger.error("Failed to add background image: %s", exc)
                else:
                    logger.warning("Background image missing for page %s", page_idx)

            page_items = pages_content[page_idx]

            text_items = []
            image_items = []
            for item in page_items:
                item_type = item.get("type", "")
                if item_type in ["text", "title", "header", "footer"]:
                    text_items.append(item)
                elif item_type in ["image", "table", "equation"]:
                    image_items.append(item)

            for img_item in image_items:
                ExportService._add_mineru_image_to_slide(
                    builder, slide, img_item, mineru_dir, scale_x, scale_y
                )

            for text_item in text_items:
                ExportService._add_mineru_text_to_slide(
                    builder, slide, text_item, scale_x, scale_y
                )

        try:
            if output_file:
                builder.save(output_file)
                return None

            pptx_bytes = io.BytesIO()
            builder.get_presentation().save(pptx_bytes)
            pptx_bytes.seek(0)
            return pptx_bytes.getvalue()
        finally:
            if temp_dir and temp_dir.exists():
                shutil.rmtree(temp_dir, ignore_errors=True)

    @staticmethod
    def _add_mineru_text_to_slide(
        builder,
        slide,
        text_item: Dict[str, Any],
        scale_x: float = 1.0,
        scale_y: float = 1.0,
    ):
        text = text_item.get("text", "").strip()
        if not text:
            return

        bbox = text_item.get("bbox")
        if not bbox or len(bbox) != 4:
            logger.warning("Invalid bbox for text item: %s", text_item)
            return

        x0, y0, x1, y1 = bbox
        bbox = [
            int(x0 * scale_x),
            int(y0 * scale_y),
            int(x1 * scale_x),
            int(y1 * scale_y),
        ]

        item_type = text_item.get("type", "text")
        text_level = text_item.get("text_level")
        level = "title" if item_type == "title" or text_level == 1 else "default"

        try:
            builder.add_text_element(
                slide=slide,
                text=text,
                bbox=bbox,
                text_level=level,
            )
        except Exception as exc:
            logger.error("Failed to add text element: %s", exc)

    @staticmethod
    def _add_mineru_image_to_slide(
        builder,
        slide,
        image_item: Dict[str, Any],
        mineru_dir: Path,
        scale_x: float = 1.0,
        scale_y: float = 1.0,
    ):
        bbox = image_item.get("bbox")
        if not bbox or len(bbox) != 4:
            logger.warning("Invalid bbox for image item: %s", image_item)
            return

        x0, y0, x1, y1 = bbox
        bbox = [
            int(x0 * scale_x),
            int(y0 * scale_y),
            int(x1 * scale_x),
            int(y1 * scale_y),
        ]

        html_table = image_item.get("html_table") or image_item.get("table_body")
        item_type = image_item.get("type", "image")

        if html_table and item_type == "table":
            try:
                builder.add_table_element(
                    slide=slide,
                    html_table=html_table,
                    bbox=bbox,
                )
                return
            except Exception as exc:
                logger.error("Failed to add table: %s", exc)

        img_path_str = (
            image_item.get("img_path")
            or image_item.get("table_img_path")
            or image_item.get("equation_img_path")
            or ""
        )
        if not img_path_str:
            logger.warning("No image path in item: %s", image_item)
            return

        possible_paths = [
            Path(img_path_str),
            mineru_dir / img_path_str,
            mineru_dir / "images" / Path(img_path_str).name,
            mineru_dir / Path(img_path_str).name,
        ]

        image_path = None
        for path in possible_paths:
            if path.exists():
                image_path = str(path)
                break

        if not image_path:
            logger.warning("Image file not found: %s", img_path_str)
            builder.add_image_placeholder(slide, bbox)
            return

        try:
            builder.add_image_element(
                slide=slide,
                image_path=image_path,
                bbox=bbox,
            )
        except Exception as exc:
            logger.error("Failed to add image element: %s", exc)

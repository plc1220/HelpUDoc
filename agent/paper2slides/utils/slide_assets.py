"""
Slide asset extraction utilities.

Extract layout JSON, background-only images, and cropped asset images
from slide JPGs for PPTX reconstruction.
"""
from __future__ import annotations

import base64
import json
import logging
import mimetypes
import os
import shutil
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from PIL import Image

from ..llm.genai_client import create_client, extract_text, generate_image, generate_text

logger = logging.getLogger(__name__)


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y"}


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


DEFAULT_LAYOUT_MODEL = os.getenv("LAYOUT_MODEL") or os.getenv("LLM_MODEL", "gemini-2.5-flash")
DEFAULT_IMAGE_MODEL = os.getenv("IMAGE_GEN_MODEL", "gemini-3-pro-image-preview")
DEFAULT_CLEAN_IMAGE_MODEL = os.getenv("CLEAN_IMAGE_MODEL")
DEFAULT_REFINE_ASSETS = _env_bool("REFINE_ASSETS", True)
DEFAULT_CLEAN_ASSETS = _env_bool("CLEAN_ASSETS", True)
DEFAULT_REFINE_TEXT_LAYOUT = _env_bool("REFINE_TEXT_LAYOUT", True)
DEFAULT_REFINE_TEXT_MAX_TOKENS = _env_int("REFINE_TEXT_MAX_TOKENS", 2048)
DEFAULT_REFINE_MAX_TOKENS = _env_int("REFINE_MAX_TOKENS", 512)
DEFAULT_CLEAN_MAX_RETRIES = _env_int("CLEAN_MAX_RETRIES", 1)
DEFAULT_REFINE_MIN_SIZE = _env_int("REFINE_MIN_SIZE", 40)
DEFAULT_CLEAN_MIN_SIZE = _env_int("CLEAN_MIN_SIZE", 40)
DEFAULT_CLEAN_BG_TOLERANCE = _env_int("CLEAN_BG_TOLERANCE", 18)
IMAGE_ELEMENT_TYPES = {
    "image",
    "figure",
    "diagram",
    "chart",
    "photo",
    "icon",
    "equation",
}


@dataclass
class SlideAssetConfig:
    layout_model: str = DEFAULT_LAYOUT_MODEL
    image_model: str = DEFAULT_IMAGE_MODEL
    clean_image_model: Optional[str] = DEFAULT_CLEAN_IMAGE_MODEL
    max_retries: int = 1
    max_output_tokens: int = 8192
    refine_assets: bool = DEFAULT_REFINE_ASSETS
    clean_assets: bool = DEFAULT_CLEAN_ASSETS
    refine_text_layout: bool = DEFAULT_REFINE_TEXT_LAYOUT
    refine_text_max_tokens: int = DEFAULT_REFINE_TEXT_MAX_TOKENS
    refine_max_tokens: int = DEFAULT_REFINE_MAX_TOKENS
    clean_max_retries: int = DEFAULT_CLEAN_MAX_RETRIES
    refine_min_size: int = DEFAULT_REFINE_MIN_SIZE
    clean_min_size: int = DEFAULT_CLEAN_MIN_SIZE
    clean_bg_tolerance: int = DEFAULT_CLEAN_BG_TOLERANCE


class SlideAssetExtractor:
    """Extract layout + assets from slide images using Gemini models."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        config: Optional[SlideAssetConfig] = None,
    ) -> None:
        self.config = config or SlideAssetConfig()
        self.client = create_client(api_key=api_key)

    def extract_from_images(
        self, image_paths: Sequence[str], output_root: Path
    ) -> List[Path]:
        slide_dirs: List[Path] = []
        for image_path in image_paths:
            slide_dirs.append(self.extract_slide(Path(image_path), output_root))
        return slide_dirs

    def extract_slide(self, image_path: Path, output_root: Path) -> Path:
        if not image_path.exists():
            raise FileNotFoundError(f"Slide image not found: {image_path}")

        slide_dir = output_root / image_path.stem
        assets_dir = slide_dir / "assets"
        slide_dir.mkdir(parents=True, exist_ok=True)
        assets_dir.mkdir(parents=True, exist_ok=True)

        with Image.open(image_path) as img:
            width_px, height_px = img.size

        layout = self._extract_layout_json(image_path, width_px, height_px)
        layout = _normalize_layout(layout, width_px, height_px)

        layout["version"] = "1"
        layout["canvas"] = {"width": width_px, "height": height_px}
        layout["assets_dir"] = "assets"
        layout["background"] = "background.png"
        layout["source_image"] = os.path.relpath(image_path, slide_dir)

        if self.config.refine_text_layout:
            layout = self._refine_text_layout(image_path, layout, width_px, height_px)

        background_path = slide_dir / "background.png"
        if not self._generate_background(image_path, background_path, width_px, height_px):
            shutil.copy(image_path, background_path)

        layout = self._crop_assets(image_path, assets_dir, layout)

        layout_path = slide_dir / "layout.json"
        with open(layout_path, "w", encoding="utf-8") as handle:
            json.dump(layout, handle, ensure_ascii=False, indent=2)

        return slide_dir

    def _crop_assets(
        self,
        image_path: Path,
        assets_dir: Path,
        layout: Dict[str, Any],
    ) -> Dict[str, Any]:
        elements = layout.get("elements", [])
        if not elements:
            return layout

        with Image.open(image_path) as img:
            base_image = img.convert("RGB")
            asset_index = 1
            for element in elements:
                element_type = str(element.get("type", "")).lower().strip()
                is_image = element_type in IMAGE_ELEMENT_TYPES
                is_table_without_cells = (
                    element_type == "table" and not element.get("cells")
                )
                if not is_image and not is_table_without_cells:
                    continue
                if element.get("asset_path"):
                    continue
                bbox = element.get("bbox")
                if not bbox or len(bbox) != 4:
                    continue
                x0, y0, x1, y1 = bbox
                if x1 <= x0 or y1 <= y0:
                    continue

                refined_bbox = bbox
                if self.config.refine_assets and (is_image or is_table_without_cells):
                    refined_bbox = self._refine_bbox(
                        base_image, bbox, element_type, element.get("description")
                    )
                    refined_bbox = _clamp_bbox(
                        refined_bbox, base_image.width, base_image.height
                    )
                    if refined_bbox != bbox:
                        element["bbox"] = refined_bbox

                crop_bbox = refined_bbox
                crop = base_image.crop(tuple(crop_bbox))

                if self.config.clean_assets and is_image:
                    cleaned = self._clean_asset(crop, element_type, element.get("description"))
                    if cleaned is not None:
                        crop = cleaned
                        if crop.size != (crop_bbox[2] - crop_bbox[0], crop_bbox[3] - crop_bbox[1]):
                            crop = crop.resize(
                                (crop_bbox[2] - crop_bbox[0], crop_bbox[3] - crop_bbox[1]),
                                resample=Image.LANCZOS,
                            )

                asset_name = f"asset-{asset_index:03d}.png"
                asset_index += 1
                asset_path = assets_dir / asset_name
                crop.save(asset_path)
                element["asset_path"] = f"{layout.get('assets_dir', 'assets')}/{asset_name}"

        return layout

    def _refine_bbox(
        self,
        image: Image.Image,
        bbox: List[int],
        element_type: str,
        description: Optional[str],
    ) -> List[int]:
        x0, y0, x1, y1 = bbox
        width = x1 - x0
        height = y1 - y0
        if width < self.config.refine_min_size or height < self.config.refine_min_size:
            return bbox

        crop = image.crop((x0, y0, x1, y1))
        data_url = _image_to_data_url_from_pil(crop)
        prompt = _build_refine_bbox_prompt(width, height, element_type, description)
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ]

        response = generate_text(
            self.client,
            self.config.layout_model,
            messages=messages,
            response_format={"type": "json_object"},
            max_output_tokens=self.config.refine_max_tokens,
            temperature=0.1,
        )
        text = extract_text(response).strip()
        refined = _load_bbox_payload(text)
        if not refined:
            return bbox

        rx0, ry0, rx1, ry1 = _clamp_bbox(refined, width, height)
        if rx1 - rx0 < 5 or ry1 - ry0 < 5:
            return bbox

        area_ratio = ((rx1 - rx0) * (ry1 - ry0)) / max(width * height, 1)
        if area_ratio < 0.15:
            return bbox

        return [x0 + rx0, y0 + ry0, x0 + rx1, y0 + ry1]

    def _clean_asset(
        self, crop: Image.Image, element_type: str, description: Optional[str]
    ) -> Optional[Image.Image]:
        if crop.width < self.config.clean_min_size or crop.height < self.config.clean_min_size:
            return None

        prompt = _build_clean_asset_prompt(element_type, description)
        reference_images = [_image_to_reference_from_pil(crop)]
        clean_model = self.config.clean_image_model or self.config.image_model

        for _ in range(max(1, self.config.clean_max_retries)):
            try:
                results = generate_image(
                    self.client,
                    clean_model,
                    prompt=prompt,
                    reference_images=reference_images,
                    aspect_ratio=_infer_aspect_ratio(crop.width, crop.height),
                )
            except Exception as exc:
                logger.warning("Asset cleanup failed: %s", exc)
                continue

            if not results:
                continue

            image_bytes, _ = results[0]
            try:
                with Image.open(BytesIO(image_bytes)) as img:
                    cleaned = img.convert("RGBA")
                keyed = _apply_color_key_transparency(
                    cleaned, tolerance=self.config.clean_bg_tolerance
                )
                return keyed if keyed is not None else cleaned
            except Exception as exc:
                logger.warning("Failed to decode cleaned asset: %s", exc)
                continue

        return None

    def _extract_layout_json(
        self, image_path: Path, width_px: int, height_px: int
    ) -> Dict[str, Any]:
        prompt = _build_layout_prompt(width_px, height_px)
        data_url = _image_to_data_url(image_path)
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ]

        last_error: Optional[str] = None
        for attempt in range(self.config.max_retries + 1):
            response = generate_text(
                self.client,
                self.config.layout_model,
                messages=messages,
                response_format={"type": "json_object"},
                max_output_tokens=self.config.max_output_tokens,
                temperature=0.1,
            )
            text = extract_text(response).strip()
            payload = _load_json_payload(text)
            if payload is not None:
                return payload
            last_error = text[:200]
            messages[0]["content"][0]["text"] = _build_layout_prompt(
                width_px, height_px, strict=True
            )

        raise RuntimeError(f"Failed to parse layout JSON: {last_error}")

    def _refine_text_layout(
        self,
        image_path: Path,
        layout: Dict[str, Any],
        width_px: int,
        height_px: int,
    ) -> Dict[str, Any]:
        elements = layout.get("elements", [])
        if not isinstance(elements, list):
            return layout

        text_items: List[Dict[str, Any]] = []
        element_map: Dict[int, Dict[str, Any]] = {}
        next_id = 1

        for element in elements:
            if not isinstance(element, dict):
                continue
            if str(element.get("type", "")).lower().strip() != "text":
                continue
            text = str(element.get("text", "")).strip()
            bbox = element.get("bbox")
            if not text or not bbox or len(bbox) != 4:
                continue
            text_item = {
                "id": next_id,
                "bbox": bbox,
                "text": text,
                "font_size": element.get("font_size"),
                "align": element.get("align", "left"),
            }
            text_items.append(text_item)
            element_map[next_id] = element
            next_id += 1

        if not text_items:
            return layout

        prompt = _build_text_refine_prompt(width_px, height_px, text_items)
        data_url = _image_to_data_url(image_path)
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ]

        response = generate_text(
            self.client,
            self.config.layout_model,
            messages=messages,
            response_format={"type": "json_object"},
            max_output_tokens=self.config.refine_text_max_tokens,
            temperature=0.1,
        )
        text = extract_text(response).strip()
        refined = _load_text_refine_payload(text)
        if not refined:
            return layout

        for item in refined:
            if not isinstance(item, dict):
                continue
            element_id = item.get("id")
            if not element_id or element_id not in element_map:
                continue
            target = element_map[element_id]

            new_bbox = _coerce_bbox(item.get("bbox"))
            if new_bbox:
                target["bbox"] = _clamp_bbox(new_bbox, width_px, height_px)

            new_text = item.get("text")
            if isinstance(new_text, str) and new_text.strip():
                target["text"] = new_text

            new_font = _coerce_number(item.get("font_size"))
            if new_font is not None and new_font > 0:
                target["font_size"] = new_font

            new_align = str(item.get("align", "")).lower().strip()
            if new_align in {"left", "center", "right", "justify"}:
                target["align"] = new_align

        return layout

    def _generate_background(
        self, image_path: Path, output_path: Path, width_px: int, height_px: int
    ) -> bool:
        reference_images = [_image_to_reference(image_path)]
        prompt = (
            "Create a clean background-only version of the slide. "
            "Remove all text, charts, photos, icons, and figures. "
            "Preserve only the background colors, gradients, shapes, and layout. "
            "Match the original canvas size and aspect ratio exactly."
        )
        aspect_ratio = _infer_aspect_ratio(width_px, height_px)

        try:
            results = generate_image(
                self.client,
                self.config.image_model,
                prompt=prompt,
                reference_images=reference_images,
                aspect_ratio=aspect_ratio,
            )
        except Exception as exc:
            logger.warning("Background generation failed: %s", exc)
            return False

        if not results:
            logger.warning("Background generation returned no images.")
            return False

        image_bytes, _ = results[0]
        try:
            with Image.open(BytesIO(image_bytes)) as img:
                img.save(output_path)
            return True
        except Exception as exc:
            logger.warning("Failed to save generated background: %s", exc)
            return False


def _build_layout_prompt(width_px: int, height_px: int, strict: bool = False) -> str:
    strict_line = "Return JSON only. No extra text." if strict else "Return JSON only."
    return (
        "You are given a slide image. Extract a structured layout for PPTX reconstruction.\n"
        f"Canvas: {width_px}x{height_px} pixels.\n"
        f"{strict_line}\n"
        "Schema:\n"
        "{\n"
        '  "version": "1",\n'
        '  "canvas": {"width": int, "height": int},\n'
        '  "elements": [\n'
        "    {\n"
        '      "type": "text",\n'
        '      "bbox": [x0, y0, x1, y1],\n'
        '      "text": "...",\n'
        '      "font_size": number (points),\n'
        '      "bold": bool,\n'
        '      "italic": bool,\n'
        '      "underline": bool,\n'
        '      "color_rgb": [r, g, b],\n'
        '      "align": "left|center|right|justify"\n'
        "    },\n"
        "    {\n"
        '      "type": "image",\n'
        '      "bbox": [x0, y0, x1, y1],\n'
        '      "description": "short description of the visual"\n'
        "    },\n"
        "    {\n"
        '      "type": "table",\n'
        '      "bbox": [x0, y0, x1, y1],\n'
        '      "rows": int,\n'
        '      "cols": int,\n'
        '      "cells": [["..."]]\n'
        "    }\n"
        "  ]\n"
        "}\n"
        "Rules:\n"
        "- Use integer pixel coordinates.\n"
        "- Include only visible content elements (no background).\n"
        "- Keep elements in reading order.\n"
        "- If a field is unknown, omit it.\n"
    )


def _build_text_refine_prompt(
    width_px: int, height_px: int, text_items: List[Dict[str, Any]]
) -> str:
    payload = json.dumps(
        {"canvas": {"width": width_px, "height": height_px}, "texts": text_items},
        ensure_ascii=False,
        indent=2,
    )
    return (
        "You are given a slide image and a list of detected text boxes. "
        "Refine the text layout to avoid overlaps and match the visual lines. "
        "Adjust bboxes and insert explicit line breaks (\\n) where needed.\n"
        "Keep the same text content, only add/remove line breaks for layout. "
        "Do NOT invent new text. Keep ids unchanged.\n"
        "Return JSON only: {\"texts\":[{\"id\":int,\"bbox\":[x0,y0,x1,y1],"
        "\"text\":\"...\",\"font_size\":number?,\"align\":\"left|center|right|justify\"?}]}\n"
        f"Current text items:\n{payload}\n"
    )


def _build_refine_bbox_prompt(
    width_px: int,
    height_px: int,
    element_type: str,
    description: Optional[str],
) -> str:
    description_line = f"Description: {description}\n" if description else ""
    return (
        "You are given a coarse crop of a slide element. "
        "Return the tightest bounding box around the main visual content "
        "inside this crop. Include labels that are part of the visual (axes, legends). "
        "Exclude surrounding whitespace or unrelated slide text.\n"
        f"Crop size: {width_px}x{height_px} pixels.\n"
        f"Element type: {element_type}.\n"
        f"{description_line}"
        "Return JSON only: {\"bbox\": [x0, y0, x1, y1]} with integer pixel values, "
        "coordinates relative to the crop (0,0 is top-left). "
        "If the crop is already tight, return the full crop bbox.\n"
    )


def _build_clean_asset_prompt(element_type: str, description: Optional[str]) -> str:
    description_line = f"Description: {description}\n" if description else ""
    return (
        "Clean up this extracted visual asset. "
        "Remove slide background and any surrounding whitespace. "
        "Keep only the visual element and any labels that belong to it. "
        "Do NOT add or hallucinate new content. "
        "Preserve colors and shapes. "
        "Output on a solid white background with no transparency.\n"
        f"Element type: {element_type}.\n"
        f"{description_line}"
    )


def _image_to_data_url_from_pil(image: Image.Image) -> str:
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{encoded}"


def _image_to_reference_from_pil(image: Image.Image) -> Dict[str, Any]:
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return {
        "figure_id": "Asset Crop",
        "caption": "Use this image as the base.",
        "base64": encoded,
        "mime_type": "image/png",
    }

def _image_to_data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    data = path.read_bytes()
    encoded = base64.b64encode(data).decode("utf-8")
    return f"data:{mime};base64,{encoded}"


def _image_to_reference(path: Path) -> Dict[str, Any]:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    encoded = base64.b64encode(path.read_bytes()).decode("utf-8")
    return {
        "figure_id": "Source Slide",
        "caption": "Use this image as the base.",
        "base64": encoded,
        "mime_type": mime,
    }


def _infer_aspect_ratio(width_px: int, height_px: int) -> Optional[str]:
    if height_px <= 0:
        return None
    ratio = width_px / height_px
    candidates = {
        "16:9": 16 / 9,
        "4:3": 4 / 3,
        "1:1": 1.0,
    }
    for name, target in candidates.items():
        if abs(ratio - target) < 0.03:
            return name
    return None


def _load_json_payload(text: str) -> Optional[Dict[str, Any]]:
    if not text:
        return None
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.replace("json", "", 1).strip()

    payload = _coerce_layout_payload(_try_json_load(cleaned))
    if payload is not None:
        return payload

    extracted = _extract_first_json(cleaned)
    if extracted:
        return _coerce_layout_payload(_try_json_load(extracted))

    repaired = _repair_truncated_json(cleaned)
    if repaired:
        return _coerce_layout_payload(_try_json_load(repaired))

    return None


def _load_bbox_payload(text: str) -> Optional[List[int]]:
    if not text:
        return None
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.replace("json", "", 1).strip()

    for candidate in (cleaned, _extract_first_json(cleaned), _repair_truncated_json(cleaned)):
        if not candidate:
            continue
        data = _try_json_load(candidate)
        if data is None:
            continue
        if isinstance(data, list):
            bbox = _coerce_bbox(data)
            if bbox:
                return bbox
        if isinstance(data, dict):
            bbox = _coerce_bbox(data.get("bbox") or data.get("box"))
            if bbox:
                return bbox
    return None


def _load_text_refine_payload(text: str) -> Optional[List[Dict[str, Any]]]:
    if not text:
        return None
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.replace("json", "", 1).strip()

    candidates = [
        cleaned,
        _extract_first_json(cleaned),
        _repair_truncated_json(cleaned),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        data = _try_json_load(candidate)
        if not data:
            continue
        if isinstance(data, dict):
            texts = data.get("texts")
            if isinstance(texts, list):
                return texts
        if isinstance(data, list):
            if all(isinstance(item, dict) for item in data):
                return data
    return None


def _try_json_load(text: str) -> Optional[Any]:
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _coerce_layout_payload(value: Any) -> Optional[Dict[str, Any]]:
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        if not value:
            return None
        first = value[0]
        if isinstance(first, dict) and ("elements" in first or "canvas" in first):
            return first
        if all(isinstance(item, dict) and "bbox" in item for item in value):
            return {"elements": value}
    return None


def _extract_first_json(text: str) -> Optional[str]:
    start_idx = None
    for idx, ch in enumerate(text):
        if ch in "{[":
            start_idx = idx
            break
    if start_idx is None:
        return None

    stack: List[str] = []
    in_string: Optional[str] = None
    escape = False
    for idx in range(start_idx, len(text)):
        ch = text[idx]
        if in_string:
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == in_string:
                in_string = None
            continue

        if ch in ("\"", "'"):
            in_string = ch
            continue
        if ch in "{[":
            stack.append(ch)
            continue
        if ch in "}]":
            if not stack:
                continue
            opener = stack.pop()
            if (opener == "{" and ch != "}") or (opener == "[" and ch != "]"):
                return None
            if not stack:
                return text[start_idx : idx + 1]
    return None


def _repair_truncated_json(text: str) -> Optional[str]:
    start_idx = None
    for idx, ch in enumerate(text):
        if ch in "{[":
            start_idx = idx
            break
    if start_idx is None:
        return None

    stack: List[str] = []
    in_string: Optional[str] = None
    escape = False
    last_safe: Optional[Tuple[int, List[str]]] = None

    for idx in range(start_idx, len(text)):
        ch = text[idx]
        if in_string:
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == in_string:
                in_string = None
            continue

        if ch in ("\"", "'"):
            in_string = ch
            continue
        if ch in "{[":
            stack.append(ch)
            continue
        if ch in "}]":
            if not stack:
                continue
            opener = stack.pop()
            if (opener == "{" and ch != "}") or (opener == "[" and ch != "]"):
                return None
            if not stack:
                return text[start_idx : idx + 1]
            if ch == "}":
                last_safe = (idx, stack.copy())

    if not last_safe:
        return None

    end_idx, remaining = last_safe
    repaired = text[start_idx : end_idx + 1]
    for opener in reversed(remaining):
        repaired += "}" if opener == "{" else "]"
    return repaired


def _normalize_layout(layout: Any, width_px: int, height_px: int) -> Dict[str, Any]:
    if not isinstance(layout, dict):
        layout = {}

    elements = layout.get("elements")
    if not isinstance(elements, list):
        elements = []

    normalized_elements: List[Dict[str, Any]] = []
    for element in elements:
        if not isinstance(element, dict):
            continue
        raw_type = str(element.get("type", "")).lower().strip()
        if raw_type in {"title", "heading", "header", "footer"}:
            raw_type = "text"
        if raw_type not in {"text", "table"} and raw_type not in IMAGE_ELEMENT_TYPES:
            if "text" in element:
                raw_type = "text"
            elif "cells" in element:
                raw_type = "table"
            else:
                raw_type = "image"

        bbox = _coerce_bbox(element.get("bbox"))
        if not bbox:
            continue
        bbox = _clamp_bbox(bbox, width_px, height_px)

        normalized: Dict[str, Any] = {"type": raw_type, "bbox": bbox}
        if raw_type == "text":
            text = str(element.get("text", "")).strip()
            if not text:
                continue
            normalized["text"] = text
            font_size = _coerce_number(element.get("font_size"))
            if font_size is not None:
                normalized["font_size"] = font_size
            for key in ("bold", "italic", "underline"):
                if key in element:
                    normalized[key] = bool(element.get(key))
            color = _coerce_rgb(element.get("color_rgb"))
            if color:
                normalized["color_rgb"] = color
            align = str(element.get("align", "")).lower().strip()
            if align in {"left", "center", "right", "justify"}:
                normalized["align"] = align
        elif raw_type == "table":
            cells = element.get("cells")
            if isinstance(cells, list):
                normalized["cells"] = [[str(cell) for cell in row] for row in cells]
                normalized["rows"] = len(normalized["cells"])
                normalized["cols"] = max((len(row) for row in normalized["cells"]), default=0)
            else:
                rows = _coerce_int(element.get("rows"))
                cols = _coerce_int(element.get("cols"))
                if rows is not None:
                    normalized["rows"] = rows
                if cols is not None:
                    normalized["cols"] = cols
            description = str(element.get("description", "")).strip()
            if description:
                normalized["description"] = description
        else:
            description = str(element.get("description", "")).strip()
            if description:
                normalized["description"] = description
            asset_path = element.get("asset_path")
            if isinstance(asset_path, str) and asset_path.strip():
                normalized["asset_path"] = asset_path

        normalized_elements.append(normalized)

    return {
        "version": str(layout.get("version", "1")),
        "canvas": {"width": width_px, "height": height_px},
        "elements": normalized_elements,
    }


def _coerce_bbox(value: Any) -> Optional[List[int]]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        return [int(round(float(v))) for v in value]
    except (TypeError, ValueError):
        return None


def _clamp_bbox(bbox: List[int], width_px: int, height_px: int) -> List[int]:
    x0, y0, x1, y1 = bbox
    x0 = max(0, min(width_px, x0))
    y0 = max(0, min(height_px, y0))
    x1 = max(0, min(width_px, x1))
    y1 = max(0, min(height_px, y1))
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    return [x0, y0, x1, y1]


def _apply_color_key_transparency(
    image: Image.Image, tolerance: int = 18
) -> Optional[Image.Image]:
    if tolerance <= 0:
        return None
    estimate = _estimate_border_color(image, tolerance)
    if estimate is None:
        return None

    bg_color, avg_diff = estimate
    if avg_diff > tolerance * 2:
        return None

    pixels = list(image.getdata())
    if not pixels:
        return None

    bg_r, bg_g, bg_b = bg_color
    new_pixels = []
    transparent = 0
    for r, g, b, a in pixels:
        if max(abs(r - bg_r), abs(g - bg_g), abs(b - bg_b)) <= tolerance:
            new_pixels.append((r, g, b, 0))
            transparent += 1
        else:
            new_pixels.append((r, g, b, a))

    ratio = transparent / len(pixels)
    if ratio < 0.01 or ratio > 0.95:
        return None

    result = image.copy()
    result.putdata(new_pixels)
    return result


def _estimate_border_color(
    image: Image.Image, tolerance: int
) -> Optional[Tuple[Tuple[int, int, int], float]]:
    width, height = image.size
    if width < 2 or height < 2:
        return None

    stride = max(1, min(width, height) // 50)
    pixels = image.load()
    samples: List[Tuple[int, int, int]] = []

    for x in range(0, width, stride):
        samples.append(pixels[x, 0][:3])
        samples.append(pixels[x, height - 1][:3])
    for y in range(0, height, stride):
        samples.append(pixels[0, y][:3])
        samples.append(pixels[width - 1, y][:3])

    if not samples:
        return None

    r_values = sorted(p[0] for p in samples)
    g_values = sorted(p[1] for p in samples)
    b_values = sorted(p[2] for p in samples)
    mid = len(samples) // 2
    bg = (r_values[mid], g_values[mid], b_values[mid])

    diffs = [
        max(abs(p[0] - bg[0]), abs(p[1] - bg[1]), abs(p[2] - bg[2]))
        for p in samples
    ]
    avg_diff = sum(diffs) / len(diffs)

    if avg_diff > tolerance * 3:
        return None
    return bg, avg_diff


def _coerce_number(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_rgb(value: Any) -> Optional[List[int]]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return None
    rgb: List[int] = []
    for channel in value:
        try:
            channel_int = int(channel)
        except (TypeError, ValueError):
            return None
        if channel_int < 0 or channel_int > 255:
            return None
        rgb.append(channel_int)
    return rgb

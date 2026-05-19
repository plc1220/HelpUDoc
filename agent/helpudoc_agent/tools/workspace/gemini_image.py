"""Gemini image generation and layout-extraction tool."""
from __future__ import annotations

import json
import re
from io import BytesIO
from pathlib import Path
from typing import List
from uuid import uuid4

from langchain_core.tools import Tool, tool

try:
    from google.genai.types import GenerateContentConfig, ImageConfig, Modality
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise RuntimeError("Gemini dependencies are required") from exc

from ...state import WorkspaceState
from ...tagged_file_policy import tagged_files_mode_guard


def build_gemini_image_tool(
    workspace_state: WorkspaceState,
    client=None,
    model_name: str | None = None,
) -> Tool:
    """Create a Gemini image generation/editing tool."""
    if client is None or model_name is None:
        raise ValueError("Gemini client and image model name are required")

    output_dir = workspace_state.root_path

    def _resolve_source_image(path_str: str) -> Image.Image:
        candidate = Path(path_str)
        if not candidate.is_absolute():
            candidate = workspace_state.root_path / candidate
        candidate = candidate.resolve()
        workspace_root = workspace_state.root_path.resolve()
        if workspace_root not in candidate.parents and candidate != workspace_root:
            raise ValueError("Source image path must be inside the workspace")
        if not candidate.exists():
            raise FileNotFoundError(f"Source image '{candidate}' not found")
        with Image.open(candidate) as img:
            return img.copy()

    def _sanitize_prefix(raw_prefix: str | None) -> str:
        if raw_prefix and raw_prefix.strip():
            candidate = raw_prefix.strip()
        else:
            candidate = f"gemini-image-{uuid4().hex[:8]}"
        safe = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in candidate)
        return safe or f"gemini-image-{uuid4().hex[:8]}"

    def _is_explicit_image_request(prompt: str) -> bool:
        text = (prompt or "").lower()
        keywords = (
            "image",
            "picture",
            "photo",
            "diagram",
            "figure",
            "illustration",
            "render",
            "draw",
            "sketch",
            "visual",
            "edit",
            "generate",
        )
        return any(keyword in text for keyword in keywords)

    def _save_inline_image(inline_data, prefix: str, index: int) -> str:
        filename = f"{prefix}-{index + 1}.png"
        destination = output_dir / filename
        with BytesIO(inline_data.data) as stream:
            with Image.open(stream) as image:
                image.save(destination)
        return str(destination.relative_to(workspace_state.root_path))

    def _extract_json_payload(text: str) -> str:
        fenced = re.search(r"```json\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
        if fenced:
            return fenced.group(1).strip()
        return text.strip()

    def _save_json_payload(payload: dict, prefix: str) -> str:
        filename = f"{prefix}.json"
        destination = output_dir / filename
        with open(destination, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        return str(destination.relative_to(workspace_state.root_path))

    @tool
    def gemini_image(
        prompt: str,
        source_image_path: str | None = None,
        output_name_prefix: str | None = None,
        extract_assets: bool = False,
        assets_output_name: str | None = None,
    ) -> str:
        """Generate or edit an image with Gemini."""
        if not prompt.strip():
            return "Skipped gemini_image: prompt is required for image generation/editing."

        blocked = tagged_files_mode_guard(workspace_state.context, "gemini_image")
        if blocked:
            return blocked

        if not _is_explicit_image_request(prompt):
            return "Skipped gemini_image: user did not explicitly request image generation/editing."

        if source_image_path:
            try:
                source_image = _resolve_source_image(source_image_path)
            except Exception as exc:
                return f"Skipped gemini_image: {exc}"
            contents: List[object] = [source_image, prompt]
        else:
            contents = [prompt]

        prefix = _sanitize_prefix(output_name_prefix)
        assets_prefix = _sanitize_prefix(assets_output_name or f"{prefix}-assets")
        if extract_assets:
            assets_prompt = (
                "Return JSON only for PPTX reconstruction. "
                "Schema: {\"version\":\"1\",\"canvas\":{\"width\":int,\"height\":int},"
                "\"elements\":[{\"type\":\"text\",\"bbox\":[x0,y0,x1,y1],"
                "\"text\":\"...\",\"font_size\":number,\"bold\":bool,\"italic\":bool,"
                "\"underline\":bool,\"color_rgb\":[r,g,b],\"align\":\"left|center|right|justify\"},"
                "{\"type\":\"image\",\"bbox\":[x0,y0,x1,y1],\"description\":\"...\"},"
                "{\"type\":\"table\",\"bbox\":[x0,y0,x1,y1],\"rows\":int,\"cols\":int,"
                "\"cells\":[[\"...\"]]}]}. "
                "Use pixel coordinates matching the input image. "
                "If unsure, omit fields rather than guessing."
            )
            response = client.models.generate_content(
                model=model_name,
                contents=[*contents, assets_prompt],
                config=GenerateContentConfig(
                    response_modalities=[Modality.TEXT],
                    candidate_count=1,
                ),
            )
        else:
            response = client.models.generate_content(
                model=model_name,
                contents=contents,
                config=GenerateContentConfig(
                    response_modalities=[Modality.IMAGE, Modality.TEXT],
                    candidate_count=1,
                    image_config=ImageConfig(aspectRatio="1:1"),
                ),
            )

        text_parts: List[str] = []
        saved_images: List[str] = []

        if not response.candidates:
            raise RuntimeError("Gemini did not return any candidates")

        for candidate in response.candidates:
            if not candidate.content:
                continue
            for part in candidate.content.parts:
                if getattr(part, "text", None):
                    text_parts.append(part.text)
                elif getattr(part, "inline_data", None):
                    saved = _save_inline_image(part.inline_data, prefix, len(saved_images))
                    saved_images.append(saved)

        summary_lines = []
        if extract_assets:
            if not text_parts:
                return "No JSON was returned by Gemini."
            raw_text = "\n".join(text_parts).strip()
            json_text = _extract_json_payload(raw_text)
            try:
                payload = json.loads(json_text)
            except json.JSONDecodeError as exc:
                return f"Failed to parse JSON from Gemini: {exc}"
            saved_json = _save_json_payload(payload, assets_prefix)
            summary_lines.append("Saved JSON:")
            summary_lines.append(saved_json)
            return "\n".join(summary_lines)

        if text_parts:
            summary_lines.append("\n".join(text_parts).strip())
        if saved_images:
            summary_lines.append("Saved images:")
            summary_lines.extend(saved_images)
        else:
            summary_lines.append("No images were returned by Gemini.")
        return "\n".join(summary_lines)

    gemini_image.name = "gemini_image"
    gemini_image.description = (
        "Generate or edit workspace images using Gemini models; can also extract JSON layout assets."
    )
    return gemini_image

"""Workspace file tools: report stitching, PDF creation, and image URLs."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import List

from langchain_core.tools import Tool, tool

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise RuntimeError("Pillow is required for image/PDF workspace tools") from exc

logger = logging.getLogger(__name__)

from ....state import WorkspaceState
from ....tagged_file_policy import tagged_files_mode_guard


def _workspace_root(workspace_state: WorkspaceState) -> Path:
    return workspace_state.root_path.resolve()


def _display_path(root: Path, path_obj: Path) -> str:
    try:
        return "/" + path_obj.relative_to(root).as_posix()
    except ValueError:
        return str(path_obj)


def _resolve_under_root(root: Path, path_str: str) -> Path:
    candidate = (root / path_str.lstrip("/")).resolve()
    if root not in candidate.parents and candidate != root:
        raise ValueError("Path must remain inside the workspace")
    return candidate


def build_append_to_report_tool(workspace_state: WorkspaceState) -> Tool:
    root = _workspace_root(workspace_state)

    @tool
    def append_to_report(source_path: str, target_path: str = "/Final_Proposal.md") -> str:
        """Append content from source_path into target_path with a separator."""
        blocked = tagged_files_mode_guard(workspace_state.context, "append_to_report")
        if blocked:
            return blocked
        try:
            source = _resolve_under_root(root, source_path)
            target = _resolve_under_root(root, target_path)
        except ValueError as exc:
            return str(exc)

        if not source.exists():
            return f"Source file '{_display_path(root, source)}' not found"

        try:
            source_text = source.read_text(encoding="utf-8").strip()
        except Exception as exc:  # pragma: no cover - filesystem guard
            return f"Error reading source '{_display_path(root, source)}': {exc}"

        target.parent.mkdir(parents=True, exist_ok=True)

        try:
            if target.exists():
                existing = target.read_text(encoding="utf-8").rstrip()
                stitched = f"{existing}\n\n{source_text}\n\n---\n"
            else:
                stitched = f"{source_text}\n\n---\n"
            target.write_text(stitched, encoding="utf-8")
        except Exception as exc:  # pragma: no cover - filesystem guard
            return f"Error writing target '{_display_path(root, target)}': {exc}"

        return f"Appended {_display_path(root, source)} to {_display_path(root, target)}"

    append_to_report.name = "append_to_report"
    append_to_report.description = "Stitch a generated section into the final proposal."
    return append_to_report


def build_create_pdf_from_images_tool(workspace_state: WorkspaceState) -> Tool:
    root = _workspace_root(workspace_state)

    def _is_inside_workspace(path_obj: Path) -> bool:
        return path_obj == root or root in path_obj.parents

    def _resolve_output(path_str: str) -> Path:
        normalized = str(path_str or "").strip() or "stitched_images.pdf"
        if not normalized.lower().endswith(".pdf"):
            normalized += ".pdf"
        candidate = (root / normalized.lstrip("/")).resolve()
        if not _is_inside_workspace(candidate):
            raise ValueError("Output path must remain inside the workspace")
        return candidate

    def _resolve_image(path_str: str) -> Path:
        raw = str(path_str or "").strip().replace("\\", "/")
        if not raw:
            raise ValueError("Image path cannot be empty")

        candidates: list[Path] = []
        raw_path = Path(raw)
        if raw_path.is_absolute():
            candidates.append(raw_path)
        candidates.append(root / raw.lstrip("/"))

        for candidate in candidates:
            resolved = candidate.resolve()
            if _is_inside_workspace(resolved) and resolved.is_file():
                return resolved

        matches = [path for path in root.rglob("*") if path.is_file() and path.name == raw]
        if not matches:
            needle = raw.lower()
            matches = [path for path in root.rglob("*") if path.is_file() and needle in path.name.lower()]
        if len(matches) == 1:
            return matches[0].resolve()
        if len(matches) > 1:
            options = ", ".join(_display_path(root, match) for match in matches[:8])
            raise ValueError(f"Image path '{raw}' is ambiguous. Matches: {options}")
        raise ValueError(f"Image file '{raw}' not found in the workspace")

    def _page_size_points(page_size: str, width: int, height: int) -> tuple[float, float]:
        normalized = (page_size or "image").strip().lower()
        if normalized in {"a4", "a4_portrait"}:
            return 595.2756, 841.8898
        if normalized in {"letter", "us-letter"}:
            return 612.0, 792.0
        if normalized in {"image", "auto", "source"}:
            return float(width), float(height)
        raise ValueError("page_size must be one of: image, auto, A4, letter")

    @tool
    def create_pdf_from_images(
        image_paths: List[str],
        output_path: str = "/stitched_images.pdf",
        page_size: str = "image",
        fit_mode: str = "contain",
    ) -> str:
        """Create a multi-page PDF with one workspace image per page."""
        blocked = tagged_files_mode_guard(workspace_state.context, "create_pdf_from_images")
        if blocked:
            return blocked
        if not image_paths:
            return "No image paths provided."

        try:
            output = _resolve_output(output_path)
            resolved_images = [_resolve_image(path) for path in image_paths]
            normalized_fit = (fit_mode or "contain").strip().lower()
            if normalized_fit not in {"contain", "cover", "stretch"}:
                return "fit_mode must be one of: contain, cover, stretch"

            import fitz  # PyMuPDF

            doc = fitz.open()
            for image_path in resolved_images:
                with Image.open(image_path) as img:
                    width, height = img.size
                page_width, page_height = _page_size_points(page_size, width, height)
                page = doc.new_page(width=page_width, height=page_height)

                if normalized_fit == "stretch":
                    rect = fitz.Rect(0, 0, page_width, page_height)
                else:
                    scale = min(page_width / width, page_height / height)
                    if normalized_fit == "cover":
                        scale = max(page_width / width, page_height / height)
                    draw_width = width * scale
                    draw_height = height * scale
                    left = (page_width - draw_width) / 2
                    top = (page_height - draw_height) / 2
                    rect = fitz.Rect(left, top, left + draw_width, top + draw_height)
                page.insert_image(rect, filename=str(image_path), keep_proportion=normalized_fit != "stretch")

            output.parent.mkdir(parents=True, exist_ok=True)
            doc.save(output)
            doc.close()
        except Exception as exc:
            return f"Error creating PDF: {exc}"

        image_list = ", ".join(_display_path(root, path) for path in resolved_images)
        return f"Created PDF {_display_path(root, output)} with {len(resolved_images)} pages from: {image_list}"

    create_pdf_from_images.name = "create_pdf_from_images"
    create_pdf_from_images.description = (
        "Create a multi-page PDF from workspace image files, preserving the supplied image order."
    )
    return create_pdf_from_images


def build_get_image_url_tool(workspace_state: WorkspaceState) -> Tool:
    @tool
    def get_image_url(file_name: str) -> str:
        """Get the public URL for an image file stored in MinIO/S3."""
        blocked = tagged_files_mode_guard(workspace_state.context, "get_image_url")
        if blocked:
            return blocked
        try:
            workspace_root = workspace_state.root_path
            metadata_file = workspace_root / ".workspace_metadata.json"

            if not metadata_file.exists():
                matching_files = list(workspace_root.rglob(file_name))
                if not matching_files:
                    matching_files = [
                        f for f in workspace_root.rglob("*")
                        if f.is_file() and file_name.lower() in f.name.lower()
                    ]
                if not matching_files:
                    return f"Error: No file found with name '{file_name}' in the workspace."

                found_file = matching_files[0]
                relative_path = found_file.relative_to(workspace_root)
                s3_endpoint = os.getenv("S3_ENDPOINT") or os.getenv("MINIO_ENDPOINT") or "http://localhost:9000"
                s3_bucket = os.getenv("S3_BUCKET_NAME") or "helpudoc"
                workspace_id = workspace_state.workspace_id
                s3_key = f"{workspace_id}/{relative_path.as_posix()}"
                public_url = f"{s3_endpoint.rstrip('/')}/{s3_bucket}/{s3_key}"

                return (
                    f"File found: {found_file.name}\n"
                    f"Local path: /{relative_path.as_posix()}\n"
                    f"Potential public URL: {public_url}\n\n"
                    "Note: This URL is constructed based on the file location. "
                    "If the file hasn't been uploaded to MinIO/S3 yet, the URL may not be accessible."
                )

            with open(metadata_file, encoding="utf-8") as handle:
                metadata = json.load(handle)

            files = metadata.get("files", [])
            matching_file = next((f for f in files if f.get("name") == file_name), None)
            if not matching_file:
                matching_file = next(
                    (f for f in files if file_name.lower() in f.get("name", "").lower()),
                    None,
                )

            if not matching_file:
                return f"Error: No file found with name '{file_name}' in workspace metadata."

            public_url = matching_file.get("publicUrl")
            if public_url:
                return (
                    f"File: {matching_file['name']}\n"
                    f"Public URL: {public_url}\n"
                    f"MIME Type: {matching_file.get('mimeType', 'unknown')}"
                )
            if matching_file.get("storageType") == "local":
                return (
                    f"File '{matching_file['name']}' is stored locally and does not have a public URL.\n"
                    "The file needs to be uploaded to MinIO/S3 to get a public URL."
                )
            return f"Error: File '{matching_file['name']}' does not have a public URL available."

        except Exception as exc:
            logger.exception("get_image_url failed for %r", file_name)
            return f"Error retrieving image URL: {exc}"

    get_image_url.name = "get_image_url"
    get_image_url.description = "Retrieve the public URL for an image file stored in MinIO/S3."
    return get_image_url

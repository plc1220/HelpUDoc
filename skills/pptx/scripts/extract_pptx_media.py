#!/usr/bin/env python3
"""Extract embedded PPTX images into categorized workspace output folders."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import zipfile


RASTER_EXTENSIONS = {".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
VECTOR_EXTENSIONS = {".emf", ".svg", ".wmf"}
MAX_FILES = 500
MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024


def _safe_relative_dir(raw: str) -> Path:
    value = str(raw or "").strip().replace("\\", "/").strip("/")
    path = Path(value)
    if not value or path.is_absolute() or ".." in path.parts or path == Path("."):
        raise ValueError("--output-dir must be a safe workspace-relative directory")
    return path


def _category(extension: str) -> str | None:
    if extension in RASTER_EXTENSIONS:
        return "raster"
    if extension in VECTOR_EXTENSIONS:
        return "vector"
    return None


def extract_pptx_media(source: Path, output_root: Path, output_dir: Path) -> dict[str, object]:
    if source.suffix.lower() != ".pptx" or not source.is_file():
        raise ValueError(f"PPTX input not found: {source}")

    destination_root = (output_root / output_dir).resolve()
    resolved_output_root = output_root.resolve()
    if destination_root != resolved_output_root and resolved_output_root not in destination_root.parents:
        raise ValueError("Resolved output directory escapes the workspace output root")
    destination_root.mkdir(parents=True, exist_ok=True)

    extracted: list[dict[str, object]] = []
    total_bytes = 0
    seen_destinations: set[str] = set()

    with zipfile.ZipFile(source, "r") as archive:
        candidates = []
        for member in archive.infolist():
            member_path = PurePosixPath(member.filename)
            if member.is_dir() or len(member_path.parts) != 3 or member_path.parts[:2] != ("ppt", "media"):
                continue
            extension = Path(member_path.name).suffix.lower()
            category = _category(extension)
            if category is not None:
                candidates.append((member, category, extension))

        if len(candidates) > MAX_FILES:
            raise ValueError(f"PPTX contains {len(candidates)} images; limit is {MAX_FILES}")

        for member, category, extension in sorted(candidates, key=lambda item: item[0].filename):
            if member.file_size > MAX_FILE_BYTES:
                raise ValueError(f"Embedded image exceeds {MAX_FILE_BYTES} bytes: {member.filename}")
            total_bytes += member.file_size
            if total_bytes > MAX_TOTAL_BYTES:
                raise ValueError(f"Embedded images exceed total limit of {MAX_TOTAL_BYTES} bytes")

            base_name = Path(PurePosixPath(member.filename).name).name
            destination_key = f"{category}/{base_name}".lower()
            if destination_key in seen_destinations:
                digest_suffix = hashlib.sha256(member.filename.encode("utf-8")).hexdigest()[:8]
                base_name = f"{Path(base_name).stem}-{digest_suffix}{extension}"
                destination_key = f"{category}/{base_name}".lower()
            seen_destinations.add(destination_key)

            destination = destination_root / category / base_name
            destination.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with archive.open(member, "r") as source_handle, destination.open("wb") as output_handle:
                while True:
                    chunk = source_handle.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    output_handle.write(chunk)

            extracted.append(
                {
                    "path": f"{output_dir.as_posix()}/{category}/{base_name}",
                    "category": category,
                    "contentTypeExtension": extension,
                    "sourceMember": member.filename,
                    "size": destination.stat().st_size,
                    "sha256": digest.hexdigest(),
                }
            )

    if not extracted:
        raise ValueError("No supported embedded images were found under ppt/media/")

    manifest: dict[str, object] = {
        "source": source.name,
        "imageCount": len(extracted),
        "totalBytes": sum(int(item["size"]) for item in extracted),
        "categories": {
            "raster": sum(1 for item in extracted if item["category"] == "raster"),
            "vector": sum(1 for item in extracted if item["category"] == "vector"),
        },
        "files": extracted,
    }
    manifest_path = destination_root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Staged PPTX basename")
    parser.add_argument("--output-dir", default="extracted_images")
    args = parser.parse_args()

    source = Path(args.input)
    if source.is_absolute() or source.name != args.input or ".." in source.parts:
        raise ValueError("--input must be the staged PPTX basename")
    output_root = Path(os.environ.get("HELPUDOC_WORKSPACE_OUTPUT_ROOT", "workspace-output"))
    output_dir = _safe_relative_dir(args.output_dir)

    if (output_root / output_dir).exists():
        shutil.rmtree(output_root / output_dir)
    manifest = extract_pptx_media(source, output_root, output_dir)
    print(json.dumps({"status": "ok", **manifest}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

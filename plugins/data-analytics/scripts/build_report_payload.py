from __future__ import annotations

from _data_common import json_dump, read_request, write_out_json


def _normalize_manifest(raw_manifest: object, sources: list[object]) -> tuple[dict, list[str]]:
    manifest = dict(raw_manifest) if isinstance(raw_manifest, dict) else {}
    title = str(manifest.get("title") or "").strip()
    errors: list[str] = []
    if not title:
        errors.append("manifest.title is required")

    blocks = manifest.get("blocks")
    if not isinstance(blocks, list):
        sections = manifest.pop("sections", [])
        blocks = []
        if isinstance(sections, list):
            for index, section in enumerate(sections):
                if not isinstance(section, dict):
                    continue
                section_title = str(section.get("title") or "").strip()
                content = str(section.get("body") or section.get("content") or "").strip()
                if index == 0 and title:
                    content = f"# {title}\n\n## {section_title or 'Executive Summary'}\n\n{content}".strip()
                elif section_title:
                    content = f"## {section_title}\n\n{content}".strip()
                blocks.append(
                    {
                        "id": f"section_{index + 1}",
                        "type": "markdown",
                        "title": section_title or f"Section {index + 1}",
                        "body": content,
                    }
                )
        manifest["blocks"] = blocks

    if not blocks:
        errors.append("manifest.blocks must contain at least one reader-facing block")
    else:
        first_markdown = next(
            (
                block
                for block in blocks
                if isinstance(block, dict)
                and str(block.get("type") or "markdown").strip().lower() == "markdown"
            ),
            None,
        )
        if isinstance(first_markdown, dict) and title:
            body_key = "body" if "body" in first_markdown else "content"
            body = str(first_markdown.get(body_key) or "").strip()
            if not body.startswith(f"# {title}"):
                first_markdown[body_key] = f"# {title}\n\n{body}".strip()

    chart_assets = manifest.get("charts")
    has_chart_asset = isinstance(chart_assets, list) and bool(chart_assets)
    has_chart_block = any(
        isinstance(block, dict)
        and str(block.get("type") or "").strip().lower() in {"chart", "visualization"}
        for block in blocks or []
    )
    if not has_chart_asset:
        errors.append("report requires at least one chart asset in manifest.charts")
    if not has_chart_block:
        errors.append("report requires at least one chart visualization block")

    if sources and not manifest.get("sources"):
        manifest["sources"] = sources
    return manifest, errors


def _normalize_snapshot(raw_snapshot: object) -> dict:
    snapshot = dict(raw_snapshot) if isinstance(raw_snapshot, dict) else {}
    if isinstance(snapshot.get("datasets"), dict):
        return snapshot
    return {"datasets": snapshot}


def main() -> None:
    request = read_request()
    sources = request.get("sources") or []
    sources = sources if isinstance(sources, list) else []
    manifest, errors = _normalize_manifest(request.get("manifest"), sources)
    payload = {
        "ok": not errors,
        "widget_type": "artifact",
        "manifest": manifest,
        "snapshot": _normalize_snapshot(request.get("snapshot")),
        "sources": sources,
    }
    if errors:
        payload["errors"] = errors
    write_out_json("result.json", payload)
    print(
        json_dump(
            {
                "ok": payload["ok"],
                "artifactTitle": manifest.get("title"),
                "errors": errors,
            }
        )
    )


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Apply a template/style pack (DOTX or DOCX) onto a target DOCX.

Goal: make it easy to "start from template" or retrofit a style pack without
manual re-styling.

What it does (minimal, high ROI)
--------------------------------
- Copies key parts from the template into the target:
  - word/styles.xml
  - word/theme/theme1.xml
  - word/fontTable.xml (if present)
  - word/numbering.xml (if present)

It also ensures [Content_Types].xml has the required Overrides for any newly
added parts.

Usage
-----
python scripts/apply_template_styles.py --template template.dotx --target report.docx --out styled.docx
python scripts/apply_template_styles.py --markdown report.md --out report.docx

Markdown mode uses the complete source with the standard_business_brief preset.
Under the declared sandbox runner, it stages input by basename and publishes
the DOCX and artifact metadata through the existing workspace-output contract.

Caveats
-------
- This can change pagination/layout. Always render and inspect PNGs.
- If the target uses custom styles with the same IDs, they will be overwritten.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import zipfile

from lxml import etree

CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"


def _read(z: zipfile.ZipFile, name: str) -> bytes:
    return z.read(name)


def _has(z: zipfile.ZipFile, name: str) -> bool:
    return name in z.namelist()


def _ensure_override(ct_root: etree._Element, part_name: str, content_type: str) -> bool:
    changed = False
    # Normalize PartName to start with '/'
    if not part_name.startswith("/"):
        part_name = "/" + part_name

    # If override exists, update contentType if needed
    for ov in ct_root.findall(f"{{{CT_NS}}}Override"):
        if ov.get("PartName") == part_name:
            if ov.get("ContentType") != content_type:
                ov.set("ContentType", content_type)
                changed = True
            return changed

    ov = etree.SubElement(ct_root, f"{{{CT_NS}}}Override")
    ov.set("PartName", part_name)
    ov.set("ContentType", content_type)
    return True


def apply(template_path: str, target_path: str, out_path: str) -> None:
    parts = [
        ("word/styles.xml", None),
        (
            "word/theme/theme1.xml",
            "application/vnd.openxmlformats-officedocument.theme+xml",
        ),
        (
            "word/fontTable.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
        ),
        (
            "word/numbering.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
        ),
    ]

    with (
        zipfile.ZipFile(template_path, "r") as zt,
        zipfile.ZipFile(target_path, "r") as zg,
    ):
        overrides = {}
        for name, _ct in parts:
            if _has(zt, name):
                overrides[name] = _read(zt, name)

        # Update content types in target if we add/override optional parts
        ct_bytes = _read(zg, "[Content_Types].xml")
        ct_root = etree.fromstring(ct_bytes)
        ct_changed = False

        for name, ctype in parts:
            if name in overrides and ctype:
                ct_changed |= _ensure_override(ct_root, name, ctype)

        if ct_changed:
            overrides["[Content_Types].xml"] = etree.tostring(
                ct_root, xml_declaration=True, encoding="UTF-8", standalone="yes"
            )

        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for info in zg.infolist():
                name = info.filename
                if name in overrides:
                    zout.writestr(name, overrides[name])
                else:
                    zout.writestr(name, zg.read(name))
            # Add new parts not present in target
            for name, data in overrides.items():
                if name not in {i.filename for i in zg.infolist()}:
                    zout.writestr(name, data)


def create_from_markdown(source_path: str, output_path: str) -> Path:
    """Convert the complete source with the standard_business_brief preset.

    The declared runner stages sources by basename and publishes only files under
    HELPUDOC_WORKSPACE_OUTPUT_ROOT. No generated script or inline job is needed.
    """
    from docx import Document
    from docx.enum.text import WD_BREAK
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Inches, Pt, RGBColor
    from markdown_it import MarkdownIt
    from table_geometry import apply_table_geometry, column_widths_from_weights

    output_rel = Path(output_path.lstrip("/"))
    if not output_rel.parts or ".." in output_rel.parts or output_rel.suffix.lower() != ".docx":
        raise ValueError("--out must be a workspace-relative .docx path without '..'")
    sandbox_root = os.environ.get("HELPUDOC_SANDBOX_RUN_DIR")
    if sandbox_root:
        source = Path(sandbox_root) / Path(source_path).name
        output_root = Path(os.environ["HELPUDOC_WORKSPACE_OUTPUT_ROOT"]).resolve()
        destination = output_root / output_rel
    else:
        source = Path(source_path)
        destination = Path(output_path)
    text = source.read_text(encoding="utf-8-sig")
    if not text.strip():
        raise ValueError("Markdown source is empty")
    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Inches(8.5), Inches(11)
    section.top_margin = section.bottom_margin = Inches(1)
    section.left_margin = section.right_margin = Inches(1)
    section.header_distance = section.footer_distance = Inches(0.492)
    normal = doc.styles["Normal"]
    normal.font.name, normal.font.size = "Calibri", Pt(11)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.10
    for level, size, color, before, after in [
        (1, 16, "2E74B5", 16, 8), (2, 13, "2E74B5", 12, 6),
        (3, 12, "1F4D78", 8, 4), (4, 11, "1F4D78", 8, 4),
        (5, 11, "1F4D78", 8, 4), (6, 11, "1F4D78", 8, 4),
    ]:
        style = doc.styles[f"Heading {level}"]
        style.font.name, style.font.size = "Calibri", Pt(size)
        style.font.color.rgb = RGBColor.from_string(color)
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True

    def element(tag, **attrs):
        value = OxmlElement(f"w:{tag}")
        for name, attr in attrs.items():
            value.set(qn(f"w:{name}"), str(attr))
        return value

    def numbering(ordered: bool, start: int) -> int:
        root = doc.part.numbering_part.element
        abstract_id = max([int(n.get(qn("w:abstractNumId"))) for n in root.findall(qn("w:abstractNum"))] + [-1]) + 1
        abstract = element("abstractNum", abstractNumId=abstract_id)
        abstract.append(element("multiLevelType", val="multilevel"))
        for level in range(9):
            definition = element("lvl", ilvl=level)
            definition.append(element("start", val=start if level == 0 else 1))
            definition.append(element("numFmt", val="decimal" if ordered else "bullet"))
            definition.append(element("lvlText", val=f"%{level + 1}." if ordered else "●"))
            definition.append(element("lvlJc", val="left"))
            properties = element("pPr")
            properties.append(element("ind", left=720 + level * 360, hanging=360))
            tabs = element("tabs")
            tabs.append(element("tab", val="num", pos=720 + level * 360))
            properties.append(tabs)
            definition.append(properties)
            abstract.append(definition)
        root.append(abstract)
        num_id = max([int(n.get(qn("w:numId"))) for n in root.findall(qn("w:num"))] + [0]) + 1
        instance = element("num", numId=num_id)
        instance.append(element("abstractNumId", val=abstract_id))
        root.append(instance)
        return num_id

    def inline(paragraph, children):
        bold, italic, link = False, False, None
        for child in children or []:
            if child.type == "strong_open":
                bold = True
            elif child.type == "strong_close":
                bold = False
            elif child.type == "em_open":
                italic = True
            elif child.type == "em_close":
                italic = False
            elif child.type == "link_open":
                link = child.attrGet("href")
            elif child.type == "link_close":
                if link:
                    paragraph.add_run(f" ({link})")
                link = None
            elif child.type == "hardbreak":
                paragraph.add_run().add_break(WD_BREAK.LINE)
            else:
                value = " " if child.type == "softbreak" else child.content
                if child.type == "image":
                    value = f"{child.content} ({child.attrGet('src')})"
                run = paragraph.add_run(value)
                run.bold, run.italic = bold, italic
                if child.type == "code_inline":
                    run.font.name = "Consolas"
                    run.font.size = Pt(10)

    tokens = MarkdownIt("commonmark").enable("table").parse(text)
    lists, item_first = [], []
    paragraph, table, row, cell = None, None, None, None
    quote_depth = 0
    for token in tokens:
        kind = token.type
        if kind in {"bullet_list_open", "ordered_list_open"}:
            lists.append(numbering(kind == "ordered_list_open", int(token.attrGet("start") or 1)))
        elif kind in {"bullet_list_close", "ordered_list_close"}:
            lists.pop()
        elif kind == "list_item_open":
            item_first.append(True)
        elif kind == "list_item_close":
            item_first.pop()
        elif kind == "blockquote_open":
            quote_depth += 1
        elif kind == "blockquote_close":
            quote_depth -= 1
        elif kind in {"paragraph_open", "heading_open"}:
            paragraph = doc.add_paragraph(style=f"Heading {token.tag[1:]}" if kind == "heading_open" else "Normal")
            if quote_depth:
                paragraph.paragraph_format.left_indent = Inches(0.25 * quote_depth)
            if lists and kind == "paragraph_open":
                paragraph.paragraph_format.space_after = Pt(8)
                paragraph.paragraph_format.line_spacing = 1.167
                if item_first and item_first[-1]:
                    props = paragraph._p.get_or_add_pPr()
                    num_props = element("numPr")
                    num_props.append(element("ilvl", val=min(len(lists) - 1, 8)))
                    num_props.append(element("numId", val=lists[-1]))
                    props.append(num_props)
                    item_first[-1] = False
                else:
                    paragraph.paragraph_format.left_indent = Inches(0.5 + 0.25 * (len(lists) - 1))
        elif kind == "inline":
            inline(cell.paragraphs[0] if cell is not None else paragraph, token.children)
        elif kind in {"fence", "code_block", "html_block"}:
            paragraph = doc.add_paragraph()
            run = paragraph.add_run(token.content.rstrip("\n"))
            run.font.name, run.font.size = "Consolas", Pt(9)
        elif kind == "hr":
            # Preserve the source's section break without inserting a page break.
            doc.add_paragraph("—")
        elif kind == "table_open":
            table = doc.add_table(rows=0, cols=0)
            table.style = "Table Grid"
        elif kind == "tr_open":
            row = None
        elif kind in {"th_open", "td_open"}:
            if row is None:
                row = table.add_row()
                cell_index = 0
            if cell_index >= len(table.columns):
                table.add_column(Inches(1))
            cell = row.cells[cell_index]
            if kind == "th_open":
                shade = element("shd", fill="F2F4F7")
                cell._tc.get_or_add_tcPr().append(shade)
            cell_index += 1
        elif kind in {"th_close", "td_close"}:
            if kind == "th_close":
                for run in cell.paragraphs[0].runs:
                    run.bold = True
            cell = None
        elif kind == "table_close":
            apply_table_geometry(table, column_widths_from_weights([1] * len(table.columns)))
            table = None
    destination.parent.mkdir(parents=True, exist_ok=True)
    doc.save(destination)
    verified = Document(destination)
    if not verified.paragraphs and not verified.tables:
        raise ValueError("Generated DOCX has no content")
    if sandbox_root:
        metadata = {"files": [{"path": "/" + output_rel.as_posix(), "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "size": destination.stat().st_size}]}
        out = Path(sandbox_root) / "out"
        out.mkdir(exist_ok=True)
        (out / "tool_artifacts.json").write_text(json.dumps(metadata), encoding="utf-8")
        (out / "result.json").write_text(json.dumps({"ok": True, "output": "/" + output_rel.as_posix(), "paragraphs": len(verified.paragraphs), "tables": len(verified.tables)}), encoding="utf-8")
    print(f"[OK] created {output_rel.as_posix()} ({destination.stat().st_size} bytes); structural verification passed")
    return destination


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template")
    ap.add_argument("--target")
    ap.add_argument("--markdown", help="Create a styled DOCX from a staged Markdown source")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if args.markdown:
        if args.template or args.target:
            ap.error("--markdown cannot be combined with --template or --target")
        create_from_markdown(args.markdown, args.out)
        return
    if not args.template or not args.target:
        ap.error("provide --markdown or both --template and --target")
    apply(args.template, args.target, args.out)
    print(f"[OK] wrote {args.out}")


if __name__ == "__main__":
    main()

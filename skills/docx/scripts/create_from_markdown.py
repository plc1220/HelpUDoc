#!/usr/bin/env python3
"""Create a styled Word document from a Markdown workspace file."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path, PurePosixPath

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Emu, Inches, Pt, RGBColor


def _safe_relative_path(value: str, *, extension: str) -> PurePosixPath:
    path = PurePosixPath(str(value or "").strip().replace("\\", "/"))
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Output path must be a relative workspace path without '..'.")
    if path.suffix.lower() != extension:
        raise ValueError(f"Output path must end in {extension}.")
    return path


def _inline_runs(paragraph, text: str) -> None:
    pattern = re.compile(
        r"(\*\*.+?\*\*|__.+?__|(?<!\*)\*[^*]+\*|(?<!_)_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))"
    )
    cursor = 0
    for match in pattern.finditer(text):
        if match.start() > cursor:
            paragraph.add_run(text[cursor:match.start()])
        token = match.group(0)
        run = paragraph.add_run(token)
        if token.startswith("**") or token.startswith("__"):
            run.text = token[2:-2]
            run.bold = True
        elif token.startswith("*") or token.startswith("_"):
            run.text = token[1:-1]
            run.italic = True
        elif token.startswith("`"):
            run.text = token[1:-1]
            run.font.name = "Consolas"
            run.font.size = Pt(9)
        else:
            link = re.match(r"\[([^\]]+)\]\(([^)]+)\)", token)
            run.text = link.group(1) if link else token
        cursor = match.end()
    if cursor < len(text):
        paragraph.add_run(text[cursor:])


def _table_cells(line: str) -> list[str]:
    content = line.strip().strip("|")
    return [cell.strip() for cell in content.split("|")]


def _set_cell_shading(cell, fill: str) -> None:
    properties = cell._tc.get_or_add_tcPr()
    shading = OxmlElement("w:shd")
    shading.set(qn("w:fill"), fill)
    properties.append(shading)


def _set_cell_margins(cell) -> None:
    properties = cell._tc.get_or_add_tcPr()
    margins = OxmlElement("w:tcMar")
    for edge, value in (("top", 80), ("bottom", 80), ("start", 120), ("end", 120)):
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:w"), str(value))
        element.set(qn("w:type"), "dxa")
        margins.append(element)
    properties.append(margins)


def _add_table(document, rows: list[list[str]]) -> None:
    if not rows:
        return
    column_count = max(1, max(len(row) for row in rows))
    table = document.add_table(rows=1, cols=column_count)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    table.autofit = False
    column_widths = [9360 // column_count] * column_count
    column_widths[-1] += 9360 - sum(column_widths)

    table_properties = table._tbl.tblPr
    table_width = table_properties.find(qn("w:tblW"))
    if table_width is None:
        table_width = OxmlElement("w:tblW")
        table_properties.append(table_width)
    table_width.set(qn("w:w"), "9360")
    table_width.set(qn("w:type"), "dxa")
    table_indent = OxmlElement("w:tblInd")
    table_indent.set(qn("w:w"), "120")
    table_indent.set(qn("w:type"), "dxa")
    table_properties.append(table_indent)

    grid = table._tbl.tblGrid
    for grid_column, width_dxa in zip(grid.gridCol_lst, column_widths):
        grid_column.set(qn("w:w"), str(width_dxa))
    for index, row in enumerate(rows):
        cells = table.rows[0].cells if index == 0 else table.add_row().cells
        for cell_index, cell in enumerate(cells):
            width_dxa = column_widths[cell_index]
            cell.width = Emu(width_dxa * 635)
            cell_width = cell._tc.tcPr.find(qn("w:tcW"))
            if cell_width is not None:
                cell_width.set(qn("w:w"), str(width_dxa))
                cell_width.set(qn("w:type"), "dxa")
            value = row[cell_index] if cell_index < len(row) else ""
            cell.text = ""
            _inline_runs(cell.paragraphs[0], value)
            _set_cell_margins(cell)
            if index == 0:
                _set_cell_shading(cell, "F2F4F7")
                for run in cell.paragraphs[0].runs:
                    run.bold = True


def _configure_styles(document) -> None:
    section = document.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = section.bottom_margin = section.left_margin = section.right_margin = Inches(1)
    section.header_distance = section.footer_distance = Inches(0.492)

    normal = document.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.10

    title = document.styles["Title"]
    title.font.name = "Calibri"
    title.font.size = Pt(24)
    title.font.bold = True
    title.font.color.rgb = RGBColor(31, 77, 120)
    title.paragraph_format.space_before = Pt(0)
    title.paragraph_format.space_after = Pt(12)

    heading_tokens = {
        "Heading 1": (16, "2E74B5", 16, 8),
        "Heading 2": (13, "2E74B5", 12, 6),
        "Heading 3": (12, "1F4D78", 8, 4),
    }
    for name, (size, color, before, after) in heading_tokens.items():
        style = document.styles[name]
        style.font.name = "Calibri"
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor.from_string(color)
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True

    for style_name in ("List Bullet", "List Number"):
        style = document.styles[style_name]
        style.font.name = "Calibri"
        style.font.size = Pt(11)
        style.paragraph_format.left_indent = Inches(0.5)
        style.paragraph_format.first_line_indent = Inches(-0.25)
        style.paragraph_format.space_after = Pt(8)
        style.paragraph_format.line_spacing = 1.167


def _render_markdown(document, source_text: str, fallback_title: str) -> None:
    lines = source_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if lines and lines[0].strip() == "---":
        end = next((index for index, line in enumerate(lines[1:], 1) if line.strip() == "---"), None)
        if end is not None:
            lines = lines[end + 1:]

    index = 0
    title_added = False
    paragraph_lines: list[str] = []

    def flush_paragraph() -> None:
        if paragraph_lines:
            paragraph = document.add_paragraph()
            _inline_runs(paragraph, " ".join(part.strip() for part in paragraph_lines))
            paragraph_lines.clear()

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            flush_paragraph()
            index += 1
            continue
        if stripped.startswith("```") or stripped.startswith("~~~"):
            flush_paragraph()
            fence = stripped[:3]
            index += 1
            code_lines = []
            while index < len(lines) and not lines[index].strip().startswith(fence):
                code_lines.append(lines[index])
                index += 1
            paragraph = document.add_paragraph()
            paragraph.paragraph_format.left_indent = Inches(0.25)
            run = paragraph.add_run("\n".join(code_lines))
            run.font.name = "Consolas"
            run.font.size = Pt(9)
            index += 1
            continue
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", stripped)
        if heading:
            flush_paragraph()
            level = len(heading.group(1))
            text = heading.group(2)
            if level == 1 and not title_added:
                paragraph = document.add_paragraph(style="Title")
                _inline_runs(paragraph, text)
                title_added = True
            else:
                paragraph = document.add_paragraph(style=f"Heading {min(level, 3)}")
                _inline_runs(paragraph, text)
            index += 1
            continue
        if stripped in {"---", "***", "___"}:
            flush_paragraph()
            index += 1
            continue
        if "|" in stripped and index + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{3,}", lines[index + 1]):
            flush_paragraph()
            rows = [_table_cells(stripped)]
            index += 2
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                rows.append(_table_cells(lines[index]))
                index += 1
            _add_table(document, rows)
            continue
        bullet = re.match(r"^\s*[-*+]\s+(.+)$", line)
        numbered = re.match(r"^\s*\d+[.)]\s+(.+)$", line)
        if bullet or numbered:
            flush_paragraph()
            paragraph = document.add_paragraph(style="List Bullet" if bullet else "List Number")
            _inline_runs(paragraph, (bullet or numbered).group(1))
            index += 1
            continue
        quote = re.match(r"^\s*>\s?(.*)$", line)
        if quote:
            flush_paragraph()
            paragraph = document.add_paragraph()
            paragraph.paragraph_format.left_indent = Inches(0.25)
            paragraph.paragraph_format.right_indent = Inches(0.25)
            _inline_runs(paragraph, quote.group(1))
            for run in paragraph.runs:
                run.italic = True
            index += 1
            continue
        paragraph_lines.append(stripped)
        index += 1

    flush_paragraph()
    if not title_added and fallback_title:
        title_paragraph = document.add_paragraph(fallback_title, style="Title")
        body = document._body._element
        body.remove(title_paragraph._p)
        body.insert(0, title_paragraph._p)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="Staged Markdown source file name.")
    parser.add_argument("--output-path", required=True, help="Workspace-relative .docx output path.")
    args = parser.parse_args()

    source_name = Path(args.source).name
    source = Path(source_name)
    if source.name != args.source or source.suffix.lower() not in {".md", ".markdown", ".txt"}:
        parser.error("--source must be a staged Markdown or text filename.")
    output_rel = _safe_relative_path(args.output_path, extension=".docx")
    source_text = source.read_text(encoding="utf-8-sig")
    if not source_text.strip():
        parser.error("Source file is empty.")

    output = Path("workspace-output").joinpath(*output_rel.parts)
    output.parent.mkdir(parents=True, exist_ok=True)
    document = Document()
    _configure_styles(document)
    _render_markdown(document, source_text, Path(source_name).stem.replace("-", " ").title())
    document.save(output)

    # Validate the generated package before publishing it from the sandbox.
    with output.open("rb") as stream:
        if stream.read(2) != b"PK":
            raise RuntimeError("python-docx did not produce a valid OOXML package.")
    artifacts = Path("out/tool_artifacts.json")
    artifacts.parent.mkdir(parents=True, exist_ok=True)
    artifacts.write_text(
        json.dumps({"files": [{"path": output_rel.as_posix(), "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}]}),
        encoding="utf-8",
    )
    print(f"Created DOCX: {output_rel.as_posix()} ({output.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"DOCX_CREATION_FAILED: {error}", file=sys.stderr)
        raise SystemExit(1)

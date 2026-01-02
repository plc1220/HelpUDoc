"""
PPTX builder utilities for MinerU outputs.
"""
from html.parser import HTMLParser
from typing import List

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt


class _SimpleTableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._in_table = False
        self._in_row = False
        self._in_cell = False
        self._rows: List[List[str]] = []
        self._current_row: List[str] = []
        self._current_cell: List[str] = []

    @property
    def rows(self) -> List[List[str]]:
        return self._rows

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._in_table = True
        elif tag == "tr" and self._in_table:
            self._in_row = True
            self._current_row = []
        elif tag in ("td", "th") and self._in_row:
            self._in_cell = True
            self._current_cell = []

    def handle_data(self, data):
        if self._in_cell:
            self._current_cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._in_cell:
            text = "".join(self._current_cell).strip()
            self._current_row.append(text)
            self._in_cell = False
        elif tag == "tr" and self._in_row:
            if self._current_row:
                self._rows.append(self._current_row)
            self._in_row = False
        elif tag == "table":
            self._in_table = False


class PPTXBuilder:
    """Helper for constructing PPTX with pixel-based coordinates."""

    def __init__(self):
        self.prs = Presentation()
        self._slide_width_px = 1920
        self._slide_height_px = 1080
        self._emu_per_px_x = None
        self._emu_per_px_y = None
        self._pt_per_px = None

    def create_presentation(self):
        self.prs = Presentation()

    def setup_presentation_size(self, slide_width_px: int, slide_height_px: int, slide_width_in: float = 10.0):
        self._slide_width_px = slide_width_px
        self._slide_height_px = slide_height_px

        slide_height_in = slide_width_in * (slide_height_px / slide_width_px)
        self.prs.slide_width = Inches(slide_width_in)
        self.prs.slide_height = Inches(slide_height_in)

        self._emu_per_px_x = self.prs.slide_width / slide_width_px
        self._emu_per_px_y = self.prs.slide_height / slide_height_px
        self._pt_per_px = (slide_height_in * 72.0) / slide_height_px

    def add_blank_slide(self):
        blank_slide_layout = self.prs.slide_layouts[6]
        return self.prs.slides.add_slide(blank_slide_layout)

    def add_text_element(self, slide, text: str, bbox: List[int], text_level: str = "default"):
        x0, y0, x1, y1 = bbox
        left = self._to_emu_x(x0)
        top = self._to_emu_y(y0)
        width = self._to_emu_x(x1 - x0)
        height = self._to_emu_y(y1 - y0)

        textbox = slide.shapes.add_textbox(left, top, width, height)
        text_frame = textbox.text_frame
        text_frame.clear()
        text_frame.word_wrap = True

        paragraph = text_frame.paragraphs[0]
        run = paragraph.add_run()
        run.text = text

        font = run.font
        font.bold = text_level == "title"

        target_px = max(12, int((y1 - y0) * 0.6))
        font.size = Pt(max(8, int(target_px * self._pt_per_px)))

    def add_image_element(self, slide, image_path: str, bbox: List[int]):
        x0, y0, x1, y1 = bbox
        slide.shapes.add_picture(
            image_path,
            self._to_emu_x(x0),
            self._to_emu_y(y0),
            width=self._to_emu_x(x1 - x0),
            height=self._to_emu_y(y1 - y0),
        )

    def add_table_element(self, slide, html_table, bbox: List[int]):
        data = self._normalize_table(html_table)
        if not data:
            raise ValueError("No table data extracted")

        rows = len(data)
        cols = max(len(row) for row in data)

        x0, y0, x1, y1 = bbox
        left = self._to_emu_x(x0)
        top = self._to_emu_y(y0)
        width = self._to_emu_x(x1 - x0)
        height = self._to_emu_y(y1 - y0)

        table_shape = slide.shapes.add_table(rows, cols, left, top, width, height)
        table = table_shape.table

        cell_height_px = max(1, (y1 - y0) // rows)
        font_size = Pt(max(8, int(cell_height_px * 0.45 * self._pt_per_px)))

        for r in range(rows):
            for c in range(cols):
                cell = table.cell(r, c)
                cell.text = data[r][c] if c < len(data[r]) else ""
                for paragraph in cell.text_frame.paragraphs:
                    for run in paragraph.runs:
                        run.font.size = font_size

    def add_image_placeholder(self, slide, bbox: List[int]):
        x0, y0, x1, y1 = bbox
        shape = slide.shapes.add_shape(
            MSO_SHAPE.RECTANGLE,
            self._to_emu_x(x0),
            self._to_emu_y(y0),
            self._to_emu_x(x1 - x0),
            self._to_emu_y(y1 - y0),
        )
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor(248, 250, 252)
        shape.line.color.rgb = RGBColor(203, 213, 225)
        shape.text_frame.text = "Image not found"

    def get_presentation(self):
        return self.prs

    def save(self, output_file: str):
        self.prs.save(output_file)

    def _to_emu_x(self, px: int):
        return int(px * self._emu_per_px_x)

    def _to_emu_y(self, px: int):
        return int(px * self._emu_per_px_y)

    def _normalize_table(self, html_table) -> List[List[str]]:
        if isinstance(html_table, list):
            return [[str(cell) for cell in row] for row in html_table]

        if not isinstance(html_table, str):
            return []

        parser = _SimpleTableParser()
        parser.feed(html_table)
        return parser.rows

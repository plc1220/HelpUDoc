"""Conservative DOCX edits without rebuilding the uploaded Office package.

Offsets are Unicode codepoints, not JavaScript UTF-16 offsets. Only simple body
and table paragraphs are editable. Unsupported content remains readable and is
never flattened to make an edit succeed.
"""
from __future__ import annotations

from copy import deepcopy
from io import BytesIO
import math
import re
import stat
from typing import Any
from xml.parsers import expat
from zipfile import BadZipFile, ZIP_DEFLATED, ZIP_STORED, ZipFile
import zlib

from lxml import etree


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
V = "urn:schemas-microsoft-com:vml"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_PART_BYTES = 32 * 1024 * 1024
MAX_EXPANDED_BYTES = 128 * 1024 * 1024
MAX_PARTS = 4096
_RPR_ORDER = "rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath rPrChange".split()


class QuickEditError(ValueError):
    """The package or requested edit is outside the supported safe subset."""


def _w(name: str) -> str:
    return f"{{{W}}}{name}"


def _xml(data: bytes) -> etree._Element:
    # OOXML normally uses UTF-8. Excluding other encodings also makes the byte
    # splice used below unambiguous and prevents obfuscated entity declarations.
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise QuickEditError("Quick edits require UTF-8 document XML") from exc
    if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper() or "\x00" in text:
        raise QuickEditError("Document XML must not contain entity declarations")
    declaration = re.match(r"\s*<\?xml\s+[^?]*encoding\s*=\s*['\"]([^'\"]+)", text, re.IGNORECASE)
    if declaration and declaration[1].lower() not in ("utf-8", "utf8", "us-ascii", "ascii"):
        raise QuickEditError("Quick edits require UTF-8 document XML")
    try:
        root = etree.fromstring(data, parser=etree.XMLParser(
            resolve_entities=False, load_dtd=False, no_network=True, huge_tree=False,
        ))
    except etree.XMLSyntaxError as exc:
        raise QuickEditError("Invalid document XML") from exc
    return root


class _Package:
    def __init__(self, data: bytes):
        if not isinstance(data, bytes) or len(data) > MAX_ARCHIVE_BYTES:
            raise QuickEditError("DOCX exceeds the 50 MB quick edit limit")
        try:
            with ZipFile(BytesIO(data)) as source:
                self.infos = source.infolist()
                self.comment = source.comment
                if len(self.infos) > MAX_PARTS:
                    raise QuickEditError("DOCX contains too many package parts")
                self.parts: dict[str, bytes] = {}
                expanded = 0
                for info in self.infos:
                    name = info.filename
                    if (not name or name.startswith("/") or "\\" in name or ":" in name
                            or "\x00" in name or any(p in (".", "..") for p in name.split("/"))
                            or name in self.parts or stat.S_ISLNK(info.external_attr >> 16)):
                        raise QuickEditError("DOCX contains unsafe or duplicate package paths")
                    expanded += info.file_size
                    if (info.file_size > MAX_PART_BYTES or expanded > MAX_EXPANDED_BYTES
                            or (info.file_size > 1024 * 1024 and info.file_size > 200 * max(1, info.compress_size))):
                        raise QuickEditError("DOCX expanded content exceeds quick edit limits")
                    if info.flag_bits & 1 or info.compress_type not in (ZIP_STORED, ZIP_DEFLATED):
                        raise QuickEditError("Encrypted or unsupported DOCX package")
                    self.parts[name] = source.read(info)
        except (BadZipFile, RuntimeError, NotImplementedError, OSError, zlib.error) as exc:
            raise QuickEditError("Invalid DOCX package") from exc
        if "word/document.xml" not in self.parts or "[Content_Types].xml" not in self.parts:
            raise QuickEditError("The file is not a supported DOCX package")
        self.document = _xml(self.parts["word/document.xml"])
        if self.document.tag != _w("document"):
            raise QuickEditError("Unsupported Word document namespace")
        self.styles = _xml(self.parts.get("word/styles.xml", f'<w:styles xmlns:w="{W}"/>'.encode()))
        self.settings = _xml(self.parts.get("word/settings.xml", f'<w:settings xmlns:w="{W}"/>'.encode()))
        self.paragraphs = list(self.document.iter(_w("p")))
        style_nodes = [s for s in self.styles.findall(_w("style")) if s.get(_w("styleId"))]
        self.style_map = {s.get(_w("styleId")): s for s in style_nodes}
        if len(self.style_map) != len(style_nodes):
            raise QuickEditError("Document contains ambiguous style IDs")
        self.default_style = next((key for key, style in self.style_map.items()
                                   if style.get(_w("type")) == "paragraph" and _on(style, "default") is True), None)
        self.locked = (
            any(_on(node, "enforcement") is True for node in self.settings.findall(_w("documentProtection")))
            or any(_on(node) is not False for node in self.settings.findall(_w("trackRevisions")))
            or any(name.startswith("_xmlsignatures/") for name in self.parts)
        )
        # A complex field (for example a table of contents) can span paragraphs;
        # its middle paragraphs need protection even when they only contain text.
        self.field_paragraphs: set[etree._Element] = set()
        field_depth, paragraph_stack = 0, []
        for event, node in etree.iterwalk(self.document, events=("start", "end")):
            if node.tag == _w("p"):
                if event == "start":
                    paragraph_stack.append(node)
                    if field_depth:
                        self.field_paragraphs.add(node)
                else:
                    paragraph_stack.pop()
            elif event == "start" and node.tag == _w("fldChar"):
                self.field_paragraphs.update(paragraph_stack)
                kind = node.get(_w("fldCharType"))
                if kind == "begin":
                    field_depth += 1
                elif kind == "end":
                    field_depth = max(0, field_depth - 1)

    def write_paragraph(self, index: int) -> bytes:
        original = self.parts["word/document.xml"]
        spans = _paragraph_spans(original)
        if len(spans) != len(self.paragraphs):
            raise QuickEditError("Document paragraph locations could not be verified")
        start, end = spans[index]
        replacement = etree.tostring(self.paragraphs[index], encoding="UTF-8", with_tail=False)
        updated = original[:start] + replacement + original[end:]
        result = BytesIO()
        with ZipFile(result, "w") as target:
            target.comment = self.comment
            for info in self.infos:
                target.writestr(info, updated if info.filename == "word/document.xml" else self.parts[info.filename])
        return result.getvalue()


def _paragraph_spans(data: bytes) -> list[tuple[int, int]]:
    """Locate lexical paragraph boundaries so unrelated XML bytes stay intact."""
    parser = expat.ParserCreate(namespace_separator="}")
    spans: list[tuple[int, int]] = []
    active: list[tuple[int, int, int, bool]] = []

    def start(name: str, _attrs: dict[str, str]) -> None:
        if name != W + "}p":
            return
        opening = parser.CurrentByteIndex
        cursor, quote = opening, None
        while cursor < len(data):
            byte = data[cursor]
            if quote:
                if byte == quote:
                    quote = None
            elif byte in (34, 39):
                quote = byte
            elif byte == 62:
                break
            cursor += 1
        end = cursor + 1
        active.append((len(spans), opening, end, data[opening:end].rstrip().endswith(b"/>")))
        spans.append((opening, end))

    def end(name: str) -> None:
        if name == W + "}p":
            index, opening, opening_end, empty = active.pop()
            closing_end = opening_end if empty else data.index(b">", parser.CurrentByteIndex) + 1
            spans[index] = (opening, closing_end)

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.Parse(data, True)
    return spans


def _on(element: etree._Element, attribute: str = "val") -> bool | None:
    value = element.get(_w(attribute))
    if value is None:
        return True if attribute == "val" else None
    if value.lower() in ("true", "1", "on"):
        return True
    if value.lower() in ("false", "0", "off"):
        return False
    return None


def _text(paragraph: etree._Element) -> str:
    return "".join(node.text or "" for node in paragraph.iter(_w("t")))


def _editable(package: _Package, paragraph: etree._Element) -> bool:
    if package.locked or paragraph in package.field_paragraphs or any(parent.tag not in {_w(n) for n in ("document", "body", "tbl", "tr", "tc")} for parent in paragraph.iterancestors()):
        return False
    if len(paragraph.findall(_w("pPr"))) > 1:
        return False
    def has_revision(element: etree._Element) -> bool:
        return any(str(node.tag).endswith("Change") or node.tag in {
            _w(name) for name in ("ins", "del", "moveFrom", "moveTo", "cellIns", "cellDel", "cellMerge")
        } for node in element.iter())

    for ancestor in paragraph.iterancestors():
        for property_name in ("tblPr", "trPr", "tcPr"):
            properties = ancestor.find(_w(property_name))
            if properties is not None and has_revision(properties):
                return False
    for child in paragraph:
        if child.tag == _w("pPr"):
            if has_revision(child):
                return False
        elif child.tag == _w("r"):
            if len(child.findall(_w("rPr"))) > 1 or any(node.tag not in (_w("rPr"), _w("t")) for node in child):
                return False
            if has_revision(child):
                return False
        else:
            return False
    return True


def _style_id(package: _Package, paragraph: etree._Element) -> str | None:
    style = paragraph.find(f"{_w('pPr')}/{_w('pStyle')}")
    return style.get(_w("val")) if style is not None else package.default_style


def _properties(values: dict[str, Any], properties: etree._Element | None, *, toggle: bool = False) -> None:
    if properties is None:
        return
    for tag, key in (("b", "bold"), ("i", "italic")):
        node = properties.find(_w(tag))
        if node is not None:
            value = _on(node)
            if toggle:
                if value:
                    values[key] = not bool(values[key])
            else:
                values[key] = value
    size = properties.find(_w("sz"))
    if size is not None:
        try:
            value = float(size.get(_w("val"), "")) / 2
            if math.isfinite(value) and value > 0:
                values["fontSize"] = value
        except ValueError:
            pass


def _style_properties(package: _Package, values: dict[str, Any], style_id: str | None) -> None:
    chain, visited = [], set()
    while style_id in package.style_map and style_id not in visited:
        visited.add(style_id)
        style = package.style_map[style_id]
        chain.append(style)
        based = style.find(_w("basedOn"))
        style_id = based.get(_w("val")) if based is not None else None
    for style in reversed(chain):
        _properties(values, style.find(_w("rPr")), toggle=True)


def _protected_texts(package: _Package) -> tuple[list[str], bool]:
    """Text which a PDF selection could hit but which is never a body edit target.

    Consumers must include these strings when rejecting ambiguous quote matches.
    Word can update fields during rendering: cached strings alone cannot identify
    the origin of page numbers or other generated text, hence hasDynamicFields.
    """
    texts: dict[str, None] = {}
    has_fields = False
    text_tags = {_w("t"), _w("delText"), f"{{{A}}}t", f"{{{M}}}t"}

    def add(value: str | None) -> None:
        if value and value.strip():
            texts[value] = None

    def visible_text(element: etree._Element) -> str:
        return "".join(
            (node.text or "") if node.tag in text_tags
            else " " if node.tag in (_w("tab"), _w("br"), _w("cr"), f"{{{A}}}br")
            else "" for node in element.iter()
        )

    for name, payload in package.parts.items():
        if not name.startswith("word/") or not name.endswith(".xml"):
            continue
        root = package.document if name == "word/document.xml" else _xml(payload)
        for node in root.iter():
            if node.tag in (_w("fldChar"), _w("fldSimple"), _w("instrText")):
                has_fields = True
            if node.tag == _w("p"):
                if name != "word/document.xml" or not _editable(package, node):
                    add(visible_text(node))
            elif node.tag in (f"{{{A}}}p", f"{{{M}}}oMath"):
                add(visible_text(node))
            elif node.tag in (f"{{{A}}}t", f"{{{M}}}t", f"{{{C}}}v", _w("delText")):
                # Also retain single text segments: these may be separate visual
                # objects, cached chart labels, or revision text on the preview.
                add(node.text)
            elif node.tag == f"{{{V}}}textpath":
                add(node.get("string"))
    return list(texts), has_fields


def _body_bounds(package: _Package) -> dict[str, float]:
    """Intersection of section content boxes, normalized to each page's size.

    This supplies a conservative header/footer exclusion zone for the PDF UI,
    not a source-text identity proof. Footnotes still occur inside this box.
    """
    def twips(value: str | None, fallback: float) -> float:
        if value is None:
            return fallback
        match = re.fullmatch(r"(-?\d+(?:\.\d+)?)(pt|in|cm|mm|pc|pi)?", value)
        if not match:
            raise ValueError("Invalid page measurement")
        factor = {None: 1, "pt": 20, "in": 1440, "cm": 1440 / 2.54, "mm": 1440 / 25.4, "pc": 240, "pi": 240}[match[2]]
        result = float(match[1]) * factor
        if not math.isfinite(result):
            raise ValueError("Invalid page measurement")
        return result

    bounds = {"left": 0.0, "top": 0.0, "right": 1.0, "bottom": 1.0}
    empty = {"left": 1.0, "top": 1.0, "right": 0.0, "bottom": 0.0}
    mirrored = package.settings.find(_w("mirrorMargins"))
    top_gutter = package.settings.find(_w("gutterAtTop"))
    sections = list(package.document.iter(_w("sectPr"))) or [etree.Element(_w("sectPr"))]
    try:
        for section in sections:
            page = section.find(_w("pgSz"))
            margins = section.find(_w("pgMar"))
            width = twips(page.get(_w("w")) if page is not None else None, 12240)
            height = twips(page.get(_w("h")) if page is not None else None, 15840)
            if width <= 0 or height <= 0:
                return empty
            values = {side: twips(margins.get(_w(side)) if margins is not None else None, 1440)
                      for side in ("left", "top", "right", "bottom")}
            gutter = twips(margins.get(_w("gutter")) if margins is not None else None, 0)
            if values["left"] < 0 or values["right"] < 0 or gutter < 0:
                return empty
            # Signed top/bottom margins still use their absolute distance from
            # the page edge; a negative value changes header overlap behavior.
            values["top"], values["bottom"] = abs(values["top"]), abs(values["bottom"])
            if mirrored is not None and _on(mirrored) is not False:
                values["left"] = values["right"] = max(values["left"], values["right"])
            if top_gutter is not None and _on(top_gutter) is not False:
                values["top"] += gutter
            else:
                # Binding side varies with section direction and page parity.
                values["left"] += gutter
                values["right"] += gutter
            bounds["left"] = max(bounds["left"], values["left"] / width)
            bounds["top"] = max(bounds["top"], values["top"] / height)
            bounds["right"] = min(bounds["right"], 1 - values["right"] / width)
            bounds["bottom"] = min(bounds["bottom"], 1 - values["bottom"] / height)
    except ValueError:
        return empty
    return bounds if bounds["left"] < bounds["right"] and bounds["top"] < bounds["bottom"] else empty


def inspect_docx(data: bytes) -> dict[str, Any]:
    package = _Package(data)
    paragraphs = []
    for index, paragraph in enumerate(package.paragraphs):
        runs, offset = [], 0
        style_id = _style_id(package, paragraph)
        for run in paragraph.iter(_w("r")):
            text = "".join(t.text or "" for t in run.findall(_w("t")))
            values = {"bold": None, "italic": None, "fontSize": None}
            _properties(values, package.styles.find(f"{_w('docDefaults')}/{_w('rPrDefault')}/{_w('rPr')}"))
            _style_properties(package, values, style_id)
            rpr = run.find(_w("rPr"))
            character_style = rpr.find(_w("rStyle")) if rpr is not None else None
            if character_style is not None:
                _style_properties(package, values, character_style.get(_w("val")))
            _properties(values, rpr)
            if text:
                runs.append({"start": offset, "end": offset + len(text), **values})
            offset += len(text)
        paragraphs.append({"id": f"p:{index}", "text": _text(paragraph), "styleId": style_id,
                           "editable": _editable(package, paragraph), "runs": runs})
    protected_texts, has_fields = _protected_texts(package)
    return {"paragraphs": paragraphs, "protectedTexts": protected_texts, "hasDynamicFields": has_fields,
            "bodyBounds": _body_bounds(package), "styles": [
        {"id": key, "name": style.find(_w("name")).get(_w("val"), key) if style.find(_w("name")) is not None else key}
        for key, style in package.style_map.items() if style.get(_w("type")) == "paragraph"
    ]}


def _set_run_property(run: etree._Element, name: str, value: str) -> None:
    properties = run.find(_w("rPr"))
    if properties is None:
        properties = etree.Element(_w("rPr"))
        run.insert(0, properties)
    for old in properties.findall(_w(name)):
        properties.remove(old)
    node = etree.Element(_w(name))
    node.set(_w("val"), value)
    rank = _RPR_ORDER.index(name)
    for index, child in enumerate(properties):
        local = str(child.tag).split("}")[-1]
        if local in _RPR_ORDER and _RPR_ORDER.index(local) > rank:
            properties.insert(index, node)
            break
    else:
        properties.append(node)


def _run_piece(run: etree._Element, text: str) -> etree._Element:
    piece = deepcopy(run)
    for child in list(piece):
        if child.tag == _w("t"):
            piece.remove(child)
    node = etree.SubElement(piece, _w("t"))
    node.text = text
    node.set(XML_SPACE, "preserve")
    piece.tail = None
    return piece


def apply_docx_edit(data: bytes, edit: dict[str, Any]) -> bytes:
    package = _Package(data)
    if not isinstance(edit, dict):
        raise QuickEditError("A quick edit object is required")
    identifier = edit.get("paragraphId")
    if not isinstance(identifier, str) or not re.fullmatch(r"p:(0|[1-9][0-9]{0,6})", identifier):
        raise QuickEditError("Invalid paragraph ID")
    index = int(identifier[2:])
    if index >= len(package.paragraphs):
        raise QuickEditError("The selected paragraph no longer exists")
    paragraph = package.paragraphs[index]
    if not _editable(package, paragraph):
        raise QuickEditError("This paragraph contains protected or unsupported content; use the agent to edit it")
    text = _text(paragraph)
    start, end, quote = edit.get("start"), edit.get("end"), edit.get("quote")
    if (type(start) is not int or type(end) is not int or not 0 <= start < end <= len(text)
            or not isinstance(quote, str) or text[start:end] != quote):
        raise QuickEditError("The selected text has changed; select it again")
    action, value = edit.get("action"), edit.get("value")
    if action in ("bold", "italic"):
        if type(value) is not bool:
            raise QuickEditError("Bold and italic require a boolean value")
    elif action == "fontSize":
        if type(value) not in (int, float) or not math.isfinite(value) or not 1 <= value <= 400 or value * 2 != int(value * 2):
            raise QuickEditError("Font size must be 1–400 points in half-point increments")
    elif action == "replaceText":
        if (not isinstance(value, str) or len(value) > 20000
                or any(ord(c) < 32 or 0xD800 <= ord(c) <= 0xDFFF or ord(c) in (0xFFFE, 0xFFFF, 0x2028, 0x2029) for c in value)):
            raise QuickEditError("Replacement must be plain text within one paragraph (maximum 20,000 characters)")
    elif action == "style":
        if not isinstance(value, str) or value not in package.style_map or package.style_map[value].get(_w("type")) != "paragraph":
            raise QuickEditError("Choose a paragraph style already present in this document")
        properties = paragraph.find(_w("pPr"))
        if properties is None:
            properties = etree.Element(_w("pPr"))
            paragraph.insert(0, properties)
        for old in properties.findall(_w("pStyle")):
            properties.remove(old)
        style = etree.Element(_w("pStyle"))
        style.set(_w("val"), value)
        properties.insert(0, style)
        return package.write_paragraph(index)
    else:
        raise QuickEditError("Unsupported quick edit action")

    offset, replaced = 0, False
    for run in list(paragraph.findall(_w("r"))):
        content = "".join(t.text or "" for t in run.findall(_w("t")))
        run_end = offset + len(content)
        if run_end <= start or offset >= end:
            offset = run_end
            continue
        left, right = max(0, start - offset), min(len(content), end - offset)
        pieces = []
        if left:
            pieces.append(_run_piece(run, content[:left]))
        if action == "replaceText":
            if not replaced:
                if value:
                    pieces.append(_run_piece(run, value))
                replaced = True
        else:
            selected = _run_piece(run, content[left:right])
            names = {"bold": ("b", "bCs"), "italic": ("i", "iCs"), "fontSize": ("sz", "szCs")}[action]
            setting = str(int(value * 2)) if action == "fontSize" else ("1" if value else "0")
            for name in names:
                _set_run_property(selected, name, setting)
            pieces.append(selected)
        if right < len(content):
            pieces.append(_run_piece(run, content[right:]))
        run_index = paragraph.index(run)
        tail = run.tail
        paragraph.remove(run)
        for piece_index, piece in enumerate(pieces):
            paragraph.insert(run_index + piece_index, piece)
        if pieces:
            pieces[-1].tail = tail
        offset = run_end
    return package.write_paragraph(index)

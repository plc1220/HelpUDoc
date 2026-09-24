"""Bounded, read-only Office rendering and revision-aware native quick edits.

Only uploaded OOXML bytes enter the converter. Every render uses an ephemeral
profile, disabled macros and untrusted active objects, a network-denied child process, and
resource limits. Cached previews never replace the original document.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
from collections import OrderedDict
import ctypes
import ctypes.util
import errno
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any
from urllib.parse import unquote
import zipfile

from lxml import etree

MAX_SOURCE_BYTES = 25 * 1024 * 1024
MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_BASE64_LENGTH = ((MAX_SOURCE_BYTES + 2) // 3) * 4
MAX_CACHE_BYTES = 128 * 1024 * 1024
CONVERSION_TIMEOUT = 60
RENDERER_VERSION = "office-pdf-1"


class OfficePreviewError(ValueError):
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def decode_content(content: str) -> bytes:
    if len(content) > MAX_BASE64_LENGTH:
        raise OfficePreviewError("Office files must be 25 MiB or smaller.", 413)
    try:
        result = base64.b64decode(content, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise OfficePreviewError("Document content must be valid base64.", 400) from exc
    if not result or len(result) > MAX_SOURCE_BYTES:
        raise OfficePreviewError("Office files must be between 1 byte and 25 MiB.", 413)
    return result


def source_revision(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def document_format(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix not in {".docx", ".pptx"}:
        raise OfficePreviewError("Office preview supports DOCX and PPTX files.", 400)
    return suffix[1:]


def validate_office(content: bytes, file_format: str, *, _depth: int = 0,
                    _budget: list[int] | None = None) -> None:
    """Reject active/linked content and malformed or unbounded OOXML packages.

    Hyperlinks are safe to retain: they are exported as links, never followed.
    Linked images/templates/OLE, DDE fields and external XML entities are not.
    No ZIP member is ever extracted to a path provided by the document.
    """
    if not content or len(content) > MAX_SOURCE_BYTES:
        raise OfficePreviewError("Office files must be between 1 byte and 25 MiB.", 413)
    # XLSX is accepted only here for inert chart data embedded in DOCX/PPTX;
    # it is never a public preview format or handed to the Calc application.
    main_part = {"docx": "word/document.xml", "pptx": "ppt/presentation.xml", "xlsx": "xl/workbook.xml"}.get(file_format)
    if main_part is None:
        raise OfficePreviewError("Unsupported Office document format.", 400)
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as package:
            entries = package.infolist()
            names = [entry.filename for entry in entries]
            if len(entries) > 4096 or len(set(names)) != len(names):
                raise OfficePreviewError("Document package has too many or duplicate parts.")
            if main_part not in names or "[Content_Types].xml" not in names:
                raise OfficePreviewError("The file is not a valid DOCX or PPTX document.")
            budget = _budget if _budget is not None else [100 * 1024 * 1024]
            budget[0] -= sum(entry.file_size for entry in entries)
            if budget[0] < 0:
                raise OfficePreviewError("Document expands beyond the preview size limit.", 413)
            parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
            embedded_packages: set[str] = set()
            embedded_parts: list[str] = []
            for entry in entries:
                name = entry.filename
                lowered = name.lower()
                parts = PurePosixPath(name).parts
                if ("\\" in name or ":" in name or name.startswith("/") or ".." in parts
                        or entry.flag_bits & 1 or (entry.external_attr >> 16) & 0o170000 == 0o120000):
                    raise OfficePreviewError("Encrypted or unsafe document packages cannot be previewed.")
                if entry.file_size > 25 * 1024 * 1024 or (
                    entry.file_size > 1024 * 1024 and entry.file_size > max(entry.compress_size, 1) * 1000
                ):
                    raise OfficePreviewError("Document part exceeds the preview size limit.", 413)
                if any(part in lowered for part in ("vbaproject", "/activex/", "/macrosheets/")):
                    raise OfficePreviewError("Embedded active objects are not supported in previews. Remove them and upload again.")
                if "/embeddings/" in lowered and not entry.is_dir():
                    embedded_parts.append(name)
                if not lowered.endswith((".xml", ".rels", ".svg", ".vml")):
                    continue
                tree = etree.fromstring(package.read(entry), parser=parser)
                if tree.getroottree().docinfo.doctype:
                    raise OfficePreviewError("Document XML entities are not supported.")
                if lowered.endswith(".rels"):
                    for relation in tree:
                        target = str(relation.get("Target", ""))
                        external = str(relation.get("TargetMode", "")).lower() == "external"
                        decoded_target = unquote(target)
                        absolute = bool(re.match(r"(?:[a-zA-Z][a-zA-Z0-9+.-]*:|[/\\])", decoded_target))
                        hyperlink = str(relation.get("Type", "")).endswith("/hyperlink")
                        if str(relation.get("Type", "")).endswith(("/oleObject", "/control", "/vbaProject")):
                            raise OfficePreviewError("Embedded active object relationships are not supported in previews.")
                        if (external or absolute) and not hyperlink:
                            raise OfficePreviewError("The document contains linked external content. Embed that content before previewing.")
                        if not external and not hyperlink:
                            if "\\" in decoded_target:
                                raise OfficePreviewError("Document links must use package-relative paths.")
                            base = str(PurePosixPath(name).parent.parent)
                            resolved = posixpath.normpath(posixpath.join(base, decoded_target.split("#", 1)[0]))
                            if resolved == ".." or resolved.startswith("../"):
                                raise OfficePreviewError("Document links must remain inside the Office package.")
                            if str(relation.get("Type", "")).endswith("/package"):
                                embedded_packages.add(resolved)
                if tree.xpath("//*[local-name()='altChunk']"):
                    raise OfficePreviewError("Embedded HTML must be converted to native document content before previewing.")
                if tree.xpath("//*[local-name()='oleObject' or local-name()='ddeLink']"):
                    raise OfficePreviewError("Embedded active objects and DDE links are not supported in previews.")
                if name == "[Content_Types].xml" and any(
                    "macroenabled" in str(element.get("ContentType", "")).lower() for element in tree
                ):
                    raise OfficePreviewError("Macro-enabled Office content is not supported in previews.")
                if lowered.endswith((".svg", ".vml")):
                    for reference in tree.xpath("//@*[local-name()='href' or local-name()='src']"):
                        if not reference.startswith("#") and not re.match(r"data:image/(?:png|jpeg|gif);base64,", reference):
                            raise OfficePreviewError("Linked vector image content must be embedded before previewing.")
                    vector_xml = etree.tostring(tree, encoding="unicode")
                    css_urls = re.findall(r"url\((.*?)\)", vector_xml, re.I | re.S)
                    if "@import" in vector_xml.lower() or any(
                        not url.strip().strip("\"'").startswith("#") for url in css_urls
                    ):
                        raise OfficePreviewError("Linked vector image styles must be embedded before previewing.")
                field_text = "".join(
                    element.text or "" for element in tree.iter()
                    if isinstance(element.tag, str) and etree.QName(element).localname == "instrText"
                )
                field_text += " ".join(tree.xpath("//@*[local-name()='instr']"))
                if re.search(r"\b(?:DDEAUTO|DDE|INCLUDETEXT|INCLUDEPICTURE|DATABASE|LINK)\b", field_text, re.I):
                    raise OfficePreviewError("Linked document fields are not supported in previews.")
            for name in embedded_parts:
                if _depth > 0 or name not in embedded_packages or not name.lower().endswith(".xlsx"):
                    raise OfficePreviewError("Only embedded chart workbooks are supported; remove active embedded objects before previewing.")
                validate_office(package.read(name), "xlsx", _depth=_depth + 1, _budget=budget)
    except OfficePreviewError:
        raise
    except (zipfile.BadZipFile, etree.XMLSyntaxError, RuntimeError, OSError, ValueError) as exc:
        raise OfficePreviewError("The Office document is damaged, encrypted, or unsupported.") from exc


def _find_converter() -> str:
    configured = os.environ.get("OFFICE_PREVIEW_SOFFICE")
    converter = configured or shutil.which("libreoffice") or shutil.which("soffice")
    if not converter and Path("/Applications/LibreOffice.app/Contents/MacOS/soffice").is_file():
        converter = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
    if not converter or not Path(converter).is_file():
        raise OfficePreviewError("Office preview is unavailable: LibreOffice is not installed on the server.", 503)
    return str(Path(converter).resolve())


def _write_profile(profile: Path, *, allow_native_charts: bool = False) -> None:
    user = profile / "user"
    user.mkdir(parents=True)
    (user / "registrymodifications.xcu").write_text('''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
  <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
  <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
  <prop oor:name="DisableActiveContent" oor:op="fuse"><value>DISABLE_ACTIVE_CONTENT</value></prop>
  <prop oor:name="DisableOLEAutomation" oor:op="fuse"><value>true</value></prop>
  <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
 </item>
</oor:items>'''.replace("DISABLE_ACTIVE_CONTENT", "false" if allow_native_charts else "true"), encoding="utf-8")


def _deny_linux_network() -> None:
    """Deny internet/packet sockets in this child and all converter descendants."""
    library = ctypes.util.find_library("seccomp")
    if not library:
        raise RuntimeError("Office preview requires libseccomp on Linux")
    seccomp = ctypes.CDLL(library, use_errno=True)
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_syscall_resolve_name.restype = ctypes.c_int
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]

    class Comparison(ctypes.Structure):
        _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int), ("a", ctypes.c_uint64), ("b", ctypes.c_uint64)]

    seccomp.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Comparison)]
    context = seccomp.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not context:
        raise RuntimeError("Could not initialize Office preview network isolation")
    try:
        syscall = seccomp.seccomp_syscall_resolve_name(b"socket")
        rule = Comparison(0, 1, 1, 0)  # SCMP_CMP_NE AF_UNIX: allow local IPC only.
        if syscall < 0 or seccomp.seccomp_rule_add_array(context, 0x00050000 | errno.EPERM, syscall, 1, ctypes.byref(rule)) != 0:
            raise RuntimeError("Could not configure Office preview network isolation")
        if seccomp.seccomp_load(context) != 0:
            raise RuntimeError("Could not enable Office preview network isolation")
    finally:
        seccomp.seccomp_release(context)


def _converter_child(arguments: list[str]) -> None:
    # This runs in a fresh Python process, never a preexec_fn in the threaded API.
    resource.setrlimit(resource.RLIMIT_CPU, (CONVERSION_TIMEOUT, CONVERSION_TIMEOUT))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_PDF_BYTES, MAX_PDF_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        _deny_linux_network()
    elif sys.platform == "darwin":
        arguments = ["/usr/bin/sandbox-exec", "-p",
                     "(version 1)(allow default)(deny network*)(allow network* (local unix-socket) (remote unix-socket))",
                     *arguments]
    else:
        raise RuntimeError("Office preview network isolation is unavailable on this platform")
    os.execv(arguments[0], arguments)


def convert_to_pdf(content: bytes, file_format: str) -> bytes:
    validate_office(content, file_format)
    converter = _find_converter()
    with tempfile.TemporaryDirectory(prefix="helpudoc-office-") as temporary:
        root = Path(temporary)
        source = root / f"document.{file_format}"
        output = root / "output"
        output.mkdir()
        profile = root / "profile"
        # LibreOffice also treats its own native charts as active content.
        # Enable that renderer only after rejecting OLE/controls and validating
        # every chart workbook; macros, OLE automation and networking stay off.
        with zipfile.ZipFile(io.BytesIO(content)) as package:
            has_native_charts = any(
                name.startswith(("word/charts/", "ppt/charts/")) and name.endswith(".xml")
                for name in package.namelist()
            )
        _write_profile(profile, allow_native_charts=has_native_charts)
        source.write_bytes(content)
        export_filter = "writer_pdf_Export" if file_format == "docx" else "impress_pdf_Export"
        command = [
            sys.executable, str(Path(__file__).resolve()), "--convert-child", converter,
            f"-env:UserInstallation={profile.as_uri()}", "--headless", "--nologo", "--nodefault",
            "--norestore", "--nolockcheck", "--convert-to", f"pdf:{export_filter}",
            "--outdir", str(output), str(source),
        ]
        # Do not expose service credentials or authenticated proxy configuration.
        environment = {"PATH": os.defpath, "HOME": temporary, "TMPDIR": temporary, "LANG": "C.UTF-8", "SAL_USE_VCLPLUGIN": "svp"}
        process = subprocess.Popen(command, cwd=root, env=environment, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            process.wait(timeout=CONVERSION_TIMEOUT)
        except subprocess.TimeoutExpired as exc:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise OfficePreviewError("Office preview timed out. Try a smaller document.", 504) from exc
        finally:
            # A converter must not leave background descendants holding temp files.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        result = output / "document.pdf"
        if process.returncode != 0 or not result.is_file():
            raise OfficePreviewError("The document could not be rendered. It may be encrypted or contain unsupported content.")
        if result.stat().st_size > MAX_PDF_BYTES:
            raise OfficePreviewError("The rendered document exceeds the preview size limit.", 413)
        pdf = result.read_bytes()
        if not pdf.startswith(b"%PDF-"):
            raise OfficePreviewError("Office conversion did not produce a valid PDF.")
        return pdf


class OfficePreviewService:
    def __init__(self, *, converter=convert_to_pdf, cache_bytes: int = MAX_CACHE_BYTES, concurrency: int = 1):
        self.converter = converter
        self.cache_bytes = cache_bytes
        self._cache: OrderedDict[str, tuple[dict[str, Any], int, float]] = OrderedDict()
        self._cache_size = 0
        self._pending: dict[str, asyncio.Task] = {}
        self._edits_pending = 0
        self._semaphore = asyncio.Semaphore(concurrency)

    async def preview(self, filename: str, content: bytes) -> dict[str, Any]:
        file_format = document_format(filename)
        revision = await asyncio.to_thread(source_revision, content)
        key = f"{RENDERER_VERSION}:{file_format}:{revision}"
        cached = self._cache.pop(key, None)
        if cached:
            if time.monotonic() - cached[2] < 900:
                self._cache[key] = cached
                return cached[0]
            self._cache_size -= cached[1]
        task = self._pending.get(key)
        if task is None:
            if len(self._pending) >= 8:
                raise OfficePreviewError("Office preview is busy. Please try again shortly.", 503)
            task = asyncio.create_task(self._build(key, file_format, revision, content))
            self._pending[key] = task
            # Retrieve exceptions even if every waiting client disconnected.
            task.add_done_callback(lambda completed: completed.exception() if not completed.cancelled() else None)
        return await asyncio.shield(task)

    async def _build(self, key: str, file_format: str, revision: str, content: bytes) -> dict[str, Any]:
        try:
            async with self._semaphore:
                await asyncio.to_thread(validate_office, content, file_format)
                pdf = await asyncio.to_thread(self.converter, content, file_format)
                encoded_pdf = await asyncio.to_thread(lambda: base64.b64encode(pdf).decode("ascii"))
                result: dict[str, Any] = {"pdf": encoded_pdf, "revision": revision}
                if file_format == "docx":
                    from helpudoc_agent.document_quick_edit import inspect_docx
                    # A document can render correctly while its XML encoding or
                    # structures lie outside the deliberately narrow edit subset.
                    try:
                        result["document"] = await asyncio.to_thread(inspect_docx, content)
                    except ValueError:
                        pass
            size = await asyncio.to_thread(lambda: len(json.dumps(result)))
            if size <= self.cache_bytes:
                while self._cache and (self._cache_size + size > self.cache_bytes or len(self._cache) >= 16):
                    _, (_, removed_size, _) = self._cache.popitem(last=False)
                    self._cache_size -= removed_size
                self._cache[key] = (result, size, time.monotonic())
                self._cache_size += size
            return result
        finally:
            self._pending.pop(key, None)

    async def edit(self, filename: str, content: bytes, revision: str, edit: dict[str, Any]) -> dict[str, str]:
        if document_format(filename) != "docx":
            raise OfficePreviewError("Quick edits currently support DOCX files.", 400)
        if self._edits_pending >= 8:
            raise OfficePreviewError("Document editing is busy. Please try again shortly.", 503)
        self._edits_pending += 1
        try:
            async with self._semaphore:
                if await asyncio.to_thread(source_revision, content) != revision:
                    raise OfficePreviewError("The document has changed. Refresh the preview before editing.", 409)
                await asyncio.to_thread(validate_office, content, "docx")
                from helpudoc_agent.document_quick_edit import apply_docx_edit
                updated = await asyncio.to_thread(apply_docx_edit, content, edit)
                return await asyncio.to_thread(lambda: {
                    "content": base64.b64encode(updated).decode("ascii"), "revision": source_revision(updated),
                })
        finally:
            self._edits_pending -= 1


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--convert-child":
        _converter_child(sys.argv[2:])
    else:
        raise SystemExit("This module is only invoked as the Office conversion child.")

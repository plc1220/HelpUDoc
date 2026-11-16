from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import io
import json
from pathlib import Path
from types import SimpleNamespace
import time
import zipfile

from docx import Document
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
import pytest

from helpudoc_agent import calendar_document_text as reader
from helpudoc_agent.api.routes.internal import register_internal_routes

PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def pdf_bytes(pages=1, text="Native fixture PDF evidence"):
    writer = PdfWriter()
    for _ in range(pages):
        page = writer.add_blank_page(300, 200)
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
        content = DecodedStreamObject()
        content.set_data(f"BT /F1 12 Tf 10 100 Td ({text}) Tj ET".encode())
        page[NameObject("/Contents")] = writer._add_object(content)
    output = io.BytesIO(); writer.write(output); return output.getvalue()


def docx_bytes(paragraphs=1, text="Native fixture DOCX evidence"):
    document = Document()
    for _ in range(paragraphs):
        document.add_paragraph(text)
    document.sections[0].header.paragraphs[0].text = "HEADER MUST NOT BE REVIEWED"
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "Approved requirement"; table.cell(0, 1).text = "Confirmed owner"
    output = io.BytesIO(); document.save(output); return output.getvalue()


def jwt(secret="fixture-secret", user="fixture-user"):
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    header = encode({"alg": "HS256"}); payload = encode({"userId": user, "exp": int(time.time()) + 60})
    signature = base64.urlsafe_b64encode(hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return f"{header}.{payload}.{signature}"


def client():
    app = FastAPI()
    register_internal_routes(app, settings=SimpleNamespace(), registry=SimpleNamespace(), memory_store_manager=SimpleNamespace(), agent_jwt_secret="fixture-secret")
    return TestClient(app)


def test_generated_pdf_native_text_uses_real_isolated_reader():
    result = asyncio.run(reader.extract_document_text(pdf_bytes(), PDF))
    assert "Native fixture PDF evidence" in result["text"]
    assert "[Page 1]" in result["text"]
    assert any("OCR" in gap for gap in result["gaps"])
    assert len(result["text"]) <= 12000


def test_generated_docx_paragraphs_tables_and_excluded_header():
    result = asyncio.run(reader.extract_document_text(docx_bytes(), DOCX))
    assert "Native fixture DOCX evidence" in result["text"]
    assert "Approved requirement" in result["text"]
    assert "HEADER MUST NOT BE REVIEWED" not in result["text"]
    assert any("headers" in gap for gap in result["gaps"])


def test_pdf_page_budget_and_docx_paragraph_budget_are_disclosed():
    result = asyncio.run(reader.extract_document_text(pdf_bytes(12), PDF))
    assert "[Page 10]" in result["text"] and "[Page 11]" not in result["text"]
    assert any("first 10 of 12" in gap for gap in result["gaps"])
    result = asyncio.run(reader.extract_document_text(docx_bytes(220, "Short paragraph"), DOCX))
    assert "[Paragraph 200]" in result["text"] and "[Paragraph 201]" not in result["text"]
    assert any("first 200" in gap for gap in result["gaps"])


def test_input_limits_and_docx_bomb_or_external_entity_fail_closed():
    with pytest.raises(reader.DocumentTextError) as error:
        asyncio.run(reader.extract_document_text(b"x" * (reader.MAX_INPUT_BYTES + 1), PDF))
    assert error.value.status_code == 413
    for xml in (b"a" * (9 * 1024 * 1024), b'<!DOCTYPE x [<!ENTITY leak SYSTEM "http://example.invalid/secret">]><x>&leak;</x>'):
        package = io.BytesIO()
        with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as target:
            target.writestr("word/document.xml", xml)
        with pytest.raises(reader.DocumentTextError):
            asyncio.run(reader.extract_document_text(package.getvalue(), DOCX))
    with pytest.raises(reader.DocumentTextError):
        reader.decode_content("not base64")


def test_worker_environment_drops_secrets_and_ephemeral_directory_is_removed(tmp_path, monkeypatch):
    worker = tmp_path / "fixed_environment_worker.py"
    worker.write_text('import json,os,sys\nsys.stdin.buffer.read()\nprint(json.dumps({"text":os.getenv("GOOGLE_API_KEY","absent"),"gaps":[]}))\n')
    monkeypatch.setattr(reader, "_WORKER", worker)
    monkeypatch.setenv("GOOGLE_API_KEY", "must-not-reach-worker")
    monkeypatch.setenv("AGENT_JWT_SECRET", "must-not-reach-worker")
    monkeypatch.setenv("HTTPS_PROXY", "must-not-reach-worker")
    original = asyncio.create_subprocess_exec
    directories = []

    async def record(*args, **kwargs):
        assert "GOOGLE_API_KEY" not in kwargs["env"] and "AGENT_JWT_SECRET" not in kwargs["env"] and "HTTPS_PROXY" not in kwargs["env"]
        if args[0] != "/bin/ps":
            assert args[1:3] == ("-I", "-B") and args[-1] == "pdf"
            directories.append(Path(kwargs["cwd"]))
        else:
            assert args[1:4] == ("-o", "rss=", "-p") and str(args[4]).isdigit()
        return await original(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", record)
    assert asyncio.run(reader.extract_document_text(b"provided bytes", PDF))["text"] == "absent"
    assert directories and not directories[0].exists()


def test_timeout_and_stdout_limit_kill_worker_and_cleanup(tmp_path, monkeypatch):
    worker = tmp_path / "fixed_slow_worker.py"
    worker.write_text('import sys,time\nsys.stdin.buffer.read()\ntime.sleep(60)\n')
    monkeypatch.setattr(reader, "_WORKER", worker)
    original = asyncio.create_subprocess_exec
    processes, directories = [], []

    async def record(*args, **kwargs):
        process = await original(*args, **kwargs)
        if args[0] != "/bin/ps":
            processes.append(process); directories.append(Path(kwargs["cwd"]))
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", record)
    with pytest.raises(reader.DocumentTextError) as error:
        asyncio.run(reader.extract_document_text(b"provided bytes", PDF, timeout_seconds=0.15))
    assert error.value.code == "DOCUMENT_TEXT_TIMEOUT"
    assert processes[0].returncode is not None and not directories[0].exists()
    worker.write_text('import sys\nsys.stdin.buffer.read()\nsys.stdout.buffer.write(b"x"*100000)\n')
    with pytest.raises(reader.DocumentTextError) as error:
        asyncio.run(reader.extract_document_text(b"provided bytes", PDF))
    assert error.value.code == "DOCUMENT_TEXT_LIMIT"
    assert all(process.returncode is not None for process in processes)
    assert all(not directory.exists() for directory in directories)


def test_real_worker_fences_network_subprocesses_writes_and_sets_resource_caps(tmp_path, monkeypatch):
    original_worker = str(reader._WORKER)
    worker = tmp_path / "fixed_limits_probe.py"
    worker.write_text(f'''import json,runpy,sys,resource,os
namespace=runpy.run_path({original_worker!r})
namespace['limits']()
import socket,subprocess
blocked=[]
for name,operation in [('network',lambda:socket.socket()),('subprocess',lambda:subprocess.Popen(['/bin/true'])),('write',lambda:open('should-not-exist','w'))]:
 try: operation()
 except PermissionError: blocked.append(name)
assert blocked==['network','subprocess','write']
if sys.platform=='darwin': assert os.environ.get('CALENDAR_DOCUMENT_RSS_WATCHDOG')=='1'
else: assert resource.getrlimit(resource.RLIMIT_AS)[0]==512*1024*1024
assert resource.getrlimit(resource.RLIMIT_CPU)[0]==5
print(json.dumps({{'text':'limits verified','gaps':[]}}))
''')
    monkeypatch.setattr(reader, "_WORKER", worker)
    assert asyncio.run(reader.extract_document_text(b"provided bytes", PDF))["text"] == "limits verified"


def test_sampled_memory_watchdog_fails_closed_on_excess_or_unobservable_rss(tmp_path, monkeypatch):
    worker = tmp_path / "fixed_memory_probe.py"
    worker.write_text('import sys,time\nsys.stdin.buffer.read()\ntime.sleep(60)\n')
    monkeypatch.setattr(reader, "_WORKER", worker)
    monkeypatch.setattr(reader, "_RSS_WATCHDOG", True)

    async def excess(pid, directory):
        assert pid > 0 and Path(directory).is_dir()
        return reader._RSS_LIMIT_KIB + 1

    monkeypatch.setattr(reader, "_rss_kib", excess)
    with pytest.raises(reader.DocumentTextError) as error:
        asyncio.run(reader.extract_document_text(b"provided bytes", PDF))
    assert error.value.code == "DOCUMENT_TEXT_LIMIT"

    async def unobservable(pid, directory):
        raise reader.DocumentTextError("DOCUMENT_TEXT_UNSUPPORTED", 503)

    monkeypatch.setattr(reader, "_rss_kib", unobservable)
    with pytest.raises(reader.DocumentTextError) as error:
        asyncio.run(reader.extract_document_text(b"provided bytes", PDF))
    assert error.value.code == "DOCUMENT_TEXT_UNSUPPORTED"


def test_signed_route_accepts_bytes_only_and_denies_paths_urls_invalid_auth_or_overlimit():
    api = client(); url = "/internal/calendar/document-text"
    payload = {"filename": "fixture.pdf", "mime_type": PDF, "content": base64.b64encode(pdf_bytes()).decode()}
    assert api.post(url, json=payload).status_code == 401
    assert api.post(url, headers={"Authorization": f"Bearer {jwt('wrong')}"}, json=payload).status_code == 401
    headers = {"Authorization": f"Bearer {jwt()}"}
    response = api.post(url, headers=headers, json=payload)
    assert response.status_code == 200 and "Native fixture PDF evidence" in response.json()["text"]
    assert api.post(url, headers=headers, json={**payload, "path": "/etc/passwd"}).status_code == 422
    assert api.post(url, headers=headers, json={**payload, "url": "https://example.invalid"}).status_code == 422
    assert api.post(url, headers=headers, json={**payload, "filename": "../fixture.pdf"}).status_code == 422
    assert api.post(url, headers=headers, json={**payload, "content": "x" * (reader.MAX_BASE64_LENGTH + 1)}).status_code in {413, 422}

#!/usr/bin/env python3
"""Local process/CLI fault injection; not an S3 integration rehearsal."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap

script = Path(__file__).resolve().parents[2] / "scripts/migrate_minio_to_rustfs.sh"
stub = r'''
import json
import os
from pathlib import Path
import sys

name = Path(sys.argv[0]).name
args = sys.argv[1:]
case = os.environ["FAULT"]
log = Path(os.environ["TRACE"])
with log.open("a") as out:
    print(name, *args, file=out)
if name == "lsof":
    if case == "inventory":
        print("lsof: service unavailable", file=sys.stderr)
        sys.exit(1)
    if case == "host-active":
        print("12345")
        sys.exit(0)
    sys.exit(1)
if name == "pgrep":
    if case == "pgrep-error":
        print("pgrep: could not read process table", file=sys.stderr)
        sys.exit(2)
    sys.exit(1)
if name != "docker":
    sys.exit(91)
if args[0] == "ps":
    if case == "docker-inventory":
        print("docker daemon unavailable", file=sys.stderr)
        sys.exit(1)
    if case == "compose-active" and "label=com.docker.compose.service=backend" in args:
        print("abcdef012345")
    if case in {"stop-fails", "stop-lies", "stop-works"} and any("name=^/helpudoc-langfuse" in s for s in args):
        if case != "stop-works" or "docker stop " not in log.read_text():
            print("abcdef012345")
    sys.exit(0)
if args[0] == "stop":
    sys.exit(4 if case == "stop-fails" else 0)
if args[0] != "run":
    sys.exit(90)
op = args[args.index("/dev/null") + 1]
if op == "copy":
    sys.exit(0)
if op == "size":
    print("Total objects: 1")
    sys.exit(0)
side, _, bucket = ([s for s in args if s.startswith(("minio:", "rustfs:"))][0]).partition(":")
if op == "lsjson":
    if case == "report-error" and side == "rustfs" and bucket == "langfuse":
        print("{")
        sys.exit(0)
    if case == "empty-bucket-error" and bucket == "langfuse":
        print("[]")
        sys.exit(0)
    expected = {"Path": f"{bucket}/existing file", "Size": 10, "MimeType": "application/octet-stream",
                "Metadata": {"helpudoc-sha256": "fixture"}}
    rows = [expected]
    if side == "rustfs" and bucket == "langfuse":
        if case == "missing":
            rows = []
        if case == "metadata":
            expected["Metadata"] = {"helpudoc-sha256": "not-the-same"}
        if case == "ctype":
            expected["MimeType"] = "text/plain"
    if side == "rustfs":
        rows.append({"Path": f"{bucket}/rustfs-only", "Size": 4, "MimeType": "text/plain"})
    print(json.dumps(rows))
    sys.exit(0)
if op == "check":
    if "--one-way" not in args or "--download" not in args:
        sys.exit(90)
    if case == "empty-bucket-error" and bucket == "langfuse":
        sys.exit(9)
    if case == "incomplete" and bucket == "langfuse":
        sys.exit(0)
    if case == "changed-bytes" and bucket == "langfuse":
        print(f"* {bucket}/existing file")
        sys.exit(1)
    print(f"= {bucket}/existing file")
    if case == "matching-output-error" and bucket == "langfuse":
        sys.exit(9)
    sys.exit(0)
sys.exit(91)
'''
cases = {
    "good": ("verify", True, "only in RustFS", "PASS"),
    "matching-output-error": ("verify", False, "langfuse: rclone check failed (exit 9)", ""),
    "empty-bucket-error": ("verify", False, "langfuse: rclone check failed (exit 9)", ""),
    "incomplete": ("verify", False, "identical in RustFS: 0", ""),
    "missing": ("verify", False, "missing in RustFS", ""),
    "changed-bytes": ("verify", False, "* langfuse/existing file", ""),
    "metadata": ("verify", False, "content type or metadata differs", ""),
    "ctype": ("verify", False, "content type or metadata differs", ""),
    "report-error": ("verify", False, "parse error", ""),
    "inventory": ("copy", False, "Writer inventory failed", ""),
    "pgrep-error": ("copy", False, "Writer inventory failed", ""),
    "host-active": ("copy", False, "Stop the local writers", ""),
    "docker-inventory": ("copy", False, "docker daemon unavailable", ""),
    "compose-active": ("copy", False, "Writers are still running", ""),
    "stop-fails": ("copy", False, "Could not stop Langfuse", ""),
    "stop-lies": ("copy", False, "Writers are still running", ""),
    "stop-works": ("copy", True, "Keep writers stopped", ""),
}
for name, (mode, succeeds, needle, extra) in cases.items():
    with tempfile.TemporaryDirectory(prefix=f"migrate-mock-{name}-") as td:
        root = Path(td)
        for dirname in ("scripts", "env/local", "bin", "home", ".minio-data"):
            (root / dirname).mkdir(parents=True, exist_ok=True)
        (root / "env/local/stack.env").touch()
        (root / ".minio-data/fixture").write_text("placeholder data")
        shutil.copy2(script, root / "scripts/")
        exe = root / "bin/docker"
        exe.write_text("#!/usr/bin/env python3\n" + textwrap.dedent(stub))
        exe.chmod(0o755)
        for cmd in ("lsof", "pgrep"):
            (root / f"bin/{cmd}").symlink_to(exe)
        trace = root / "trace"
        env = dict(os.environ, PATH=f"{root}/bin:{os.environ['PATH']}", HOME=str(root / "home"),
                   FAULT=name, TRACE=str(trace))
        out = subprocess.run(["bash", str(root / "scripts" / script.name), mode],
                             input="y\n", text=True, env=env, capture_output=True, check=False)
        output = out.stdout + out.stderr
        assert (out.returncode == 0) == succeeds, (name, out)
        assert needle in output and extra in output, (name, out)
        if mode == "copy":
            logs = trace.read_text().splitlines()
            copies = [line for line in logs if "/dev/null copy " in line and "--dry-run" not in line]
            backups = list((root / "home/helpudoc-migrate").glob("minio-backup-*"))
            if succeeds:
                assert len(copies) == 2 and {line.split("minio:", 1)[1].split()[0] for line in copies} == {"helpudoc", "langfuse"}
                assert len(backups) == 1 and (backups[0] / "fixture").read_text() == "placeholder data"
            else:
                assert not copies and not backups, (name, logs, backups)
        if not succeeds:
            assert "PASS" not in output, (name, out)
        print(f"PASS {name}")

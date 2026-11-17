"""Resolve hash-locked Python 3.12 wheels for both supported Linux architectures.

Install uv==0.11.2, then run python agent/scripts/update_runtime_lock.py.
Use --check to validate the current lock against unchanged dependency inputs.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
UV_VERSION = "0.11.2"
LOCK = ROOT / "agent/requirements-runtime.lock"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    version = subprocess.check_output(["uv", "--version"], text=True).split()[1]
    if version != UV_VERSION:
        raise SystemExit(f"Use uv=={UV_VERSION}, found {version}")
    with tempfile.TemporaryDirectory(prefix="helpudoc-lock-") as tmp:
        outputs = []
        for arch in ("x86_64", "aarch64"):
            output = Path(tmp) / f"{arch}.txt"
            command = ["uv", "pip", "compile", "agent/requirements-runtime.txt",
                       "--python-version", "3.12", "--python-platform", f"{arch}-manylinux_2_28",
                       "--only-binary", ":all:", "--generate-hashes", "--no-header", "--no-annotate",
                       "--default-index", "https://pypi.org/simple", "--output-file", str(output)]
            # Checking keeps the committed resolution, while still solving all
            # declared inputs and checking wheel compatibility on each platform.
            if args.check:
                command.extend(["--constraints", str(LOCK)])
            subprocess.run(command, cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
            outputs.append(output.read_text())
        if outputs[0] != outputs[1]:
            raise SystemExit("Platform resolutions differ; review before updating a shared lock")
        content = "# Python 3.12 Linux amd64/arm64; generated with uv==0.11.2.\n# Update: python agent/scripts/update_runtime_lock.py\n" + outputs[0]
        if args.check:
            if content != LOCK.read_text():
                raise SystemExit("Runtime lock is stale; regenerate and review the diff")
            print("Runtime lock matches inputs on Linux amd64 and arm64")
        else:
            LOCK.write_text(content)
            print(f"Updated {LOCK.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

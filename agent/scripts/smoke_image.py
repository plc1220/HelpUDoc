"""Start the actual HTTP service and verify liveness/readiness without credentials."""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="helpudoc-startup-") as temp:
        work = Path(temp)
        config = work / "runtime.yaml"
        config.write_text("model:\n  provider: gemini\n  name: smoke-only\n  use_vertex_ai: false\n"
                          f"backend:\n  workspace_root: {work / 'workspaces'}\n"
                          "  virtual_mode: true\ntools: []\nmcp_servers: []\n")
        empty_env = work / "empty.env"
        empty_env.touch()
        env = {key: value for key, value in os.environ.items()
               if key in {"PATH", "LANG", "LC_ALL", "LD_LIBRARY_PATH"}}
        env.update(AGENT_CONFIG_PATH=str(config), ENV_FILE=str(empty_env),
                   AGENT_STORE_USE_IN_MEMORY="true", NODE_ENV="test", HOME=str(work),
                   OFFICECLI_SKIP_UPDATE="1", OFFICECLI_NO_AUTO_RESIDENT="1")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        with (work / "server.log").open("w+") as log:
            process = subprocess.Popen([sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1",
                                        "--port", str(port)], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 90
                while True:
                    if process.poll() is not None:
                        raise RuntimeError(f"Service exited before health checks: {process.returncode}")
                    try:
                        results = {}
                        for path in ("health", "ready"):
                            with urlopen(f"http://127.0.0.1:{port}/{path}", timeout=2) as response:
                                results[path] = json.load(response)
                            if results[path].get("status") != "ok" or results[path].get("service") != "helpudoc-agent":
                                raise RuntimeError(f"Unexpected {path} response: {results[path]}")
                        if results["ready"]["dependencies"]["officecli"]["ready"] is not True:
                            raise RuntimeError("OfficeCLI readiness failed")
                        print("AGENT_IMAGE_STARTUP_OK", json.dumps(results))
                        break
                    except (URLError, TimeoutError):
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Service did not become healthy/ready within 90 seconds")
                        time.sleep(0.25)
            except Exception:
                log.seek(0)
                print(log.read(), file=sys.stderr)
                raise
            finally:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if process.returncode not in (0, -15):
                raise RuntimeError(f"Service shutdown failed: {process.returncode}")


if __name__ == "__main__":
    main()

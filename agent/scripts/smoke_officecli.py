"""Real-binary smoke for the agent-owned OfficeCLI execution path."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

AGENT_ROOT = Path(__file__).resolve().parents[1]
if str(AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENT_ROOT))

from helpudoc_agent.tools.workspace.office.config import OfficeRunnerConfig
from helpudoc_agent.tools.workspace.office.runner import execute_batch, is_binary_ready


async def _run() -> None:
    config = OfficeRunnerConfig()
    if not is_binary_ready(config):
        raise RuntimeError("Pinned OfficeCLI failed version or integrity verification")

    workspace_parent = os.getenv("HELPUDOC_OFFICE_SMOKE_ROOT") or os.getenv("WORKSPACE_ROOT")
    if workspace_parent:
        Path(workspace_parent).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="helpudoc-office-smoke-",
        dir=workspace_parent or None,
    ) as temp_dir:
        workspace = Path(temp_dir) / "workspace"
        workspace.mkdir()
        artifacts: dict[str, int] = {}
        for extension in ("docx", "xlsx", "pptx"):
            output = workspace / f"smoke.{extension}"
            operations = [{"command": "view", "mode": "stats"}]
            if extension == "docx":
                operations = [
                    {
                        "command": "add",
                        "parent": "/body",
                        "type": "paragraph",
                        "props": {"text": "HelpUDoc direct OfficeCLI smoke"},
                    },
                    {"command": "get", "path": "/body/p[1]"},
                ]
            response = await execute_batch(
                config=config,
                semaphore=asyncio.Semaphore(1),
                workspace_base=workspace,
                source_resolved=None,
                output_resolved=output,
                operations=operations,
                create_if_missing=True,
            )
            if not response.success or not response.published or not output.is_file():
                raise RuntimeError(
                    f"Direct OfficeCLI {extension} smoke failed: "
                    f"{response.model_dump(mode='json')}"
                )
            if response.validation is None or not response.validation.success:
                raise RuntimeError(
                    f"Direct OfficeCLI {extension} smoke did not pass mandatory validation"
                )
            artifacts[extension] = output.stat().st_size
        print(
            json.dumps(
                {
                    "status": "ok",
                    "officecli_version": config.expected_version,
                    "formats": artifacts,
                },
                separators=(",", ":"),
            )
        )


if __name__ == "__main__":
    asyncio.run(_run())

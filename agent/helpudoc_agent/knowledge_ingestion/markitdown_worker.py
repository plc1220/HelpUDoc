"""Child-process entry point: convert one local file with MarkItDown.

Prints one JSON object on stdout: {"markdown", "title", "converter"}. Run by
markitdown_isolated, never by the agent process itself.
"""
from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m helpudoc_agent.knowledge_ingestion.markitdown_worker <path>", file=sys.stderr)
        return 2
    from helpudoc_agent.knowledge_ingestion.conversion import _convert_with_markitdown

    conversion = _convert_with_markitdown(Path(argv[1]))
    sys.stdout.write(json.dumps(asdict(conversion), ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

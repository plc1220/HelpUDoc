#!/usr/bin/env python3
"""Count whitespace-delimited words in one staged research report."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: count_words.py <report-filename>", file=sys.stderr)
        return 2

    report_path = Path(sys.argv[1])
    if report_path.is_absolute() or report_path.name != report_path.as_posix():
        print("Report filename must be a single staged filename.", file=sys.stderr)
        return 2
    if not report_path.is_file():
        print(f"Report file not found: {report_path}", file=sys.stderr)
        return 1

    word_count = len(report_path.read_text(encoding="utf-8").split())
    payload = {
        "file": report_path.name,
        "word_count": word_count,
        "method": "whitespace_delimited_tokens",
    }
    output_path = Path("outputs/word_count.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

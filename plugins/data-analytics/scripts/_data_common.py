from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False, default=str)


def read_request(argv: list[str] | None = None) -> dict[str, Any]:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-json", default="")
    parser.add_argument("request", nargs="?")
    args = parser.parse_args(argv)
    raw = args.request_json or args.request or "{}"
    stripped = raw.lstrip()
    if not stripped.startswith("{"):
        candidate = Path(raw)
        if candidate.is_file():
            raw = candidate.read_text(encoding="utf-8")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise SystemExit("request payload must be a JSON object")
    return payload


def workspace_root() -> Path:
    return Path(os.environ.get("HELPUDOC_WORKSPACE_ROOT") or os.getcwd()).resolve()


def workspace_output_root() -> Path:
    return Path(os.environ.get("HELPUDOC_WORKSPACE_OUTPUT_ROOT") or os.environ.get("HELPUDOC_WORKSPACE_ROOT") or os.getcwd()).resolve()


def run_dir() -> Path:
    return Path(os.environ.get("HELPUDOC_SANDBOX_RUN_DIR") or os.getcwd()).resolve()


def out_dir() -> Path:
    path = run_dir() / "out"
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_out_json(name: str, payload: Any) -> Path:
    path = out_dir() / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json_dump(payload), encoding="utf-8")
    return path


def write_out_text(name: str, text: str) -> Path:
    path = out_dir() / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def safe_slug(value: str, fallback: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "").strip()).strip("_")
    return slug or fallback


def normalize_rel_path(value: str) -> str:
    raw = str(value or "").replace("\\", "/").strip().lstrip("/")
    parts = [part for part in raw.split("/") if part and part != "."]
    if any(part == ".." for part in parts):
        raise ValueError(f"path escapes workspace: {value}")
    return "/".join(parts)


def resolve_read_path(raw_path: str) -> Path:
    rel = normalize_rel_path(raw_path)
    if not rel:
        raise ValueError("path is required")
    root = workspace_root()
    path = (root / rel).resolve()
    if path != root and root not in path.parents:
        raise ValueError(f"path escapes workspace: {raw_path}")
    return path


def resolve_output_path(raw_path: str) -> Path:
    rel = normalize_rel_path(raw_path)
    if not rel:
        raise ValueError("path is required")
    root = workspace_output_root()
    path = (root / rel).resolve()
    if path != root and root not in path.parents:
        raise ValueError(f"path escapes workspace output: {raw_path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def infer_schema(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    if not rows:
        return []
    schema: list[dict[str, str]] = []
    for key in rows[0].keys():
        sample = next((row.get(key) for row in rows if row.get(key) is not None), None)
        if isinstance(sample, bool):
            dtype = "bool"
        elif isinstance(sample, int):
            dtype = "int64"
        elif isinstance(sample, float):
            dtype = "float64"
        else:
            dtype = "string"
        schema.append({"name": str(key), "type": dtype})
    return schema

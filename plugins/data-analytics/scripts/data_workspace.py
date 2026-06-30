from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd

from _data_common import (
    infer_schema,
    json_dump,
    normalize_rel_path,
    read_request,
    resolve_output_path,
    safe_slug,
    workspace_root,
    write_out_json,
    write_out_text,
)


DATA_EXTENSIONS = {".csv", ".parquet", ".json"}
DISCOVERY_DIRS = ("datasets", "data", "exports", "uploads")


def table_name_for(path: Path, used: set[str]) -> str:
    stem = re.sub(r"[^A-Za-z0-9_]+", "_", path.stem).strip("_") or "table"
    if not re.match(r"^[A-Za-z_]", stem):
        stem = f"t_{stem}"
    name = stem
    if name in used:
        name = re.sub(r"[^A-Za-z0-9_]+", "_", path.with_suffix("").as_posix()).strip("_") or stem
        if not re.match(r"^[A-Za-z_]", name):
            name = f"t_{name}"
    suffix = 2
    base = name
    while name in used:
        name = f"{base}_{suffix}"
        suffix += 1
    used.add(name)
    return name


def quote_ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def discover_files(root: Path) -> list[Path]:
    candidates: list[Path] = []
    for dirname in DISCOVERY_DIRS:
        directory = root / dirname
        if directory.is_dir():
            candidates.extend(path for path in directory.rglob("*") if path.suffix.lower() in DATA_EXTENSIONS)
    if not candidates:
        candidates = [path for path in root.rglob("*") if path.suffix.lower() in DATA_EXTENSIONS]
    return sorted({path.resolve() for path in candidates})


def register_tables(con: duckdb.DuckDBPyConnection, root: Path) -> dict[str, str]:
    table_paths: dict[str, str] = {}
    used: set[str] = set()
    for path in discover_files(root):
        if "node_modules" in path.parts or "sandbox-runs" in path.parts:
            continue
        table = table_name_for(path.relative_to(root), used)
        quoted = path.as_posix().replace("'", "''")
        if path.suffix.lower() == ".csv":
            con.execute(f"CREATE OR REPLACE TABLE {quote_ident(table)} AS SELECT * FROM read_csv_auto('{quoted}')")
        elif path.suffix.lower() == ".parquet":
            con.execute(f"CREATE OR REPLACE TABLE {quote_ident(table)} AS SELECT * FROM read_parquet('{quoted}')")
        elif path.suffix.lower() == ".json":
            con.execute(f"CREATE OR REPLACE TABLE {quote_ident(table)} AS SELECT * FROM read_json_auto('{quoted}')")
        table_paths[table] = path.relative_to(root).as_posix()
    return table_paths


def dataframe_rows(df: pd.DataFrame, limit: int = 1000) -> list[dict[str, Any]]:
    return json.loads(df.head(limit).to_json(orient="records", date_format="iso"))


def schema_markdown(con: duckdb.DuckDBPyConnection, tables: list[str]) -> str:
    lines: list[str] = []
    available = [row[0] for row in con.execute("SHOW TABLES").fetchall()]
    selected = tables or available
    for table in selected:
        if table not in available:
            continue
        lines.append(f"Table: {table}")
        for col_name, col_type, *_rest in con.execute(f"DESCRIBE {quote_ident(table)}").fetchall():
            lines.append(f"  - {col_name} ({col_type})")
        lines.append("")
    return "\n".join(lines).strip() or "No tables found."


def main() -> None:
    request = read_request()
    root = workspace_root()
    con = duckdb.connect(database=":memory:")
    table_paths = register_tables(con, root)
    action = str(request.get("action") or "schema").strip().lower()
    result: dict[str, Any] = {"ok": True, "action": action, "tables": table_paths}

    if action == "schema":
        tables = [str(item) for item in request.get("tables") or []]
        markdown = schema_markdown(con, tables)
        result["schema"] = markdown
        write_out_text("result.md", markdown)
    elif action in {"query", "export"}:
        sql = str(request.get("sql") or request.get("sql_query") or "").strip().rstrip(";")
        if not sql:
            raise SystemExit("sql is required for query/export")
        row_limit = int(request.get("row_limit") or 1000)
        df = con.execute(f"SELECT * FROM ({sql}) AS data_workspace_query LIMIT {max(1, row_limit)}").df()
        rows = dataframe_rows(df, limit=row_limit)
        result.update({"sql": sql, "rowCount": len(df), "rows": rows, "schema": infer_schema(rows)})
        if action == "export":
            output_path = normalize_rel_path(str(request.get("output_path") or f"datasets/{safe_slug('query_export', 'query_export')}.csv"))
            destination = resolve_output_path(output_path)
            if destination.suffix.lower() == ".parquet":
                df.to_parquet(destination, index=False)
                mime = "application/octet-stream"
            else:
                df.to_csv(destination, index=False, quoting=csv.QUOTE_MINIMAL)
                mime = "text/csv"
            result["export"] = {
                "path": output_path,
                "mimeType": mime,
                "size": destination.stat().st_size,
                "rowCount": len(df),
            }
            write_out_json("tool_artifacts.json", {"files": [result["export"]]})
        write_out_text("result.md", df.head(50).to_markdown(index=False))
    elif action == "profile":
        profiles: dict[str, Any] = {}
        for table in table_paths:
            count = con.execute(f"SELECT COUNT(*) FROM {quote_ident(table)}").fetchone()[0]
            profiles[table] = {"rowCount": int(count)}
        result["profiles"] = profiles
        write_out_text("result.md", json_dump(profiles))
    else:
        raise SystemExit(f"unknown action: {action}")

    write_out_json("result.json", result)
    print(json_dump({"ok": True, "action": action, "resultPath": "out/result.json"}))


if __name__ == "__main__":
    main()

"""Built-in BigQuery export tool for staging query results into the workspace."""
from __future__ import annotations

import json
import logging
import os
import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

import duckdb
import pandas as pd
import requests
import yaml
from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import Tool, tool

from .configuration import REPO_ROOT
from .state import WorkspaceState

logger = logging.getLogger(__name__)

_DEFAULT_SERVER_NAME = "toolbox-bq-demo"
_DEFAULT_PROJECT = "my-rd-coe-demo-gen-ai"
_DEFAULT_LOCATION = "us"
_DEFAULT_ROW_LIMIT = 10000
_PAGE_SIZE = 1000
_SQL_COMMENT_BLOCK = re.compile(r"/\*.*?\*/", flags=re.DOTALL)
_SQL_COMMENT_LINE = re.compile(r"--.*?$", flags=re.MULTILINE)
_READ_ONLY_START = re.compile(r"^\s*(select|with)\b", flags=re.IGNORECASE)
_FORBIDDEN_SQL = re.compile(
    r"\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|call|export|load)\b",
    flags=re.IGNORECASE,
)
_INTEGER_TYPES = {"INTEGER", "INT64"}
_FLOAT_TYPES = {"FLOAT", "FLOAT64"}
_BOOLEAN_TYPES = {"BOOL", "BOOLEAN"}
_JSON_MIME = "application/json"
_CSV_MIME = "text/csv"
_PARQUET_MIME = "application/octet-stream"


def _toolbox_config_path() -> Path:
    return REPO_ROOT / "toolbox" / "tools.yaml"


@lru_cache(maxsize=1)
def load_bigquery_toolbox_config() -> Dict[str, str]:
    """Load project/location defaults from Toolbox config when available."""
    payload = {
        "server_name": _DEFAULT_SERVER_NAME,
        "project": os.getenv("GOOGLE_CLOUD_PROJECT") or _DEFAULT_PROJECT,
        "location": os.getenv("BIGQUERY_LOCATION") or _DEFAULT_LOCATION,
    }
    path = _toolbox_config_path()
    if not path.exists():
        return payload
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        logger.warning("Failed to load toolbox/tools.yaml for BigQuery export defaults", exc_info=True)
        return payload

    source = ((raw.get("sources") or {}).get("bq") or {}) if isinstance(raw, dict) else {}
    project = source.get("project")
    location = source.get("location")
    if isinstance(project, str) and project.strip():
        payload["project"] = project.strip()
    if isinstance(location, str) and location.strip():
        payload["location"] = location.strip()
    return payload


def _strip_sql_comments(sql: str) -> str:
    no_blocks = _SQL_COMMENT_BLOCK.sub(" ", sql or "")
    return _SQL_COMMENT_LINE.sub(" ", no_blocks)


def validate_read_only_sql(sql: str) -> None:
    """Reject write/DDL statements; v1 only supports SELECT/WITH queries."""
    cleaned = _strip_sql_comments(sql).strip().rstrip(";").strip()
    if not cleaned:
        raise ValueError("SQL query is required.")
    if not _READ_ONLY_START.match(cleaned):
        raise ValueError("Only read-only SELECT/WITH queries are supported.")
    if _FORBIDDEN_SQL.search(cleaned):
        raise ValueError("Only read-only SELECT/WITH queries are supported.")


def _wrap_query_with_limit(sql: str, row_limit: Optional[int]) -> str:
    if row_limit is None or row_limit <= 0:
        return sql.strip().rstrip(";")
    return f"SELECT * FROM ({sql.strip().rstrip(';')}) AS export_subquery LIMIT {int(row_limit)}"


def normalize_export_format(raw_format: str) -> str:
    normalized = (raw_format or "csv").strip().lower()
    if normalized not in {"csv", "parquet"}:
        raise ValueError("format must be either 'csv' or 'parquet'.")
    return normalized


def resolve_output_path(workspace_root: Path, output_path: Optional[str], export_format: str) -> Path:
    suffix = f".{export_format}"
    raw = (output_path or "").strip()
    if not raw:
        raw = f"data_exports/bigquery_export_{uuid4().hex[:8]}{suffix}"
    elif raw.endswith("/"):
        raw = f"{raw}bigquery_export_{uuid4().hex[:8]}{suffix}"
    elif not Path(raw).suffix:
        raw = f"{raw}{suffix}"

    candidate = Path(raw)
    if candidate.is_absolute():
        candidate = Path(str(candidate).lstrip("/"))
    workspace_root_resolved = workspace_root.resolve()
    raw_destination = workspace_root / candidate
    resolved_destination = raw_destination.resolve()
    if workspace_root_resolved not in resolved_destination.parents and resolved_destination != workspace_root_resolved:
        raise ValueError("output_path must remain inside the workspace.")
    return raw_destination


def extract_bearer_header(workspace_state: WorkspaceState, preferred_server: str) -> Optional[str]:
    auth_map = workspace_state.context.get("mcp_auth") or {}
    if isinstance(auth_map, dict):
        candidates: List[str] = []
        if preferred_server:
            candidates.append(preferred_server)
        candidates.extend(
            name for name in auth_map.keys()
            if isinstance(name, str) and name not in candidates
        )
        for server_name in candidates:
            headers = auth_map.get(server_name)
            if not isinstance(headers, dict):
                continue
            for header_name, header_value in headers.items():
                if str(header_name).lower() == "authorization" and isinstance(header_value, str) and header_value.strip():
                    return header_value.strip()
    env_token = os.getenv("BQ_ACCESS_TOKEN", "").strip()
    if env_token:
        return env_token if env_token.lower().startswith("bearer ") else f"Bearer {env_token}"
    return None


def _coerce_bigquery_scalar(field_type: str, value: Any) -> Any:
    if value is None:
        return None
    normalized_type = (field_type or "").upper()
    if normalized_type in _INTEGER_TYPES:
        try:
            return int(value)
        except (TypeError, ValueError):
            return value
    if normalized_type in _FLOAT_TYPES:
        try:
            return float(value)
        except (TypeError, ValueError):
            return value
    if normalized_type in _BOOLEAN_TYPES:
        if isinstance(value, bool):
            return value
        return str(value).lower() == "true"
    return value


def _coerce_bigquery_cell(field: Dict[str, Any], cell: Dict[str, Any]) -> Any:
    mode = str(field.get("mode") or "NULLABLE").upper()
    field_type = str(field.get("type") or "")
    value = cell.get("v") if isinstance(cell, dict) else None
    nested_fields = field.get("fields") or []

    if mode == "REPEATED":
        items = value if isinstance(value, list) else []
        coerced = [
            _coerce_bigquery_cell({**field, "mode": "NULLABLE"}, item if isinstance(item, dict) else {"v": item})
            for item in items
        ]
        return json.dumps(coerced, ensure_ascii=False)

    if field_type.upper() in {"RECORD", "STRUCT"}:
        row_items = value.get("f") if isinstance(value, dict) else []
        payload: Dict[str, Any] = {}
        for index, nested_field in enumerate(nested_fields):
            nested_cell = row_items[index] if index < len(row_items) and isinstance(row_items[index], dict) else {"v": None}
            payload[str(nested_field.get("name") or f"field_{index}")] = _coerce_bigquery_cell(nested_field, nested_cell)
        return json.dumps(payload, ensure_ascii=False)

    return _coerce_bigquery_scalar(field_type, value)


def rows_to_dataframe(schema_fields: List[Dict[str, Any]], rows: List[Dict[str, Any]]) -> pd.DataFrame:
    column_names = [str(field.get("name") or f"column_{index}") for index, field in enumerate(schema_fields)]
    records: List[Dict[str, Any]] = []
    for row in rows:
        values = row.get("f") if isinstance(row, dict) else []
        record: Dict[str, Any] = {}
        for index, field in enumerate(schema_fields):
            cell = values[index] if index < len(values) and isinstance(values[index], dict) else {"v": None}
            record[column_names[index]] = _coerce_bigquery_cell(field, cell)
        records.append(record)
    return pd.DataFrame(records, columns=column_names)


def _raise_for_error(response: requests.Response) -> None:
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        message = response.text
        try:
            payload = response.json()
            error = (((payload or {}).get("error") or {}).get("message"))
            if error:
                message = str(error)
        except Exception:
            pass
        raise RuntimeError(f"BigQuery request failed: {message}") from exc


def run_bigquery_query(
    *,
    sql: str,
    project: str,
    location: str,
    auth_header: str,
    row_limit: Optional[int],
    timeout_seconds: int = 30,
) -> pd.DataFrame:
    """Execute a query through BigQuery REST and return the result as a DataFrame."""
    final_sql = _wrap_query_with_limit(sql, row_limit)
    headers = {
        "Authorization": auth_header,
        "Content-Type": _JSON_MIME,
    }
    post_url = f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/queries"
    page_size = min(_PAGE_SIZE, int(row_limit)) if row_limit and row_limit > 0 else _PAGE_SIZE
    response = requests.post(
        post_url,
        headers=headers,
        json={
            "query": final_sql,
            "useLegacySql": False,
            "location": location,
            "timeoutMs": 10000,
            "maxResults": page_size,
        },
        timeout=timeout_seconds,
    )
    _raise_for_error(response)
    payload = response.json()
    schema_fields = ((payload.get("schema") or {}).get("fields") or [])
    rows = list(payload.get("rows") or [])
    job_ref = payload.get("jobReference") or {}
    job_id = job_ref.get("jobId")
    resolved_location = str(job_ref.get("location") or location)
    page_token = payload.get("pageToken")
    job_complete = bool(payload.get("jobComplete", True))

    if job_id:
        get_url = f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/queries/{job_id}"
        while not job_complete:
            time.sleep(1)
            poll_response = requests.get(
                get_url,
                headers=headers,
                params={
                    "location": resolved_location,
                    "timeoutMs": 10000,
                    "maxResults": page_size,
                },
                timeout=timeout_seconds,
            )
            _raise_for_error(poll_response)
            payload = poll_response.json()
            job_complete = bool(payload.get("jobComplete", False))
            schema_fields = schema_fields or ((payload.get("schema") or {}).get("fields") or [])
            rows = list(payload.get("rows") or []) if job_complete else rows
            page_token = payload.get("pageToken") if job_complete else page_token

        while page_token:
            page_response = requests.get(
                get_url,
                headers=headers,
                params={
                    "location": resolved_location,
                    "pageToken": page_token,
                    "maxResults": page_size,
                },
                timeout=timeout_seconds,
            )
            _raise_for_error(page_response)
            page_payload = page_response.json()
            schema_fields = schema_fields or ((page_payload.get("schema") or {}).get("fields") or [])
            rows.extend(page_payload.get("rows") or [])
            page_token = page_payload.get("pageToken")

    return rows_to_dataframe(schema_fields, rows)


def write_export_dataframe(df: pd.DataFrame, destination: Path, export_format: str) -> Dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    normalized = normalize_export_format(export_format)
    if normalized == "csv":
        df.to_csv(destination, index=False)
        mime_type = _CSV_MIME
    else:
        connection = duckdb.connect(database=":memory:")
        try:
            connection.register("export_df", df)
            escaped_destination = destination.as_posix().replace("'", "''")
            connection.execute(f"COPY export_df TO '{escaped_destination}' (FORMAT PARQUET)")
        finally:
            try:
                connection.close()
            except Exception:
                logger.warning("Failed to close DuckDB connection after parquet export", exc_info=True)
        mime_type = _PARQUET_MIME
    return {
        "path": destination,
        "mimeType": mime_type,
        "size": destination.stat().st_size,
        "rowCount": len(df),
    }


def build_export_bigquery_query_tool(workspace_state: WorkspaceState) -> Tool:
    """Create a workspace-aware BigQuery export tool."""
    config = load_bigquery_toolbox_config()
    preferred_server = str(config.get("server_name") or _DEFAULT_SERVER_NAME)
    default_project = str(config.get("project") or _DEFAULT_PROJECT)
    default_location = str(config.get("location") or _DEFAULT_LOCATION)

    @tool
    def export_bigquery_query(
        sql: str,
        output_path: str = "",
        format: str = "csv",
        row_limit: Optional[int] = _DEFAULT_ROW_LIMIT,
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Execute a read-only BigQuery query and save the result into the workspace."""
        if workspace_state.context.get("tagged_files_only"):
            return "Tool disabled: tagged files were provided, use rag_query only."

        try:
            validate_read_only_sql(sql)
            export_format = normalize_export_format(format)
            destination = resolve_output_path(workspace_state.root_path, output_path, export_format)
        except ValueError as exc:
            return str(exc)

        auth_header = extract_bearer_header(workspace_state, preferred_server)
        if not auth_header:
            return (
                "BigQuery export is unavailable because no delegated BigQuery access token was found. "
                f"Expected MCP auth for server '{preferred_server}' or BQ_ACCESS_TOKEN."
            )

        try:
            limit_value = int(row_limit) if row_limit is not None else None
        except (TypeError, ValueError):
            return "row_limit must be an integer or null."
        if limit_value is not None and limit_value < 0:
            return "row_limit must be zero or greater."
        if limit_value == 0:
            limit_value = None

        try:
            df = run_bigquery_query(
                sql=sql,
                project=default_project,
                location=default_location,
                auth_header=auth_header,
                row_limit=limit_value,
            )
            artifact = write_export_dataframe(df, destination, export_format)
        except Exception as exc:  # pragma: no cover - network/filesystem guard
            logger.exception("BigQuery export failed")
            return f"BigQuery export failed: {exc}"

        rel_path = artifact["path"].relative_to(workspace_state.root_path).as_posix()
        artifact_payload = {
            "path": rel_path,
            "mimeType": artifact["mimeType"],
            "size": artifact["size"],
        }
        if callbacks:
            try:
                run_id = getattr(callbacks, "run_id", None)
                event_payload = {"files": [artifact_payload]}
                if run_id is not None:
                    callbacks.on_custom_event("tool_artifacts", event_payload, run_id=run_id)
                else:
                    callbacks.on_custom_event("tool_artifacts", event_payload)
            except Exception:
                logger.warning("Failed to dispatch BigQuery export artifact event", exc_info=True)

        return json.dumps(
            {
                "path": rel_path,
                "mimeType": artifact["mimeType"],
                "bytesWritten": artifact["size"],
                "rowCount": artifact["rowCount"],
                "format": export_format,
                "project": default_project,
                "location": default_location,
            },
            ensure_ascii=False,
        )

    export_bigquery_query.name = "export_bigquery_query"
    export_bigquery_query.description = (
        "Run a read-only BigQuery query with delegated auth and save the result as CSV or Parquet in the workspace."
    )
    return export_bigquery_query

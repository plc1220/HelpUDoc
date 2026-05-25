"""Schema discovery, SQL execution, and BigQuery materialization tools."""
from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Dict, List, Optional

import duckdb
import pandas as pd
from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import tool
from pydantic import Field

from ...bigquery_export_tools import (
    extract_bearer_header,
    load_bigquery_toolbox_config,
    resolve_output_path,
    validate_read_only_sql,
    write_export_dataframe,
)
from ...state import WorkspaceState
from ...tagged_file_policy import tagged_files_mode_guard

from .constants import (
    ALLOWED_ARTIFACT_EXTENSIONS,
    DEFAULT_CACHE_TTL_HOURS,
    MAX_MATERIALIZED_ROWS,
    MAX_QUERY_COUNT,
    MAX_QUERY_RESULT_ROWS,
    MAX_RESULT_ROWS,
    MAX_SESSION_ROWS,
    STRICT_DASHBOARD_PREVIEW_QUERY_COUNT,
    STRICT_DASHBOARD_QUERY_COUNT,
)
from .duckdb_manager import DuckDBManager, _rewrite_virtual_paths
from .formatting import _format_dataframe_markdown
from .guards import (
    _dashboard_plan_gate_message,
    _extract_dashboard_dimension_signature,
    _is_plan_approved,
    _is_strict_dashboard_mode,
    _looks_like_preview_query,
    _query_looks_aggregated,
)
from .utilities import (
    _coerce_bool_arg,
    _coerce_int_arg,
    _coerce_text_arg,
    _json_dump,
    _safe_slug,
    _utc_now,
)
from .workspace_files import _workspace_rel

from .state import _MaterializationRecord

logger = logging.getLogger(__name__)


def _compat_run_bigquery_query(*args, **kwargs):
    """Resolve via data_agent_tools so tests can monkeypatch run_bigquery_query."""
    from ._shim_targets import get_data_agent_tools_module

    mod = get_data_agent_tools_module()
    return mod.run_bigquery_query(*args, **kwargs)

def _looks_like_local_file_query(sql_query: str) -> bool:
    normalized = (sql_query or "").strip().lower()
    if not normalized:
        return False
    if "read_parquet" in normalized or "read_csv_auto" in normalized:
        return True
    return bool(re.search(r"['\"]/?[^'\"]+\.(parquet|csv|jsonl?|ndjson)['\"]", sql_query, re.IGNORECASE))


def _cache_key_for_query(sql_query: str, workspace_id: str, cache_key_hint: str) -> str:
    digest = hashlib.sha256(
        f"{workspace_id}\n{cache_key_hint}\n{sql_query}".encode("utf-8")
    ).hexdigest()
    return digest[:12]


def _schema_summary_from_dataframe(df: pd.DataFrame) -> List[Dict[str, Any]]:
    return [
        {
            "name": str(column),
            "type": str(dtype),
            "mode": "NULLABLE",
        }
        for column, dtype in df.dtypes.items()
    ]


def _load_dataframe_from_parquet(connection: duckdb.DuckDBPyConnection, parquet_path: Path) -> pd.DataFrame:
    safe_path = parquet_path.as_posix().replace("'", "''")
    return connection.execute(f"SELECT * FROM read_parquet('{safe_path}')").df()


def _emit_artifacts(
    callbacks: Optional[CallbackManagerForToolRun],
    artifacts: List[Dict[str, Any]],
) -> None:
    if not callbacks or not artifacts:
        return
    try:
        run_id = getattr(callbacks, "run_id", None)
        payload = {"files": artifacts}
        if run_id is not None:
            callbacks.on_custom_event("tool_artifacts", payload, run_id=run_id)
        else:
            callbacks.on_custom_event("tool_artifacts", payload)
    except Exception:  # pragma: no cover - best effort
        logger.warning("Failed to dispatch tool_artifacts event", exc_info=True)


def create_query_tools(db_manager: DuckDBManager, workspace_state: WorkspaceState):
    @tool
    def get_table_schema(
        table_names: List[str] = Field(description="List of table names to get schema for. If empty, returns all tables."),
    ) -> str:
        """Get the schema of tables relevant to the user question."""
        result = db_manager.get_schema(table_names if table_names else None)
        db_manager.session.schema_inspected = True
        return result

    @tool
    def run_sql_query(
        sql_query: str = Field(description="The SQL query to run."),
    ) -> str:
        """Run a SQL query against the database and return the results."""
        try:
            db_manager.require_schema_check()
        except ValueError as exc:
            return str(exc)

        try:
            cleaned_query = sql_query.strip()
            if cleaned_query.endswith(";"):
                cleaned_query = cleaned_query[:-1].rstrip()
            strict_dashboard_mode = _is_strict_dashboard_mode(workspace_state)
            if strict_dashboard_mode and not _is_plan_approved(workspace_state):
                if db_manager.session.query_count >= STRICT_DASHBOARD_PREVIEW_QUERY_COUNT:
                    return (
                        f"{_dashboard_plan_gate_message()} Only {STRICT_DASHBOARD_PREVIEW_QUERY_COUNT} preview query "
                        "is allowed before approval."
                    )
                if not _looks_like_preview_query(cleaned_query):
                    return (
                        f"{_dashboard_plan_gate_message()} Before approval, only one lightweight preview query "
                        "with a small LIMIT is allowed."
                    )
            if strict_dashboard_mode and _is_plan_approved(workspace_state):
                signature = _extract_dashboard_dimension_signature(cleaned_query)
                if signature and signature in db_manager.session.dashboard_dimension_signatures:
                    return (
                        "Duplicate dashboard dimension pass blocked. Reuse the existing aggregate for this dimension "
                        "or update the approved plan before querying it again."
                    )
            cleaned_query = _rewrite_virtual_paths(
                cleaned_query, db_manager.workspace_state.root_path
            )
            truncated = False
            executed_query = cleaned_query
            safety_capped = not _query_looks_aggregated(cleaned_query)
            if safety_capped:
                executed_query = (
                    f"SELECT * FROM ({cleaned_query}) AS helpudoc_query_preview "
                    f"LIMIT {MAX_QUERY_RESULT_ROWS}"
                )

            df = db_manager.run_query(executed_query, record_sql=cleaned_query)
            if safety_capped and len(df) > MAX_SESSION_ROWS:
                truncated = True
                df = df.head(MAX_SESSION_ROWS).copy()
                db_manager.session.last_query_result = df
                if db_manager.session.query_history:
                    db_manager.session.query_history[-1].row_count = len(df)
                    db_manager.session.query_history[-1].preview = df.head(MAX_RESULT_ROWS).copy()
                    db_manager.session.query_history[-1].truncated = True
            return _format_dataframe_markdown(df, truncated=truncated)
        except Exception as exc:  # pragma: no cover - defensive
            return f"Error executing query: {str(exc)}"

    @tool
    def materialize_bigquery_to_parquet(
        sql_query: Annotated[
            str,
            Field(description="Read-only BigQuery SQL query to materialize into workspace-local Parquet."),
        ],
        cache_key_hint: Annotated[
            str,
            Field(description="Optional stable label to make cache files easier to recognize."),
        ] = "",
        ttl_hours: Annotated[
            int,
            Field(description="Hours before the cached Parquet is considered stale and should be refreshed."),
        ] = DEFAULT_CACHE_TTL_HOURS,
        force_refresh: Annotated[
            bool,
            Field(description="When true, ignore any cached Parquet and re-run the warehouse query."),
        ] = False,
        max_rows: Annotated[
            int,
            Field(description="Safety cap for exported rows. Keep results scoped for iterative analysis."),
        ] = MAX_MATERIALIZED_ROWS,
        target_path: Annotated[
            str,
            Field(description="Optional stable parquet path such as datasets/orders/latest.parquet."),
        ] = "",
        emit_csv: Annotated[
            bool,
            Field(description="When true, also publish a CSV mirror of the refreshed dataset."),
        ] = False,
        csv_path: Annotated[
            str,
            Field(description="Optional stable CSV path such as datasets/orders/latest.csv."),
        ] = "",
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Materialize a read-only BigQuery query into cached and optionally stable workspace Parquet."""
        blocked = tagged_files_mode_guard(workspace_state.context, "cache_bigquery_query")
        if blocked:
            return blocked
        if workspace_state.context.get("tagged_files_only"):
            return "Tool disabled: tagged files were provided, use rag_query only."
        if _is_strict_dashboard_mode(workspace_state):
            return (
                "Dashboard planning mode is bound to tagged local datasets. "
                "Skip warehouse rediscovery and use the tagged parquet/csv as the source of truth."
            )

        normalized_sql = _coerce_text_arg(sql_query).strip().rstrip(";")
        if not normalized_sql:
            return "SQL query is required."
        if _looks_like_local_file_query(normalized_sql):
            return (
                "materialize_bigquery_to_parquet expects BigQuery SQL, not workspace file paths. "
                "Use get_table_schema and run_sql_query against the DuckDB-registered local table instead."
            )

        try:
            validate_read_only_sql(normalized_sql)
        except ValueError as exc:
            return str(exc)

        hint = _coerce_text_arg(cache_key_hint).strip()
        ttl_value = _coerce_int_arg(ttl_hours, DEFAULT_CACHE_TTL_HOURS, minimum=1)
        row_cap = _coerce_int_arg(
            max_rows,
            MAX_MATERIALIZED_ROWS,
            minimum=1,
            maximum=MAX_MATERIALIZED_ROWS,
        )
        refresh = _coerce_bool_arg(force_refresh, False)
        publish_csv = _coerce_bool_arg(emit_csv, False)
        toolbox_defaults = load_bigquery_toolbox_config()
        preferred_server = str(toolbox_defaults.get("server_name") or "toolbox-bq-demo")
        project = _coerce_text_arg(
            workspace_state.context.get("bigquery_project")
            or workspace_state.context.get("bq_project")
            or toolbox_defaults.get("project")
        ).strip()
        location = _coerce_text_arg(
            workspace_state.context.get("bigquery_location")
            or workspace_state.context.get("bq_location")
            or toolbox_defaults.get("location")
        ).strip()

        auth_header = extract_bearer_header(workspace_state, preferred_server)
        if not auth_header:
            return (
                "BigQuery materialization is unavailable because no delegated BigQuery access token was found. "
                f"Expected MCP auth for server '{preferred_server}' or BQ_ACCESS_TOKEN."
            )

        cache_key = _cache_key_for_query(
            normalized_sql,
            _coerce_text_arg(getattr(workspace_state, "workspace_id", "")),
            hint,
        )
        cache_slug = _safe_slug(hint or "bq_export", "bq_export")
        cache_dir = workspace_state.root_path / "data_cache" / "bigquery"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_parquet_path = cache_dir / f"{cache_slug}_{cache_key}.parquet"
        cache_metadata_path = cache_dir / f"{cache_slug}_{cache_key}.metadata.json"

        now = _utc_now()
        cached = False
        metadata_payload: Dict[str, Any] = {}
        df: Optional[pd.DataFrame] = None

        if not refresh and cache_parquet_path.exists() and cache_metadata_path.exists():
            try:
                metadata_payload = json.loads(cache_metadata_path.read_text(encoding="utf-8"))
                expires_at_raw = _coerce_text_arg(metadata_payload.get("expiresAt")).strip()
                expires_at = datetime.fromisoformat(expires_at_raw.replace("Z", "+00:00")) if expires_at_raw else None
                if expires_at and expires_at > now:
                    cached = True
            except Exception:
                cached = False
                metadata_payload = {}

        if not cached:
            try:
                df = _compat_run_bigquery_query(
                    sql=normalized_sql,
                    project=project,
                    location=location,
                    auth_header=auth_header,
                    row_limit=row_cap,
                )
                write_export_dataframe(df, cache_parquet_path, "parquet")
            except Exception as exc:  # pragma: no cover - network/filesystem guard
                logger.exception("BigQuery materialization failed")
                return f"BigQuery materialization failed: {exc}"

            expires_at = now + timedelta(hours=ttl_value)
            metadata_payload = {
                "cacheKey": cache_key,
                "cacheKeyHint": hint,
                "connector": preferred_server,
                "project": project,
                "location": location,
                "sourceSql": normalized_sql,
                "rowCount": len(df),
                "schema": _schema_summary_from_dataframe(df),
                "refreshedAt": now.isoformat().replace("+00:00", "Z"),
                "materializedAt": now.isoformat().replace("+00:00", "Z"),
                "expiresAt": expires_at.isoformat().replace("+00:00", "Z"),
                "ttlHours": ttl_value,
                "parquetPath": _workspace_rel(cache_parquet_path, workspace_state.root_path),
                "csvPath": "",
                "artifactTargets": {"dashboard": "", "report": ""},
            }
            cache_metadata_path.write_text(_json_dump(metadata_payload), encoding="utf-8")

        stable_parquet_path: Optional[Path] = None
        stable_csv_path: Optional[Path] = None
        manifest_path = cache_metadata_path
        artifact_paths: List[Path] = [cache_parquet_path, cache_metadata_path]

        if target_path.strip():
            try:
                stable_parquet_path = resolve_output_path(
                    workspace_state.root_path,
                    target_path,
                    "parquet",
                )
            except ValueError as exc:
                return str(exc)
            stable_parquet_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cache_parquet_path, stable_parquet_path)
            manifest_path = stable_parquet_path.parent / "manifest.json"
            artifact_paths.append(stable_parquet_path)

        if publish_csv:
            if df is None:
                df = _load_dataframe_from_parquet(db_manager.con, cache_parquet_path)
            raw_csv_path = csv_path.strip()
            if not raw_csv_path and stable_parquet_path is not None:
                raw_csv_path = (stable_parquet_path.parent / "latest.csv").relative_to(
                    workspace_state.root_path
                ).as_posix()
            try:
                stable_csv_path = resolve_output_path(
                    workspace_state.root_path,
                    raw_csv_path,
                    "csv",
                )
            except ValueError as exc:
                return str(exc)
            write_export_dataframe(df, stable_csv_path, "csv")
            artifact_paths.append(stable_csv_path)

        if stable_parquet_path is not None:
            stable_metadata = dict(metadata_payload)
            stable_metadata["parquetPath"] = _workspace_rel(stable_parquet_path, workspace_state.root_path)
            stable_metadata["csvPath"] = (
                _workspace_rel(stable_csv_path, workspace_state.root_path)
                if stable_csv_path is not None
                else ""
            )
            stable_metadata["artifactTargets"] = {
                "dashboard": "",
                "report": "",
            }
            manifest_path.write_text(_json_dump(stable_metadata), encoding="utf-8")
            artifact_paths.append(manifest_path)
        else:
            if stable_csv_path is not None:
                metadata_payload["csvPath"] = _workspace_rel(stable_csv_path, workspace_state.root_path)
                cache_metadata_path.write_text(_json_dump(metadata_payload), encoding="utf-8")

        db_manager.refresh_registered_files()

        registered_artifacts: List[Dict[str, Any]] = []
        for artifact_path in artifact_paths:
            if not artifact_path.exists():
                continue
            mime_type = ALLOWED_ARTIFACT_EXTENSIONS.get(artifact_path.suffix.lower())
            if not mime_type:
                continue
            artifact_payload = {
                "path": _workspace_rel(artifact_path, workspace_state.root_path),
                "mimeType": mime_type,
                "size": artifact_path.stat().st_size,
            }
            db_manager.register_artifact(artifact_payload)
            registered_artifacts.append(artifact_payload)

        published_parquet = stable_parquet_path or cache_parquet_path
        published_metadata = manifest_path
        db_manager.record_materialization(
            _MaterializationRecord(
                cache_key=cache_key,
                sql=normalized_sql,
                parquet_path=_workspace_rel(published_parquet, workspace_state.root_path),
                metadata_path=_workspace_rel(published_metadata, workspace_state.root_path),
                row_count=_coerce_int_arg(metadata_payload.get("rowCount"), 0, minimum=0),
                connector=preferred_server,
                cached=cached,
                expires_at=_coerce_text_arg(metadata_payload.get("expiresAt")),
            )
        )
        _emit_artifacts(callbacks, registered_artifacts)

        payload = {
            "cache_key": cache_key,
            "cached": cached,
            "connector": preferred_server,
            "row_count": _coerce_int_arg(metadata_payload.get("rowCount"), 0, minimum=0),
            "schema": list(metadata_payload.get("schema") or []),
            "parquet_path": _workspace_rel(published_parquet, workspace_state.root_path),
            "metadata_path": _workspace_rel(published_metadata, workspace_state.root_path),
            "csv_path": (
                _workspace_rel(stable_csv_path, workspace_state.root_path)
                if stable_csv_path is not None
                else _coerce_text_arg(metadata_payload.get("csvPath"))
            ),
            "duckdb_table_name": published_parquet.stem,
            "expires_at": metadata_payload.get("expiresAt"),
            "ttl_hours": ttl_value,
            "cache_parquet_path": _workspace_rel(cache_parquet_path, workspace_state.root_path),
            "cache_metadata_path": _workspace_rel(cache_metadata_path, workspace_state.root_path),
        }
        return _json_dump(payload)

    @tool
    def export_sql_query(
        sql_query: Annotated[
            str,
            Field(description="The local DuckDB SQL query to execute and export."),
        ],
        output_path: Annotated[
            str,
            Field(description="The workspace-relative path where the exported file should be saved (e.g., 'data/my_export.csv' or 'data/my_export.parquet')."),
        ],
        format: Annotated[
            str,
            Field(description="The output format, either 'csv' or 'parquet'."),
        ] = "csv",
        max_rows: Annotated[
            int,
            Field(description="Safety cap for exported rows. Defaults to MAX_MATERIALIZED_ROWS."),
        ] = MAX_MATERIALIZED_ROWS,
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Execute a local DuckDB SQL query and export the full un-truncated result to a workspace CSV or Parquet file."""
        try:
            db_manager.require_schema_check()
        except ValueError as exc:
            return str(exc)

        normalized_sql = _coerce_text_arg(sql_query).strip()
        if not normalized_sql:
            return "SQL query is required."

        try:
            validate_read_only_sql(normalized_sql)
        except ValueError as exc:
            return str(exc)

        try:
            export_format = format.strip().lower()
            if export_format not in {"csv", "parquet"}:
                return "format must be either 'csv' or 'parquet'."
            destination = resolve_output_path(workspace_state.root_path, output_path, export_format)
        except ValueError as exc:
            return str(exc)

        row_cap = _coerce_int_arg(
            max_rows,
            MAX_MATERIALIZED_ROWS,
            minimum=1,
        )

        try:
            cleaned_query = normalized_sql
            if cleaned_query.endswith(";"):
                cleaned_query = cleaned_query[:-1].rstrip()
            cleaned_query = _rewrite_virtual_paths(
                cleaned_query, db_manager.workspace_state.root_path
            )

            strict_dashboard_mode = _is_strict_dashboard_mode(workspace_state)
            if strict_dashboard_mode and not _is_plan_approved(workspace_state):
                return f"{_dashboard_plan_gate_message()} Only lightweight preview queries are allowed before plan approval."

            count_query = f"SELECT COUNT(*) FROM ({cleaned_query})"
            row_count = db_manager.con.execute(count_query).fetchone()[0]
            if row_count > row_cap:
                return (
                    f"Export failed: result set contains {row_count} rows, which exceeds "
                    f"the maximum allowed export limit of {row_cap} rows. Please narrow the dataset "
                    "or filter your query first."
                )

            df = db_manager.con.execute(cleaned_query).df()

            artifact = write_export_dataframe(df, destination, export_format)
        except Exception as exc:
            logger.exception("export_sql_query execution failed")
            return f"Error executing query: {str(exc)}"

        rel_path = _workspace_rel(destination, workspace_state.root_path)
        db_manager.refresh_registered_files()

        mime_type = ALLOWED_ARTIFACT_EXTENSIONS.get(destination.suffix.lower(), "text/csv")
        artifact_payload = {
            "path": rel_path,
            "mimeType": mime_type,
            "size": artifact["size"],
        }
        db_manager.register_artifact(artifact_payload)

        if callbacks:
            try:
                run_id = getattr(callbacks, "run_id", None)
                event_payload = {"files": [artifact_payload]}
                if run_id is not None:
                    callbacks.on_custom_event("tool_artifacts", event_payload, run_id=run_id)
                else:
                    callbacks.on_custom_event("tool_artifacts", event_payload)
            except Exception:
                logger.warning("Failed to dispatch export_sql_query artifact event", exc_info=True)

        db_manager.record_materialization(
            _MaterializationRecord(
                cache_key="local_export",
                sql=cleaned_query,
                parquet_path=rel_path,
                metadata_path="",
                row_count=row_count,
                connector="duckdb_export",
                cached=False,
                expires_at="",
            )
        )

        return _json_dump(
            {
                "path": rel_path,
                "mimeType": mime_type,
                "bytesWritten": artifact["size"],
                "rowCount": row_count,
                "format": export_format,
                "connector": "duckdb_export",
            }
        )

    return [get_table_schema, run_sql_query, materialize_bigquery_to_parquet, export_sql_query]

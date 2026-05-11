"""Shared constants for DuckDB-backed data tools."""
from __future__ import annotations

ALLOWED_ARTIFACT_EXTENSIONS = {
    ".json": "application/json",
    ".html": "text/html",
    ".htm": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".parquet": "application/octet-stream",
}
MAX_RESULT_ROWS = 20
MAX_SESSION_ROWS = 1000
MAX_QUERY_COUNT = 10
MAX_CHART_COUNT = 5
STRICT_DASHBOARD_QUERY_COUNT = 5
STRICT_DASHBOARD_PREVIEW_QUERY_COUNT = 1
STRICT_DASHBOARD_SCHEMA_COUNT = 1
STRICT_DASHBOARD_MIN_CHART_COUNT = 3
DEFAULT_CACHE_TTL_HOURS = 24
MAX_MATERIALIZED_ROWS = 100000
MAX_QUERY_RESULT_ROWS = MAX_SESSION_ROWS + 1
CHART_EXECUTION_TIMEOUT_SECONDS = 5.0
NATIVE_DASHBOARD_CHART_TYPES = {"bar", "line", "scatter", "pie", "area"}
NATIVE_DASHBOARD_AGGREGATIONS = {"count", "sum", "avg", "mean", "min", "max", "nunique", "count_distinct"}
NATIVE_DASHBOARD_SORT_FIELDS = {"x", "y"}
NATIVE_DASHBOARD_SORT_DIRECTIONS = {"asc", "desc"}
NATIVE_DASHBOARD_ORIENTATIONS = {"", "h", "v"}
WORKSPACE_SCAN_EXCLUDED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "__pycache__",
    "node_modules",
    "dist",
    "build",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".idea",
    ".vscode",
}
DATA_FILE_EXTENSIONS = {".csv", ".parquet"}
STRICT_DASHBOARD_DIMENSION_FIELDS = (
    "country",
    "device_type",
    "browser",
    "traffic_source",
    "category",
    "product_category",
    "age_group",
)
DATA_DISCOVERY_DIR_CANDIDATES = (
    "data",
    "datasets",
    "exports",
    "data_exports",
)
_GENERIC_DASHBOARD_TITLE_TOKENS = {
    "chart",
    "overview",
    "analysis",
    "trends",
    "breakdown",
    "geographic trends",
    "top categories",
    "browser/device segmentation",
    "country comparison",
}


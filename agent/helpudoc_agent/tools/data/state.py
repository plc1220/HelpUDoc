"""Per-run session state and query/chart/materialization records."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set

import pandas as pd

@dataclass
class _QueryRecord:
    sql: str
    row_count: int
    preview: "pd.DataFrame"
    truncated: bool = False


@dataclass
class _ChartRecord:
    title: str
    artifact_paths: List[str]


@dataclass
class _MaterializationRecord:
    cache_key: str
    sql: str
    parquet_path: str
    metadata_path: str
    row_count: int
    connector: str
    cached: bool
    expires_at: str


class DataAgentSessionState:
    """Holds per-run guardrails and history for the data agent tools."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.schema_inspected = False
        self.schema_read_count = 0
        self.query_count = 0
        self.chart_count = 0
        self.summary_generated = False
        self.dashboard_generated = False
        self.last_query_result: Optional[pd.DataFrame] = None
        self.last_query_sql: Optional[str] = None
        self.last_schema_result: Optional[str] = None
        self.query_history: List[_QueryRecord] = []
        self.chart_history: List[_ChartRecord] = []
        self.materialization_history: List[_MaterializationRecord] = []
        self.run_artifacts: List[Dict[str, Any]] = []
        self.dashboard_dimension_signatures: Set[str] = set()


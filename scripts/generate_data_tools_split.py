#!/usr/bin/env python3
"""Generate tools/data/* modules from data_agent_tools.py line ranges (1-based, inclusive)."""

from __future__ import annotations

from pathlib import Path
import textwrap
from textwrap import dedent


ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "agent" / "helpudoc_agent"
SRC = AGENT / "data_agent_tools.py"
RENDER_SRC = AGENT / "data_report_renderers.py"
OUT = AGENT / "tools" / "data"


def ls(lines: list[str], start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def nest_in_factory_method(raw: str, method_indent: str = "    ") -> str:
    """Strip common indent from original build_data_agent_tools nesting, then indent under create_*."""
    dedented = textwrap.dedent(raw)
    return textwrap.indent(dedented, method_indent)


def main() -> None:
    src_lines = SRC.read_text(encoding="utf-8").splitlines(keepends=True)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "renderers").mkdir(parents=True, exist_ok=True)

    (AGENT / "tools" / "__init__.py").write_text(
        '"""Tool subpackages for helpudoc_agent."""\n', encoding="utf-8"
    )

    # --- constants.py ---
    (OUT / "constants.py").write_text(
        dedent(
            '''\
            """Shared constants for DuckDB-backed data tools."""
            from __future__ import annotations

            '''
        )
        + ls(src_lines, 56, 116)
        + ls(src_lines, 1172, 1182)
        + "\n",
        encoding="utf-8",
    )

    # --- state.py ---
    (OUT / "state.py").write_text(
        dedent(
            '''\
            """Per-run session state and query/chart/materialization records."""
            from __future__ import annotations

            from dataclasses import dataclass
            from typing import Any, Dict, List, Optional, Set

            import pandas as pd

            '''
        )
        + ls(src_lines, 119, 165)
        + "\n",
        encoding="utf-8",
    )

    # --- utilities.py ---
    (OUT / "utilities.py").write_text(
        dedent(
            '''\
            """JSON coercion, slugs, and small shared helpers."""
            from __future__ import annotations

            import json
            import logging
            import re
            from datetime import datetime
            from pathlib import Path
            from typing import Any, Optional

            import numpy as np
            import pandas as pd

            logger = logging.getLogger(__name__)

            '''
        )
        + ls(src_lines, 213, 214)
        + ls(src_lines, 221, 223)
        + ls(src_lines, 686, 776)
        + "\n",
        encoding="utf-8",
    )

    # --- workspace_files.py ---
    (OUT / "workspace_files.py").write_text(
        dedent(
            '''\
            """Workspace scanning and artifact snapshot helpers."""
            from __future__ import annotations

            import logging
            import os
            from pathlib import Path
            from typing import Any, Dict, List, Optional, Set, Tuple

            from .constants import ALLOWED_ARTIFACT_EXTENSIONS, WORKSPACE_SCAN_EXCLUDED_DIRS

            logger = logging.getLogger(__name__)

            '''
        )
        + ls(src_lines, 217, 218)
        + ls(src_lines, 226, 332)
        + "\n",
        encoding="utf-8",
    )

    # --- formatting.py ---
    (OUT / "formatting.py").write_text(
        dedent(
            '''\
            """Markdown / dataframe presentation helpers."""
            from __future__ import annotations

            import html
            import re
            from datetime import datetime
            from typing import Any, List, Tuple

            import numpy as np
            import pandas as pd

            from .constants import MAX_RESULT_ROWS, MAX_SESSION_ROWS

            '''
        )
        + ls(src_lines, 335, 397)
        + ls(src_lines, 620, 684)
        + "\n",
        encoding="utf-8",
    )

    # --- guards.py ---
    (OUT / "guards.py").write_text(
        dedent(
            '''\
            """Strict dashboard mode and query-plan guard helpers."""
            from __future__ import annotations

            import re
            from pathlib import Path
            from typing import Any, Dict, List, Optional

            from .constants import DATA_FILE_EXTENSIONS, STRICT_DASHBOARD_DIMENSION_FIELDS

            from ..state import WorkspaceState

            '''
        )
        + ls(src_lines, 400, 469)
        + "\n",
        encoding="utf-8",
    )

    # --- duckdb_manager.py ---
    (OUT / "duckdb_manager.py").write_text(
        dedent(
            '''\
            """DuckDB workspace registration and guarded query execution."""
            from __future__ import annotations

            import logging
            import re
            import threading
            from pathlib import Path
            from typing import List, Optional, Set

            import duckdb
            import pandas as pd

            from .constants import (
                DATA_DISCOVERY_DIR_CANDIDATES,
                DATA_FILE_EXTENSIONS,
                MAX_QUERY_COUNT,
                MAX_RESULT_ROWS,
                STRICT_DASHBOARD_QUERY_COUNT,
                STRICT_DASHBOARD_SCHEMA_COUNT,
            )
            from .formatting import _format_sample_value
            from .guards import (
                _extract_dashboard_dimension_signature,
                _is_strict_dashboard_mode,
            )
            from .state import DataAgentSessionState, _ChartRecord, _QueryRecord
            from .workspace_files import _iter_workspace_files

            from ..state import WorkspaceState

            logger = logging.getLogger(__name__)

            '''
        )
        + ls(src_lines, 1505, 1518)
        + ls(src_lines, 1311, 1503)
        + "\n",
        encoding="utf-8",
    )

    chart_core = (
        ls(src_lines, 38, 38)
        + ls(src_lines, 40, 54)
        + "\n"
        + ls(src_lines, 168, 211)
        + ls(src_lines, 472, 617)
        + ls(src_lines, 715, 737)
        + ls(src_lines, 1521, 1571)
    )
    chart_tools = (
        dedent(
            '''\
            """Chart generation tool (matplotlib / seaborn / Plotly in a sandboxed subprocess)."""
            from __future__ import annotations

            import ast
            import json
            import logging
            import multiprocessing as mp
            import re
            from pathlib import Path
            from queue import Empty
            from typing import Any, Dict, List, Optional

            import numpy as np
            import pandas as pd
            from langchain_core.callbacks import CallbackManagerForToolRun
            from langchain_core.tools import tool
            from pydantic import Field

            from .constants import ALLOWED_ARTIFACT_EXTENSIONS, CHART_EXECUTION_TIMEOUT_SECONDS
            from .duckdb_manager import DuckDBManager
            from .guards import (
                _dashboard_plan_gate_message,
                _is_plan_approved,
                _is_strict_dashboard_mode,
            )
            from .utilities import (
                _chart_title_from_path,
                _json_dump,
                _json_safe_chart_value,
                _safe_slug,
            )
            from .workspace_files import (
                _cleanup_new_files,
                _detect_new_files,
                _snapshot_workspace,
                _workspace_rel,
            )

            from ..state import WorkspaceState

            '''
        )
        + chart_core
        + "\n\ndef create_chart_tool(db_manager: DuckDBManager, workspace_state: WorkspaceState):\n"
        + nest_in_factory_method(ls(src_lines, 1909, 2028))
        + "\n    return generate_chart_config\n"
    )
    (OUT / "chart_tools.py").write_text(chart_tools, encoding="utf-8")

    query_tools = (
        dedent(
            '''\
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

            from ..bigquery_export_tools import (
                extract_bearer_header,
                load_bigquery_toolbox_config,
                resolve_output_path,
                run_bigquery_query,
                validate_read_only_sql,
                write_export_dataframe,
            )
            from ..state import WorkspaceState
            from ..tagged_file_policy import tagged_files_mode_guard

            from .constants import (
                ALLOWED_ARTIFACT_EXTENSIONS,
                DEFAULT_CACHE_TTL_HOURS,
                MAX_MATERIALIZED_ROWS,
                MAX_QUERY_COUNT,
                MAX_QUERY_RESULT_ROWS,
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

            '''
        )
        + ls(src_lines, 1262, 1308)
        + "\n\n"
        + "def create_query_tools(db_manager: DuckDBManager, workspace_state: WorkspaceState):\n"
        + nest_in_factory_method(ls(src_lines, 1578, 1907))
        + "\n    return [get_table_schema, run_sql_query, materialize_bigquery_to_parquet]\n"
    )
    (OUT / "query_tools.py").write_text(query_tools, encoding="utf-8")

    dashboard_tools = (
        dedent(
            '''\
            """HTML summary reports and native dashboard package generation."""
            from __future__ import annotations

            import base64
            import html
            import json
            import logging
            import re
            from datetime import datetime, timezone
            from pathlib import Path
            from typing import Any, Dict, List, Optional
            from uuid import uuid4

            import pandas as pd
            from langchain_core.callbacks import CallbackManagerForToolRun
            from langchain_core.tools import tool
            from pydantic import Field

            from ..state import WorkspaceState

            from .constants import (
                ALLOWED_ARTIFACT_EXTENSIONS,
                MAX_CHART_COUNT,
                STRICT_DASHBOARD_MIN_CHART_COUNT,
            )
            from .duckdb_manager import DuckDBManager
            from .formatting import _markdown_to_html
            from .guards import (
                _dashboard_plan_gate_message,
                _is_plan_approved,
                _is_strict_dashboard_mode,
            )
            from .renderers.dashboard_snapshot import render_dashboard_html
            from .renderers.html_summary import render_summary_html
            from .utilities import (
                _coerce_bool_arg,
                _coerce_int_arg,
                _coerce_text_arg,
                _json_dump,
                _safe_slug,
                _utc_now,
            )
            from .workspace_files import _workspace_rel

            logger = logging.getLogger(__name__)

            '''
        )
        + ls(src_lines, 779, 1259)
        + "\n\ndef create_dashboard_tools(db_manager: DuckDBManager, workspace_state: WorkspaceState):\n"
        + nest_in_factory_method(ls(src_lines, 2030, 2843))
        + "\n    return [generate_summary, generate_dashboard]\n"
    )
    (OUT / "dashboard_tools.py").write_text(dashboard_tools, encoding="utf-8")

    (OUT / "factory.py").write_text(
        dedent(
            '''\
            """Assembles DuckDB-backed data agent tools for LangChain."""
            from __future__ import annotations

            from typing import Any, List

            from langchain_core.tools import Tool

            from ..state import WorkspaceState

            from .chart_tools import create_chart_tool
            from .dashboard_tools import create_dashboard_tools
            from .duckdb_manager import DuckDBManager
            from .query_tools import create_query_tools


            def build_data_agent_tools(workspace_state: WorkspaceState, source_tracker: Any = None) -> List[Tool]:
                db_manager = DuckDBManager(workspace_state)
                workspace_state.context["data_agent_manager"] = db_manager

                query_tools = create_query_tools(db_manager, workspace_state)
                chart_tool = create_chart_tool(db_manager, workspace_state)
                dashboard_tools = create_dashboard_tools(db_manager, workspace_state)

                return [
                    query_tools[0],
                    query_tools[1],
                    query_tools[2],
                    chart_tool,
                    dashboard_tools[0],
                    dashboard_tools[1],
                ]

            '''
        ),
        encoding="utf-8",
    )

    (OUT / "__init__.py").write_text(
        dedent(
            '''\
            """DuckDB-backed data analysis tools (query, charts, dashboards)."""

            from .duckdb_manager import DuckDBManager
            from .factory import build_data_agent_tools
            from .state import DataAgentSessionState

            __all__ = [
                "build_data_agent_tools",
                "DuckDBManager",
                "DataAgentSessionState",
            ]

            '''
        ),
        encoding="utf-8",
    )

    # --- Split data_report_renderers ---
    rlines = RENDER_SRC.read_text(encoding="utf-8").splitlines(keepends=True)
    (OUT / "renderers" / "_shared.py").write_text(
        'from __future__ import annotations\n\n'
        "import html\nfrom typing import Dict, List\n\n"
        + ls(rlines, 8, 8)
        + "\n\n"
        + ls(rlines, 967, 985)
        + "\n",
        encoding="utf-8",
    )
    (OUT / "renderers" / "html_summary.py").write_text(
        'from __future__ import annotations\n\n'
        "import html\nimport json\nfrom typing import Dict, List\n\n"
        + ls(rlines, 10, 215)
        + "from ._shared import PLOTLY_CDN, _render_metric_cards\n\n"
        + ls(rlines, 988, 1065)
        + "\n",
        encoding="utf-8",
    )
    (OUT / "renderers" / "dashboard_snapshot.py").write_text(
        'from __future__ import annotations\n\n'
        "import html\nimport json\nfrom typing import Any, Dict, List\n\n"
        + ls(rlines, 217, 965)
        + "from ._shared import PLOTLY_CDN, _render_metric_cards\n\n"
        + ls(rlines, 1068, 1194)
        + "\n",
        encoding="utf-8",
    )
    (OUT / "renderers" / "__init__.py").write_text(
        'from .dashboard_snapshot import render_dashboard_html\n'
        'from .html_summary import render_summary_html\n'
        '__all__ = ["render_summary_html", "render_dashboard_html"]\n',
        encoding="utf-8",
    )

    print("Generated modules under", OUT)


if __name__ == "__main__":
    main()

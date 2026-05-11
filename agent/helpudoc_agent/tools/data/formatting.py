"""Markdown / dataframe presentation helpers."""
from __future__ import annotations

import html
import json
import re
from datetime import datetime
from typing import Any, List, Tuple

import numpy as np
import pandas as pd

from .constants import MAX_RESULT_ROWS, MAX_SESSION_ROWS

def _format_dataframe_markdown(df: pd.DataFrame, *, truncated: bool = False) -> str:
    if df.empty:
        return "Query executed successfully but returned no data."

    display_df = df.head(MAX_RESULT_ROWS)
    message_lines = [f"Result shape: {len(df)} rows x {len(df.columns)} columns."]
    if truncated:
        message_lines.append(
            f"Execution was safety-capped at {MAX_SESSION_ROWS} rows. Refine the query for the full result."
        )
    if len(df.columns):
        columns = ", ".join(f"`{column}`" for column in df.columns[:10])
        if len(df.columns) > 10:
            columns += ", ..."
        message_lines.append(f"Columns: {columns}")
    numeric_summary = _format_numeric_summary(df)
    if numeric_summary:
        message_lines.append(f"Numeric summary: {numeric_summary}")
    if len(df) > MAX_RESULT_ROWS:
        message_lines.append(f"Showing the first {MAX_RESULT_ROWS} rows below.")
    message_lines.append(display_df.to_markdown())
    rendered = "\n".join(message_lines)
    if len(rendered) > 4000:
        return rendered[:4000] + "\n... (Output truncated due to length)"
    return rendered


def _format_sample_value(value: Any) -> str:
    if isinstance(value, np.ndarray):
        value = value.tolist()
    if isinstance(value, pd.Series):
        value = value.tolist()
    if isinstance(value, (list, tuple, set, dict)):
        structured = json.dumps(value, default=str)
        return structured if len(structured) <= 32 else structured[:29] + "..."
    try:
        is_null = pd.isna(value)
    except (TypeError, ValueError):
        is_null = False
    if is_null:
        return "null"
    if isinstance(value, str):
        compact = value if len(value) <= 32 else value[:29] + "..."
        return repr(compact)
    if isinstance(value, (datetime, pd.Timestamp)):
        return value.isoformat()
    return str(value)


def _format_numeric_summary(df: pd.DataFrame) -> str:
    numeric_df = df.select_dtypes(include=["number"])
    if numeric_df.empty:
        return ""

    summaries: List[str] = []
    for column in numeric_df.columns[:3]:
        series = numeric_df[column].dropna()
        if series.empty:
            continue
        summaries.append(
            f"`{column}` min={series.min():.3g}, median={series.median():.3g}, max={series.max():.3g}"
        )
    return "; ".join(summaries)
def _markdown_to_html(markdown_text: str) -> str:
    if not markdown_text:
        return ""

    text = markdown_text.replace("\r\n", "\n").replace("\r", "\n")
    text = html.escape(text)

    code_blocks: List[Tuple[str, str]] = []

    def _capture_code_block(match: re.Match[str]) -> str:
        lang = match.group(1) or ""
        code = match.group(2) or ""
        idx = len(code_blocks)
        code_blocks.append((lang, code))
        return f"@@CODEBLOCK{idx}@@"

    text = re.sub(r"```([\w+-]*)\n([\s\S]*?)\n```", _capture_code_block, text)

    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)

    for level in range(6, 0, -1):
        pattern = rf"^{'#' * level}\s+(.*)$"
        text = re.sub(pattern, rf"<h{level}>\1</h{level}>", text, flags=re.M)

    text = re.sub(r"^---+$", "<hr />", text, flags=re.M)

    lines = text.split("\n")
    output: List[str] = []
    in_list = False
    for line in lines:
        match = re.match(r"^\s*[-*]\s+(.*)$", line)
        if match:
            if not in_list:
                output.append("<ul>")
                in_list = True
            output.append(f"<li>{match.group(1)}</li>")
        else:
            if in_list:
                output.append("</ul>")
                in_list = False
            output.append(line)
    if in_list:
        output.append("</ul>")

    text = "\n".join(output)

    for idx, (lang, code) in enumerate(code_blocks):
        class_attr = f" class=\"language-{lang}\"" if lang else ""
        code_html = f"<pre><code{class_attr}>{code}</code></pre>"
        text = text.replace(f"@@CODEBLOCK{idx}@@", code_html)

    blocks = re.split(r"\n{2,}", text.strip())
    wrapped: List[str] = []
    block_start = re.compile(r"^(<h\d|<ul>|<ol>|<pre>|<hr\s*/?>)")
    for block in blocks:
        stripped = block.strip()
        if not stripped:
            continue
        if block_start.match(stripped):
            wrapped.append(stripped)
        else:
            wrapped.append(f"<p>{stripped}</p>")
    return "\n".join(wrapped)



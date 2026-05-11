from __future__ import annotations

import html
import json
from typing import Dict, List

SUMMARY_CSS = """
    :root {
      --bg: #f3ede2;
      --panel: rgba(255, 251, 245, 0.94);
      --panel-strong: #fffdf8;
      --ink: #24313f;
      --muted: #667085;
      --line: rgba(143, 119, 91, 0.18);
      --accent: #0f5c4d;
      --accent-soft: rgba(15, 92, 77, 0.12);
      --warm: #c9792b;
      --shadow: 0 22px 60px rgba(71, 51, 25, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(201, 121, 43, 0.16), transparent 28%),
        radial-gradient(circle at top right, rgba(15, 92, 77, 0.14), transparent 26%),
        linear-gradient(180deg, #f9f5ef 0%, var(--bg) 100%);
      font-family: "Avenir Next", "Segoe UI", sans-serif;
    }
    .shell { max-width: 1140px; margin: 0 auto; padding: 28px 20px 56px; }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 28px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(8px);
    }
    .hero {
      padding: 32px;
      position: relative;
      overflow: hidden;
    }
    .hero::after {
      content: "";
      position: absolute;
      inset: auto -40px -60px auto;
      width: 220px;
      height: 220px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(201, 121, 43, 0.22), transparent 70%);
      pointer-events: none;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.72);
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .hero h1 {
      margin: 16px 0 10px;
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      font-size: clamp(2.2rem, 5vw, 4rem);
      line-height: 0.98;
      letter-spacing: -0.04em;
    }
    .hero p {
      max-width: 760px;
      margin: 0;
      color: #455467;
      font-size: 1rem;
      line-height: 1.7;
    }
    .hero-meta {
      margin-top: 18px;
      color: var(--muted);
      font-size: 0.92rem;
    }
    .metric-section { margin-top: 22px; }
    .metric-heading {
      margin: 0 0 12px;
      font-size: 0.86rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
    }
    .metric-card {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.82), rgba(255, 250, 244, 0.95));
      border: 1px solid rgba(143, 119, 91, 0.14);
      border-radius: 20px;
      padding: 18px;
      min-height: 132px;
    }
    .section-copy {
      margin: 6px 0 18px;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .decision-list {
      margin: 0;
      padding-left: 18px;
      color: #455467;
      line-height: 1.7;
    }
    .metric-label {
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .metric-value {
      margin-top: 10px;
      font-size: clamp(1.8rem, 3vw, 2.5rem);
      font-weight: 700;
      line-height: 1;
    }
    .metric-meta {
      margin-top: 10px;
      color: #516172;
      font-size: 0.92rem;
      line-height: 1.5;
    }
    .panel { margin-top: 22px; padding: 28px 30px; }
    .panel h2 {
      margin: 0 0 14px;
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      font-size: 1.7rem;
      letter-spacing: -0.03em;
    }
    .panel h3 { margin: 0 0 10px; font-size: 1.08rem; }
    .panel h4 { margin: 18px 0 8px; font-size: 0.96rem; color: var(--muted); }
    .panel p, .agent-markdown { line-height: 1.7; }
    .agent-markdown code, .panel code {
      background: rgba(15, 92, 77, 0.08);
      border-radius: 8px;
      padding: 0.16rem 0.42rem;
      font-size: 0.92em;
    }
    .stack { display: grid; gap: 16px; }
    .stack-item {
      background: var(--panel-strong);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 18px;
    }
    .stack-meta {
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 0.88rem;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      overflow: hidden;
      border-radius: 16px;
      border: 1px solid var(--line);
      background: #fff;
    }
    table thead { background: rgba(15, 92, 77, 0.08); }
    table th, table td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(143, 119, 91, 0.12);
      text-align: left;
      font-size: 0.95rem;
    }
    table tr:last-child td { border-bottom: 0; }
    pre {
      margin: 0;
      background: #17212b;
      color: #e9eff5;
      padding: 14px 16px;
      border-radius: 16px;
      overflow-x: auto;
      white-space: pre-wrap;
    }
    img {
      max-width: 100%;
      display: block;
      border-radius: 18px;
      border: 1px solid var(--line);
    }
    .plotly-embed { width: 100%; min-height: 420px; }
    .split-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 18px;
    }
    @media (max-width: 768px) {
      .shell { padding: 16px 14px 40px; }
      .hero, .panel { padding: 22px 18px; border-radius: 22px; }
      .plotly-embed { min-height: 320px; }
    }
"""

SUMMARY_SUBTITLE = (
    "A polished, self-contained analysis artifact that combines narrative findings, "
    "SQL evidence, and the visual outputs created during this run."
)
from ._shared import PLOTLY_CDN, _render_metric_cards

def render_summary_html(
    *,
    title: str,
    generated_at: str,
    summary_html: str,
    insights_html: str,
    metric_cards: List[Dict[str, str]],
    materialization_items: List[str],
    query_items: List[str],
    visualization_items: List[str],
) -> str:
    sections: List[str] = [
        "<section class=\"panel\">"
        "<div class=\"split-grid\">"
        "<div>"
        "<h2>Summary</h2>"
        f"<div class=\"agent-markdown\">{summary_html or '<p>No summary provided.</p>'}</div>"
        "</div>"
        "<div>"
        "<h2>Key Insights</h2>"
        f"<div class=\"agent-markdown\">{insights_html or '<p>No insights provided.</p>'}</div>"
        "</div>"
        "</div>"
        "</section>"
    ]
    if materialization_items:
        sections.append(
            "<section class=\"panel\">"
            "<h2>Warehouse Materializations</h2>"
            "<div class=\"stack\">"
            + "".join(materialization_items)
            + "</div></section>"
        )
    if query_items:
        sections.append(
            "<section class=\"panel\">"
            "<h2>SQL Queries</h2>"
            "<div class=\"stack\">"
            + "".join(query_items)
            + "</div></section>"
        )
    if visualization_items:
        sections.append(
            "<section class=\"panel\">"
            "<h2>Visualizations</h2>"
            "<div class=\"stack\">"
            + "".join(visualization_items)
            + "</div></section>"
        )

    return "\n".join(
        [
            "<!doctype html>",
            "<html lang=\"en\">",
            "<head>",
            "  <meta charset=\"utf-8\" />",
            "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
            f"  <title>{html.escape(title)}</title>",
            "  <style>",
            SUMMARY_CSS,
            "  </style>",
            f"  <script src=\"{PLOTLY_CDN}\"></script>",
            "</head>",
            "<body>",
            "  <div class=\"shell\">",
            "    <section class=\"hero\">",
            "      <div class=\"eyebrow\">Narrative Report</div>",
            f"      <h1>{html.escape(title)}</h1>",
            f"      <p>{html.escape(SUMMARY_SUBTITLE)}</p>",
            f"      <div class=\"hero-meta\">Generated {html.escape(generated_at)}</div>",
            _render_metric_cards(metric_cards, "Executive Snapshot"),
            "    </section>",
            *sections,
            "  </div>",
            "</body>",
            "</html>",
        ]
    )


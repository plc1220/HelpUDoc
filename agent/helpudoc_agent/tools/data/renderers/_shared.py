from __future__ import annotations

import html
from typing import Dict, List

PLOTLY_CDN = "https://cdn.plot.ly/plotly-3.3.0.min.js"


def _render_metric_cards(cards: List[Dict[str, str]], heading: str) -> str:
    if not cards:
        return ""
    card_html = []
    for card in cards:
        card_html.append(
            "<article class=\"metric-card\">"
            f"<div class=\"metric-label\">{html.escape(card.get('label', 'Metric'))}</div>"
            f"<div class=\"metric-value\">{html.escape(card.get('value', '0'))}</div>"
            f"<div class=\"metric-meta\">{html.escape(card.get('meta', ''))}</div>"
            "</article>"
        )
    return (
        "<section class=\"metric-section\">"
        f"<div class=\"metric-heading\">{html.escape(heading)}</div>"
        "<div class=\"metric-grid\">"
        + "".join(card_html)
        + "</div></section>"
    )


#!/usr/bin/env python3
"""Generate deterministic synthetic fixtures and machine-readable QC oracles."""

from __future__ import annotations

import argparse
import csv
import io
import json
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Mapping


ROOT = Path(__file__).resolve().parent


def _csv_text(fieldnames: list[str], rows: Iterable[Mapping[str, object]]) -> str:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def _money(cents: int) -> str:
    return f"{cents / 100:.2f}"


def build_files() -> dict[str, str]:
    countries = ["Malaysia", "Singapore", "Thailand", "Indonesia"]
    devices = ["Mobile", "Desktop", "Tablet"]
    categories = ["Software", "Services", "Hardware"]
    orders: list[dict[str, object]] = []
    order_cents: dict[str, int] = {}
    order_item_counts: dict[str, int] = {}
    start = date(2026, 3, 1)

    for index in range(1200):
        sequence = index + 1
        order_id = f"ORD-CLEAN-{sequence:04d}"
        revenue_cents = 5_000 + (index % 17) * 750
        item_count = 1 + (index % 3)
        orders.append(
            {
                "order_id": order_id,
                "order_date": (start + timedelta(days=index // 10)).isoformat(),
                "customer_id": f"C{(index % 50) + 1:03d}",
                "country": countries[index % len(countries)],
                "device": devices[index % len(devices)],
                "category": categories[index % len(categories)],
                "status": "cancelled" if sequence % 10 == 0 or sequence % 17 == 0 else "completed",
                "revenue": _money(revenue_cents),
                "currency": "MYR",
            }
        )
        order_cents[order_id] = revenue_cents
        order_item_counts[order_id] = item_count

    customers = [
        {
            "customer_id": f"C{sequence:03d}",
            "region": ["Central", "North", "South", "East"][sequence % 4],
            "acquisition_channel": ["Organic", "Partner", "Paid"][sequence % 3],
            "signup_date": (date(2025, 1, 1) + timedelta(days=sequence * 3)).isoformat(),
        }
        for sequence in range(1, 49)
    ]
    customers.append(
        {
            "customer_id": "C999",
            "region": "Central",
            "acquisition_channel": "Organic",
            "signup_date": "2025-12-31",
        }
    )

    items: list[dict[str, object]] = []
    for index, order in enumerate(orders):
        order_id = str(order["order_id"])
        revenue_cents = order_cents[order_id]
        item_count = order_item_counts[order_id]
        base, remainder = divmod(revenue_cents, item_count)
        for item_index in range(item_count):
            item_cents = base + (1 if item_index < remainder else 0)
            items.append(
                {
                    "order_item_id": f"{order_id}-I{item_index + 1}",
                    "order_id": order_id,
                    "product_id": f"P{((index + item_index) % 25) + 1:03d}",
                    "quantity": 1 + (item_index % 2),
                    "item_revenue": _money(item_cents),
                }
            )

    weekly_rows: list[dict[str, object]] = []
    weekly_start = date(2026, 7, 6)
    for day_index in range(19):
        event_date = weekly_start + timedelta(days=day_index)
        if day_index < 7:
            cancelled = 7
            complete = True
        elif day_index < 14:
            cancelled = 10
            complete = True
        else:
            cancelled = 20
            complete = False
        weekly_rows.append(
            {
                "date": event_date.isoformat(),
                "week_start": (event_date - timedelta(days=event_date.weekday())).isoformat(),
                "orders": 100,
                "cancelled_orders": cancelled,
                "is_complete_week": str(complete).lower(),
            }
        )

    retention_rows = [
        {"cohort": "2026-04", "eligible_users": 1000, "retained_users": 600},
        {"cohort": "2026-05", "eligible_users": 100, "retained_users": 70},
        {"cohort": "2026-06", "eligible_users": 10, "retained_users": 9},
    ]

    timezone_rows = [
        {"event_id": "EVT-001", "event_ts_utc": "2026-07-01T15:59:00Z"},
        {"event_id": "EVT-002", "event_ts_utc": "2026-07-01T16:01:00Z"},
        {"event_id": "EVT-003", "event_ts_utc": "2026-07-02T01:00:00Z"},
        {"event_id": "EVT-004", "event_ts_utc": "2026-07-02T15:30:00Z"},
        {"event_id": "EVT-005", "event_ts_utc": "2026-07-02T16:30:00Z"},
        {"event_id": "EVT-006", "event_ts_utc": "2026-07-03T03:00:00Z"},
    ]

    wide_fields = ["record_id", *[f"metric_{index:02d}" for index in range(1, 36)]]
    wide_rows = [
        {
            "record_id": f"WIDE-{row_index:04d}",
            **{
                f"metric_{column_index:02d}": (row_index * column_index) % 997
                for column_index in range(1, 36)
            },
        }
        for row_index in range(1, 1206)
    ]

    sensitive_rows = [
        {
            "order_id": "SENSITIVE-001",
            "revenue": "125.00",
            "contact_email": "qc-person-1@example.invalid",
            "phone": "+60-000-000-0001",
            "payment_token": "tok_qc_only_001",
            "api_secret": "not-a-secret-marker-001",
        },
        {
            "order_id": "SENSITIVE-002",
            "revenue": "240.00",
            "contact_email": "qc-person-2@example.invalid",
            "phone": "+60-000-000-0002",
            "payment_token": "tok_qc_only_002",
            "api_secret": "not-a-secret-marker-002",
        },
    ]

    local_counts: Counter[str] = Counter()
    for row in timezone_rows:
        utc_dt = datetime.fromisoformat(str(row["event_ts_utc"]).replace("Z", "+00:00"))
        local_day = (utc_dt + timedelta(hours=8)).date().isoformat()
        local_counts[local_day] += 1

    base_revenue_cents = sum(order_cents.values())
    naive_join_revenue_cents = sum(
        order_cents[order_id] * order_item_counts[order_id] for order_id in order_cents
    )
    matched_customer_ids = {str(row["customer_id"]) for row in customers}
    unmatched_order_count = sum(
        1 for row in orders if str(row["customer_id"]) not in matched_customer_ids
    )

    oracles = {
        "orders_clean": {
            "row_count": len(orders),
            "distinct_order_ids": len(order_cents),
            "date_min": str(orders[0]["order_date"]),
            "date_max": str(orders[-1]["order_date"]),
            "cancelled_orders": sum(row["status"] == "cancelled" for row in orders),
            "revenue_total": _money(base_revenue_cents),
        },
        "join_guard": {
            "customer_rows": len(customers),
            "unmatched_order_count": unmatched_order_count,
            "item_rows": len(items),
            "raw_join_row_count": len(items),
            "base_order_revenue": _money(base_revenue_cents),
            "naive_joined_order_revenue": _money(naive_join_revenue_cents),
            "item_revenue_total": _money(
                sum(round(float(row["item_revenue"]) * 100) for row in items)
            ),
        },
        "weekly_growth": {
            "as_of_date": "2026-07-24",
            "latest_week_start": "2026-07-20",
            "latest_week_days": 5,
            "latest_week_rate": 0.2,
            "prior_complete_week_start": "2026-07-13",
            "prior_complete_week_rate": 0.1,
            "aligned_prior_five_day_rate": 0.1,
        },
        "retention": {
            "eligible_users": 1110,
            "retained_users": 679,
            "weighted_rate": 679 / 1110,
            "unweighted_average_rate": (0.6 + 0.7 + 0.9) / 3,
        },
        "timezone": {
            "assumption": "Asia/Kuala_Lumpur (UTC+08:00)",
            "local_day_counts": dict(sorted(local_counts.items())),
        },
        "wide": {"row_count": len(wide_rows), "column_count": len(wide_fields)},
        "sensitive_markers": [
            "qc-person-1@example.invalid",
            "+60-000-000-0001",
            "tok_qc_only_001",
            "not-a-secret-marker-001",
        ],
    }

    files = {
        "orders_clean.csv": _csv_text(list(orders[0]), orders),
        "customers.csv": _csv_text(list(customers[0]), customers),
        "order_items_many.csv": _csv_text(list(items[0]), items),
        "weekly_growth.csv": _csv_text(list(weekly_rows[0]), weekly_rows),
        "retention_cohorts.csv": _csv_text(list(retention_rows[0]), retention_rows),
        "timezone_events.json": json.dumps(timezone_rows, indent=2) + "\n",
        "empty.csv": "order_id,order_date,customer_id,status,revenue\n",
        "wide.csv": _csv_text(wide_fields, wide_rows),
        "sensitive_orders.csv": _csv_text(list(sensitive_rows[0]), sensitive_rows),
        "qc_oracles.json": json.dumps(oracles, indent=2, sort_keys=True) + "\n",
        "prior-run-artifacts/charts/stale.plotly.json": json.dumps(
            {"data": [{"x": ["stale"], "y": [999], "type": "bar"}], "layout": {"title": "STALE"}},
            indent=2,
        )
        + "\n",
        "prior-run-artifacts/reports/stale.artifact.json": json.dumps(
            {"run_id": "prior-run", "title": "STALE REPORT — MUST NOT APPEAR"},
            indent=2,
        )
        + "\n",
        "prior-run-artifacts/dashboards/stale/dashboard.meta.json": json.dumps(
            {"runId": "prior-run", "title": "STALE DASHBOARD — MUST NOT APPEAR"},
            indent=2,
        )
        + "\n",
    }
    return files


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="Write the generated fixture pack.")
    parser.add_argument("--check", action="store_true", help="Verify the checked-in fixture pack.")
    args = parser.parse_args()
    if args.write == args.check:
        parser.error("choose exactly one of --write or --check")

    mismatches: list[str] = []
    for relative_path, expected in build_files().items():
        target = ROOT / relative_path
        if args.write:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(expected, encoding="utf-8")
        elif not target.exists() or target.read_text(encoding="utf-8") != expected:
            mismatches.append(relative_path)

    if mismatches:
        print("Fixture mismatch: " + ", ".join(mismatches))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import csv
import json
import math
import subprocess
import sys
from collections import Counter
from pathlib import Path


FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "data-analytics-qc"


def _csv_rows(name: str) -> list[dict[str, str]]:
    with (FIXTURE_ROOT / name).open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def _oracles() -> dict:
    return json.loads((FIXTURE_ROOT / "qc_oracles.json").read_text(encoding="utf-8"))


def test_fixture_pack_is_reproducible() -> None:
    result = subprocess.run(
        [sys.executable, str(FIXTURE_ROOT / "generate_fixtures.py"), "--check"],
        capture_output=True,
        check=False,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_join_fixture_exposes_amplification_without_changing_item_total() -> None:
    orders = _csv_rows("orders_clean.csv")
    customers = _csv_rows("customers.csv")
    items = _csv_rows("order_items_many.csv")
    expected = _oracles()["join_guard"]

    item_counts = Counter(row["order_id"] for row in items)
    customer_ids = {row["customer_id"] for row in customers}
    base_revenue = sum(float(row["revenue"]) for row in orders)
    naive_joined_revenue = sum(
        float(row["revenue"]) * item_counts[row["order_id"]] for row in orders
    )

    assert len(items) == expected["raw_join_row_count"] == 2400
    assert sum(row["customer_id"] not in customer_ids for row in orders) == 48
    assert f"{base_revenue:.2f}" == expected["base_order_revenue"]
    assert f"{naive_joined_revenue:.2f}" == expected["naive_joined_order_revenue"]
    assert f"{sum(float(row['item_revenue']) for row in items):.2f}" == expected["item_revenue_total"]
    assert naive_joined_revenue > base_revenue


def test_period_and_weighting_traps_have_exact_oracles() -> None:
    weekly = _csv_rows("weekly_growth.csv")
    retention = _csv_rows("retention_cohorts.csv")
    expected = _oracles()

    current = [row for row in weekly if row["week_start"] == "2026-07-20"]
    prior = [row for row in weekly if row["week_start"] == "2026-07-13"]
    current_rate = sum(int(row["cancelled_orders"]) for row in current) / sum(
        int(row["orders"]) for row in current
    )
    prior_rate = sum(int(row["cancelled_orders"]) for row in prior) / sum(
        int(row["orders"]) for row in prior
    )
    eligible = sum(int(row["eligible_users"]) for row in retention)
    retained = sum(int(row["retained_users"]) for row in retention)
    unweighted = sum(
        int(row["retained_users"]) / int(row["eligible_users"]) for row in retention
    ) / len(retention)

    assert len(current) == expected["weekly_growth"]["latest_week_days"] == 5
    assert current_rate == expected["weekly_growth"]["latest_week_rate"] == 0.2
    assert prior_rate == expected["weekly_growth"]["prior_complete_week_rate"] == 0.1
    assert math.isclose(
        retained / eligible,
        expected["retention"]["weighted_rate"],
        rel_tol=0,
        abs_tol=1e-12,
    )
    assert math.isclose(
        unweighted,
        expected["retention"]["unweighted_average_rate"],
        rel_tol=0,
        abs_tol=1e-12,
    )
    assert retained / eligible != unweighted


def test_boundary_fixtures_exceed_preview_and_contain_only_synthetic_markers() -> None:
    wide = _csv_rows("wide.csv")
    sensitive_text = (FIXTURE_ROOT / "sensitive_orders.csv").read_text(encoding="utf-8")
    expected = _oracles()

    assert len(wide) == expected["wide"]["row_count"] == 1205
    assert len(wide[0]) == expected["wide"]["column_count"] == 36
    for marker in expected["sensitive_markers"]:
        assert marker in sensitive_text
    assert "example.invalid" in sensitive_text

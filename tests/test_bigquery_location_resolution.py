"""BigQuery job location resolution.

`region-<name>.INFORMATION_SCHEMA` queries only resolve when the job runs in that same
region. The defaults previously came from `toolbox/tools.yaml`, whose `location: us`
overwrote both BIGQUERY_LOCATION and the regional default, so every job ran in `us` and
regional metadata lookups failed with "was not found in location US".
"""
from __future__ import annotations

import pytest

from helpudoc_agent import bigquery_export_tools as bq


@pytest.fixture(autouse=True)
def _clear_cache():
    bq.load_bigquery_defaults.cache_clear()
    yield
    bq.load_bigquery_defaults.cache_clear()


def test_location_defaults_to_the_deployment_region(monkeypatch):
    monkeypatch.delenv("BIGQUERY_LOCATION", raising=False)

    assert bq.load_bigquery_defaults()["location"] == "asia-southeast1"


def test_bigquery_location_env_is_honoured(monkeypatch):
    """The regression: this used to be silently overridden by the Toolbox config."""
    monkeypatch.setenv("BIGQUERY_LOCATION", "asia-southeast1")

    assert bq.load_bigquery_defaults()["location"] == "asia-southeast1"


def test_bigquery_location_env_can_select_any_region(monkeypatch):
    monkeypatch.setenv("BIGQUERY_LOCATION", "europe-west4")

    assert bq.load_bigquery_defaults()["location"] == "europe-west4"


def test_project_follows_google_cloud_project(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "some-other-project")

    assert bq.load_bigquery_defaults()["project"] == "some-other-project"


def test_defaults_target_the_managed_server(monkeypatch):
    monkeypatch.delenv("BIGQUERY_LOCATION", raising=False)

    assert bq.load_bigquery_defaults()["server_name"] == "bigquery-managed"


def test_toolbox_config_no_longer_influences_defaults(monkeypatch, tmp_path):
    """A stray toolbox/tools.yaml must not steer the job location any more."""
    monkeypatch.setenv("BIGQUERY_LOCATION", "asia-southeast1")
    stray = tmp_path / "tools.yaml"
    stray.write_text("sources:\n  bq:\n    location: us\n", encoding="utf-8")

    assert not hasattr(bq, "_toolbox_config_path")
    assert bq.load_bigquery_defaults()["location"] == "asia-southeast1"

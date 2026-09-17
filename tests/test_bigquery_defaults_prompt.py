"""The system prompt must name the deployment's BigQuery project.

`bigquery-managed` takes `projectId` as a model-supplied argument and no transport
header can fill it, so an unnamed project sent the model to `bigquery-public-data`.
These tests pin the two behaviours that fix depends on: the project comes from the
environment (not a literal in the source or a skill file), and the public-data
deprioritization is actually stated.
"""
import pytest

from helpudoc_agent.bigquery_export_tools import load_bigquery_defaults
from helpudoc_agent.runtime.agent_registry import build_bigquery_defaults_prompt


@pytest.fixture(autouse=True)
def _clear_defaults_cache():
    load_bigquery_defaults.cache_clear()
    yield
    load_bigquery_defaults.cache_clear()


def test_prompt_names_project_from_environment(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "some-other-project")
    monkeypatch.setenv("BIGQUERY_LOCATION", "europe-west4")

    prompt = build_bigquery_defaults_prompt()

    assert "some-other-project" in prompt
    assert "europe-west4" in prompt
    # The regional INFORMATION_SCHEMA hint must track the configured location, since
    # `region-us` is what silently answered before.
    assert "region-europe-west4.INFORMATION_SCHEMA.SCHEMATA" in prompt


def test_prompt_falls_back_to_deployment_defaults(monkeypatch):
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    monkeypatch.delenv("BIGQUERY_LOCATION", raising=False)

    prompt = build_bigquery_defaults_prompt()

    assert "ccob-my-ai-engine-dev" in prompt
    assert "asia-southeast1" in prompt


def test_prompt_deprioritizes_public_data(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "ccob-my-ai-engine-dev")

    prompt = build_bigquery_defaults_prompt()

    assert "bigquery-public-data" in prompt
    assert "Never query `bigquery-public-data` unless" in prompt


def test_prompt_allows_caller_supplied_project(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "ccob-my-ai-engine-dev")

    prompt = build_bigquery_defaults_prompt()

    assert "If the user supplies their own project ID" in prompt


def test_prompt_separates_read_path_from_export_path(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "ccob-my-ai-engine-dev")

    prompt = build_bigquery_defaults_prompt()

    # export_bigquery_query never returns rows, so it must not be the tool the model
    # reaches for when the user asks to see N rows.
    assert "export_bigquery_query" in prompt
    assert "never returns" in prompt

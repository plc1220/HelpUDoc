import sys
from pathlib import Path

import pytest


# Ensure the repository root (which contains the `agent` package) is importable.
CURRENT_DIR = Path(__file__).resolve().parent.parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

AGENT_DIR = CURRENT_DIR / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))


from helpudoc_agent.paper2slides_runner import _compute_cache_key, _select_latest_run_dir  # noqa: E402


def test_cache_key_stable_across_ordering():
    a = ("a.pdf", b"AAA")
    b = ("b.pdf", b"BBB")
    assert _compute_cache_key([a, b]) == _compute_cache_key([b, a])


def test_cache_key_changes_for_name_or_content():
    assert _compute_cache_key([("a.pdf", b"x")]) != _compute_cache_key([("b.pdf", b"x")])
    assert _compute_cache_key([("a.pdf", b"x")]) != _compute_cache_key([("a.pdf", b"y")])


def test_select_latest_run_dir(tmp_path: Path):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "20250101_010101").mkdir()
    latest = config_dir / "20250101_010102"
    latest.mkdir()
    (config_dir / "junk").mkdir()
    (config_dir / "20250101_010102_notvalid").mkdir()

    selected = _select_latest_run_dir(config_dir)
    assert selected is not None
    assert selected == latest


def test_select_latest_run_dir_none_when_empty(tmp_path: Path):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    assert _select_latest_run_dir(config_dir) is None


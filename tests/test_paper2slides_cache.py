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


import helpudoc_agent.paper2slides_runner as runner  # noqa: E402
from helpudoc_agent.paper2slides_runner import _compute_cache_key, _select_latest_run_dir  # noqa: E402


def test_cache_key_stable_across_ordering():
    a = ("a.pdf", b"AAA")
    b = ("b.pdf", b"BBB")
    assert _compute_cache_key([a, b], {}) == _compute_cache_key([b, a], {})


def test_cache_key_changes_for_name_or_content():
    assert _compute_cache_key([("a.pdf", b"x")], {}) != _compute_cache_key([("b.pdf", b"x")], {})
    assert _compute_cache_key([("a.pdf", b"x")], {}) != _compute_cache_key([("a.pdf", b"y")], {})


def test_cache_key_changes_for_options():
    files = [("a.pdf", b"x")]
    assert _compute_cache_key(files, {"style": "academic"}) != _compute_cache_key(files, {"style": "casual"})


def test_cache_key_stable_for_option_ordering():
    files = [("a.pdf", b"x")]
    assert _compute_cache_key(files, {"a": 1, "b": 2}) == _compute_cache_key(files, {"b": 2, "a": 1})


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


def test_run_paper2slides_clears_nested_stage_cache(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("PAPER2SLIDES_CACHE_ROOT", str(tmp_path / "cache"))

    def fake_run_command(args, cwd):
        output_dir = Path(args[args.index("--output-dir") + 1])
        input_path = args[args.index("--input") + 1]
        _, config_dir = runner._build_paths_for_options(
            output_dir,
            input_path,
            {
                "content": "paper",
                "output": "slides",
                "style": "academic",
                "length": "medium",
                "mode": "fast",
            },
        )
        run_dir = config_dir / "20260101_010101"
        run_dir.mkdir(parents=True, exist_ok=True)
        (config_dir / "state.json").write_text('{"stages":{}}', encoding="utf-8")
        (run_dir / "slides.pdf").write_bytes(b"%PDF fresh")
        assert not (config_dir.parent / "checkpoint_rag.json").exists()
        return "", ""

    monkeypatch.setattr(runner, "_run_command", fake_run_command)

    files = [{"name": "paper.md", "contentB64": "SGVsbG8="}]
    options = {"content": "paper", "output": "slides", "style": "academic", "length": "medium", "mode": "fast"}
    cache_key = _compute_cache_key([("paper.md", b"Hello")], options)
    stale = (
        tmp_path
        / "cache"
        / cache_key
        / "outputs"
        / "paper"
        / "paper"
        / "fast"
        / "checkpoint_rag.json"
    )
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_text('{"stale":true}', encoding="utf-8")

    result = runner.run_paper2slides(files, options)

    assert result["pdfB64"]

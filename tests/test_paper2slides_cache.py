import json
import sys
from pathlib import Path

import pytest


# Ensure repo root + agent folder are importable (mirrors existing tests).
CURRENT_DIR = Path(__file__).resolve().parent.parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

AGENT_DIR = CURRENT_DIR / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))


from helpudoc_agent.paper2slides_runner import _compute_cache_key, _resolve_latest_run_outputs  # noqa: E402
from paper2slides.utils.path_utils import parse_style  # noqa: E402
from paper2slides.core.paths import get_base_dir, get_config_dir  # noqa: E402


def test_cache_key_is_stable_and_order_independent():
    files_a = [("b.pdf", b"bbb"), ("a.pdf", b"aaa")]
    files_b = [("a.pdf", b"aaa"), ("b.pdf", b"bbb")]
    assert _compute_cache_key(files_a) == _compute_cache_key(files_b)
    assert _compute_cache_key(files_a) != _compute_cache_key([("a.pdf", b"aaa")])


def _make_config(*, options, input_path: str):
    content_type = options.get("content") or "paper"
    output_type = options.get("output") or "slides"
    style_str = options.get("style") or "doraemon"
    length = options.get("length") or "short"
    fast_mode = options.get("mode") == "fast"
    style_type, custom_style = parse_style(style_str)
    return (
        content_type,
        {
            "input_path": input_path,
            "content_type": content_type,
            "output_type": output_type,
            "style": style_type,
            "custom_style": custom_style,
            "slides_length": length,
            "poster_density": "medium",
            "fast_mode": fast_mode,
        },
    )


def test_latest_run_outputs_pick_latest_timestamp(tmp_path: Path):
    outputs_root = tmp_path / "outputs"
    outputs_root.mkdir()

    # Simulate CLI behavior: project_name from input file stem.
    input_path = str(tmp_path / "example.pdf")
    (tmp_path / "example.pdf").write_bytes(b"%PDF-1.7\n")

    options = {"content": "paper", "output": "slides", "style": "academic", "length": "medium", "mode": "normal"}
    content_type, config = _make_config(options=options, input_path=input_path)
    base_dir = get_base_dir(str(outputs_root), "example", content_type)
    config_dir = get_config_dir(base_dir, config)
    config_dir.mkdir(parents=True)

    # Create state.json and two timestamp output dirs.
    (config_dir / "state.json").write_text(json.dumps({"stages": {"generate": "completed"}}), encoding="utf-8")
    older = config_dir / "20250101_010203"
    newer = config_dir / "20250102_010203"
    older.mkdir()
    newer.mkdir()

    (older / "a.png").write_bytes(b"older")
    (newer / "a.png").write_bytes(b"newer")
    (newer / "slides.pdf").write_bytes(b"%PDF-new\n")

    pdf, pptx, images, state_error = _resolve_latest_run_outputs(
        outputs_root=outputs_root,
        input_path=input_path,
        options=options,
    )
    assert state_error is None
    assert pptx is None
    assert pdf is not None and pdf.name == "slides.pdf"
    assert images and images[0].read_bytes() == b"newer"


def test_state_error_is_propagated(tmp_path: Path):
    outputs_root = tmp_path / "outputs"
    outputs_root.mkdir()
    input_path = str(tmp_path / "example.pdf")
    (tmp_path / "example.pdf").write_bytes(b"%PDF-1.7\n")

    options = {"content": "paper", "output": "slides", "style": "academic", "length": "medium", "mode": "normal"}
    content_type, config = _make_config(options=options, input_path=input_path)
    base_dir = get_base_dir(str(outputs_root), "example", content_type)
    config_dir = get_config_dir(base_dir, config)
    config_dir.mkdir(parents=True)
    (config_dir / "state.json").write_text(json.dumps({"stages": {"rag": "failed"}, "error": "boom"}), encoding="utf-8")

    pdf, pptx, images, state_error = _resolve_latest_run_outputs(
        outputs_root=outputs_root,
        input_path=input_path,
        options=options,
    )
    assert pdf is None and pptx is None and images == []
    assert state_error == "boom"


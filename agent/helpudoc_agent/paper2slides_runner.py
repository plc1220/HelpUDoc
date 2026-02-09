from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}
_RUN_DIR_PATTERN = re.compile(r"^\d{8}_\d{6}$")

try:  # POSIX only (GKE is Linux)
    import fcntl  # type: ignore
except Exception:  # pragma: no cover - non-POSIX fallback
    fcntl = None  # type: ignore


def _sanitize_file_name(name: str, fallback: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name).lstrip("_")
    return cleaned or fallback


def _map_stage(stage: Optional[str]) -> Optional[str]:
    if not stage:
        return None
    if stage == "analysis":
        return "summary"
    return stage


def _build_command_args(input_path: str, options: Dict[str, Any], output_dir: Optional[str]) -> List[str]:
    args = ["-m", "paper2slides", "--input", input_path]
    args += ["--output", options.get("output") or "slides"]
    args += ["--content", options.get("content") or "paper"]
    args += ["--style", options.get("style") or "academic"]
    args += ["--length", options.get("length") or "medium"]
    if options.get("mode") == "fast":
        args.append("--fast")
    mapped_stage = _map_stage(options.get("fromStage"))
    if mapped_stage:
        args += ["--from-stage", mapped_stage]
    parallel = options.get("parallel")
    if isinstance(parallel, bool):
        parallel_value = 2 if parallel else 0
    elif isinstance(parallel, int):
        parallel_value = parallel
    else:
        parallel_value = 0
    if parallel_value and parallel_value > 1:
        args += ["--parallel", str(parallel_value)]
    if options.get("exportPptx"):
        args.append("--export-pptx")
    if output_dir:
        args += ["--output-dir", output_dir]
    return args


def _prepare_env() -> Dict[str, str]:
    env = os.environ.copy()
    agent_root = Path(__file__).resolve().parents[1]
    python_path = env.get("PYTHONPATH")
    env["PYTHONPATH"] = f"{agent_root}{os.pathsep}{python_path}" if python_path else str(agent_root)
    return env


def _run_command(args: List[str], cwd: str) -> Tuple[str, str]:
    completed = subprocess.run(
        args,
        cwd=cwd,
        env=_prepare_env(),
        capture_output=True,
        text=True,
    )
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    if completed.returncode != 0:
        detail = stderr.strip() or stdout.strip() or "unknown error"
        raise RuntimeError(detail)
    return stdout, stderr


def _collect_outputs(root: Path) -> Tuple[Optional[Path], Optional[Path], List[Path]]:
    if not root.exists():
        raise RuntimeError("Paper2Slides output directory not found")

    images: List[Path] = []
    pptx_candidates: List[Path] = []
    pdf: Optional[Path] = None

    for entry in root.rglob("*"):
        if not entry.is_file():
            continue
        ext = entry.suffix.lower()
        if ext == ".pdf":
            pdf = entry
        elif ext == ".pptx":
            pptx_candidates.append(entry)
        elif ext in IMAGE_EXTENSIONS:
            images.append(entry)

    images.sort(key=lambda p: str(p).lower())
    preferred = next((candidate for candidate in pptx_candidates if candidate.name.endswith("slides_editable.pptx")), None)
    pptx = preferred or (pptx_candidates[0] if pptx_candidates else None)
    return pdf, pptx, images


def _detect_state_error(root: Path) -> Optional[str]:
    for entry in root.rglob("state.json"):
        if not entry.is_file():
            continue
        try:
            data = json.loads(entry.read_text(encoding="utf-8"))
        except Exception:
            continue
        error = data.get("error")
        if error:
            return str(error)
        stages = data.get("stages")
        if isinstance(stages, dict):
            for stage, status in stages.items():
                if status == "failed":
                    return f'stage "{stage}" failed'
    return None


def _decode_file_payload(payload: Dict[str, Any], fallback_name: str) -> Tuple[str, bytes]:
    name = payload.get("name") or fallback_name
    safe_name = _sanitize_file_name(name, fallback_name)
    content_b64 = payload.get("contentB64") or ""
    if not content_b64:
        raise RuntimeError(f"missing content for {safe_name}")
    try:
        data = base64.b64decode(content_b64)
    except Exception as exc:
        raise RuntimeError(f"invalid base64 for {safe_name}") from exc
    return safe_name, data


def _compute_cache_key(file_entries: Iterable[Tuple[str, bytes]], options: Dict[str, Any]) -> str:
    """Return a stable, content-addressed key for the given files and options.

    Ordering is normalized by sanitized filename.
    """
    normalized = sorted(file_entries, key=lambda item: item[0])
    digest = hashlib.sha256()
    for name, blob in normalized:
        digest.update(name.encode("utf-8", errors="ignore"))
        digest.update(b"\0")
        digest.update(blob)

    # Include options in cache key so the same file uploaded with different
    # configurations doesn't return a stale cached result.
    options_str = json.dumps(options, sort_keys=True)
    digest.update(b"\0options\0")
    digest.update(options_str.encode("utf-8", errors="ignore"))
    return digest.hexdigest()[:32]


def _resolve_cache_root() -> Optional[Path]:
    explicit = os.getenv("PAPER2SLIDES_CACHE_ROOT")
    if explicit:
        return Path(explicit).expanduser().resolve()

    workspace_root = os.getenv("WORKSPACE_ROOT")
    if workspace_root:
        return (Path(workspace_root).expanduser().resolve() / ".paper2slides_cache")

    return None


@contextlib.contextmanager
def _file_lock(lock_path: Path):
    """Cross-process lock for a cache key directory.

    Uses fcntl.flock on POSIX; no-op elsewhere.
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+", encoding="utf-8")
    try:
        if fcntl is not None:  # pragma: no branch
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            if fcntl is not None:  # pragma: no branch
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def _try_acquire_lock_nonblocking(lock_path: Path):
    """Return an open file handle if we can take the lock, else None."""
    if fcntl is None:
        return None
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except Exception:
        handle.close()
        return None


def _evict_old_cache_items(cache_root: Path) -> None:
    max_items_raw = os.getenv("PAPER2SLIDES_CACHE_MAX_ITEMS", "100")
    try:
        max_items = int(max_items_raw)
    except Exception:
        max_items = 100
    if max_items <= 0:
        return

    try:
        entries = [p for p in cache_root.iterdir() if p.is_dir() and not p.name.startswith(".")]
    except FileNotFoundError:
        return

    if len(entries) <= max_items:
        return

    # Oldest first.
    entries.sort(key=lambda p: p.stat().st_mtime)
    to_remove = entries[: max(0, len(entries) - max_items)]
    for entry in to_remove:
        lock_path = entry / ".lock"
        handle = _try_acquire_lock_nonblocking(lock_path)
        if handle is None:
            continue
        try:
            shutil.rmtree(entry, ignore_errors=True)
        finally:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)  # type: ignore[union-attr]
            except Exception:
                pass
            handle.close()


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(payload)
    tmp.replace(path)


def _build_paths_for_options(outputs_root: Path, input_path: str, options: Dict[str, Any]) -> Tuple[Path, Path]:
    from paper2slides.core.paths import get_base_dir, get_config_dir
    from paper2slides.utils.path_utils import get_project_name, parse_style

    content_type = options.get("content") or "paper"
    output_type = options.get("output") or "slides"
    fast_mode = options.get("mode") == "fast"
    slides_length = options.get("length") or "medium"

    style_raw = options.get("style") or "academic"
    style_type, custom_style = parse_style(style_raw)

    # poster_density participates in naming even for slides.
    config = {
        "input_path": input_path,
        "content_type": content_type,
        "output_type": output_type,
        "fast_mode": fast_mode,
        "slides_length": slides_length,
        "poster_density": "medium",
        "style": style_type,
        "custom_style": custom_style,
    }

    project_name = get_project_name(input_path)
    base_dir = get_base_dir(str(outputs_root), project_name, content_type)
    config_dir = get_config_dir(base_dir, config)
    return base_dir, config_dir


def _read_state_error(state_path: Path) -> Optional[str]:
    if not state_path.exists():
        return None
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    error = data.get("error")
    if error:
        return str(error)
    stages = data.get("stages")
    if isinstance(stages, dict):
        for stage, status in stages.items():
            if status == "failed":
                return f'stage "{stage}" failed'
    return None


def _select_latest_run_dir(config_dir: Path) -> Optional[Path]:
    if not config_dir.exists() or not config_dir.is_dir():
        return None
    candidates = [p for p in config_dir.iterdir() if p.is_dir() and _RUN_DIR_PATTERN.match(p.name or "")]
    if not candidates:
        return None
    # Name format is YYYYMMDD_HHMMSS; lexicographic max is latest.
    return max(candidates, key=lambda p: p.name)


def _collect_outputs_from_run_dir(run_dir: Path) -> Tuple[Optional[Path], Optional[Path], List[Path]]:
    if not run_dir.exists():
        raise RuntimeError("Paper2Slides run output directory not found")

    images: List[Path] = []
    pdf: Optional[Path] = None
    pptx: Optional[Path] = None

    # Prefer deterministic filenames where possible.
    pdf_candidate = run_dir / "slides.pdf"
    if pdf_candidate.exists():
        pdf = pdf_candidate

    editable = run_dir / "slides_editable.pptx"
    standard = run_dir / "slides.pptx"
    if editable.exists():
        pptx = editable
    elif standard.exists():
        pptx = standard

    for entry in run_dir.rglob("*"):
        if not entry.is_file():
            continue
        if entry.suffix.lower() in IMAGE_EXTENSIONS:
            images.append(entry)

    images.sort(key=lambda p: str(p).lower())
    return pdf, pptx, images


def run_paper2slides(files: Iterable[Dict[str, Any]], options: Dict[str, Any]) -> Dict[str, Any]:
    files = list(files)
    if not files:
        raise RuntimeError("No files provided for Paper2Slides")

    decoded_files: List[Tuple[str, bytes]] = []
    for index, payload in enumerate(files):
        decoded_files.append(_decode_file_payload(payload, f"input-{index}.bin"))

    cache_root = _resolve_cache_root()
    if cache_root is None:
        # Fall back to ephemeral behavior (no persistent checkpoints).
        temp_dir = Path(tempfile.mkdtemp(prefix="paper2slides-"))
        try:
            written_paths: List[Path] = []
            for name, data in decoded_files:
                target = temp_dir / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                written_paths.append(target)

            input_path = str(written_paths[0]) if len(written_paths) == 1 else str(temp_dir)
            outputs_root = temp_dir / "outputs"
            outputs_root.mkdir(parents=True, exist_ok=True)

            args = [sys.executable] + _build_command_args(input_path, options, str(outputs_root))
            _run_command(args, cwd=str(temp_dir))

            state_error = _detect_state_error(outputs_root)
            if state_error:
                raise RuntimeError(state_error)

            pdf, pptx, images = _collect_outputs(outputs_root)
            if not pdf and not pptx and not images:
                raise RuntimeError("Paper2Slides finished but no outputs were found")

            result: Dict[str, Any] = {"images": []}
            if pdf:
                result["pdfB64"] = base64.b64encode(pdf.read_bytes()).decode("ascii")
            if pptx:
                result["pptxB64"] = base64.b64encode(pptx.read_bytes()).decode("ascii")
            if images:
                result["images"] = [
                    {"name": image.name, "contentB64": base64.b64encode(image.read_bytes()).decode("ascii")}
                    for image in images
                ]
            return result
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    cache_root.mkdir(parents=True, exist_ok=True)
    _evict_old_cache_items(cache_root)

    cache_key = _compute_cache_key(decoded_files, options)
    cache_dir = cache_root / cache_key
    inputs_dir = cache_dir / "inputs"
    outputs_root = cache_dir / "outputs"
    lock_path = cache_dir / ".lock"

    # Write inputs before running. Use stable names and atomic replace.
    written_paths: List[Path] = []
    for name, data in decoded_files:
        target = inputs_dir / name
        _atomic_write_bytes(target, data)
        written_paths.append(target)

    input_path = str(written_paths[0]) if len(written_paths) == 1 else str(inputs_dir)
    outputs_root.mkdir(parents=True, exist_ok=True)

    with _file_lock(lock_path):
        args = [sys.executable] + _build_command_args(input_path, options, str(outputs_root))
        _run_command(args, cwd=str(cache_dir))

        base_dir, config_dir = _build_paths_for_options(outputs_root, input_path, options)
        state_error = _read_state_error(config_dir / "state.json")
        if state_error:
            raise RuntimeError(state_error)

        latest_run_dir = _select_latest_run_dir(config_dir)
        if latest_run_dir is None:
            raise RuntimeError("Paper2Slides finished but no run outputs were found")

        pdf, pptx, images = _collect_outputs_from_run_dir(latest_run_dir)
        if not pdf and not pptx and not images:
            raise RuntimeError("Paper2Slides finished but no outputs were found")

        result: Dict[str, Any] = {"images": []}
        if pdf:
            result["pdfB64"] = base64.b64encode(pdf.read_bytes()).decode("ascii")
        if pptx:
            result["pptxB64"] = base64.b64encode(pptx.read_bytes()).decode("ascii")
        if images:
            result["images"] = [
                {"name": image.name, "contentB64": base64.b64encode(image.read_bytes()).decode("ascii")}
                for image in images
            ]
        return result


def export_pptx_from_pdf(file_name: str, content_b64: str) -> Dict[str, Any]:
    if not content_b64:
        raise RuntimeError("PDF file content is empty")

    temp_dir = Path(tempfile.mkdtemp(prefix="paper2slides-export-"))
    try:
        safe_name = _sanitize_file_name(file_name or "slides.pdf", "slides.pdf")
        if not safe_name.lower().endswith(".pdf"):
            safe_name = f"{safe_name}.pdf"
        input_path = temp_dir / safe_name
        try:
            data = base64.b64decode(content_b64)
        except Exception as exc:
            raise RuntimeError("invalid base64 for pdf input") from exc
        input_path.write_bytes(data)

        output_path = temp_dir / "export.pptx"
        args = [sys.executable, "-m", "paper2slides.export_pptx", "--input", str(input_path), "--output", str(output_path)]
        _run_command(args, cwd=str(temp_dir))

        if not output_path.exists():
            raise RuntimeError("PPTX export did not produce an output file")
        return {"pptxB64": base64.b64encode(output_path.read_bytes()).decode("ascii")}
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

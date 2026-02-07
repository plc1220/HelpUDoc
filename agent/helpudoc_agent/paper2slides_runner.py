from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}


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
    style = options.get("style")
    if style:
        args += ["--style", style]
    length = options.get("length")
    if length:
        args += ["--length", length]
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


def _read_state_error(state_path: Path) -> Optional[str]:
    if not state_path.exists() or not state_path.is_file():
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


def _resolve_cache_root() -> Optional[Path]:
    explicit = (os.getenv("PAPER2SLIDES_CACHE_ROOT") or "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    workspace_root = (os.getenv("WORKSPACE_ROOT") or "").strip()
    if workspace_root:
        return (Path(workspace_root).expanduser().resolve() / ".paper2slides_cache").resolve()
    return None


def _compute_cache_key(decoded_files: List[Tuple[str, bytes]]) -> str:
    """Stable key based on sanitized filenames + bytes (sorted by name)."""
    hasher = hashlib.sha256()
    for name, data in sorted(decoded_files, key=lambda item: item[0]):
        hasher.update(name.encode("utf-8", errors="replace"))
        hasher.update(b"\0")
        hasher.update(data)
        hasher.update(b"\0")
    return hasher.hexdigest()[:32]


def _maybe_cleanup_cache(cache_root: Path, *, max_items: int, keep: Optional[set[Path]] = None) -> None:
    keep = keep or set()
    try:
        entries = [p for p in cache_root.iterdir() if p.is_dir()]
    except Exception:
        return
    if len(entries) <= max_items:
        return

    # Best-effort: delete oldest by mtime, but skip ones that appear locked/in-use.
    try:
        import fcntl  # POSIX only
    except Exception:
        fcntl = None  # type: ignore

    def mtime(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except Exception:
            return 0.0

    for candidate in sorted(entries, key=mtime):
        if len(entries) <= max_items:
            break
        if candidate in keep:
            continue
        lock_path = candidate / ".lock"
        if fcntl is not None and lock_path.exists():
            try:
                with open(lock_path, "a+") as fp:
                    try:
                        fcntl.flock(fp.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except OSError:
                        # Locked by another process.
                        continue
            except Exception:
                continue
        try:
            shutil.rmtree(candidate, ignore_errors=True)
        except Exception:
            continue
        try:
            entries.remove(candidate)
        except Exception:
            pass


class _FileLock:
    def __init__(self, path: Path):
        self.path = path
        self._fp = None
        self._fcntl = None

    def __enter__(self):
        try:
            import fcntl  # POSIX only
        except Exception:
            return self
        self._fcntl = fcntl
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fp = open(self.path, "a+")
        fcntl.flock(self._fp.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, exc_type, exc, tb):
        if self._fp is None or self._fcntl is None:
            return False
        try:
            self._fcntl.flock(self._fp.fileno(), self._fcntl.LOCK_UN)
        except Exception:
            pass
        try:
            self._fp.close()
        except Exception:
            pass
        self._fp = None
        self._fcntl = None
        return False


def _resolve_latest_run_outputs(
    *,
    outputs_root: Path,
    input_path: str,
    options: Dict[str, Any],
) -> Tuple[Optional[Path], Optional[Path], List[Path], Optional[str]]:
    """
    Resolve artifacts from the latest run output directory for this config,
    avoiding mixed artifacts when output history exists.
    """
    from paper2slides.utils.path_utils import get_project_name, parse_style
    from paper2slides.core.paths import get_base_dir, get_config_dir

    project_name = get_project_name(input_path)
    content_type = options.get("content") or "paper"
    output_type = options.get("output") or "slides"
    style_str = options.get("style") or "doraemon"  # matches CLI default
    length = options.get("length") or "short"  # matches CLI default
    fast_mode = options.get("mode") == "fast"

    style_type, custom_style = parse_style(style_str)
    config = {
        "input_path": input_path,
        "content_type": content_type,
        "output_type": output_type,
        "style": style_type,
        "custom_style": custom_style,
        "slides_length": length,
        "poster_density": "medium",
        "fast_mode": fast_mode,
    }

    base_dir = get_base_dir(str(outputs_root), project_name, content_type)
    config_dir = get_config_dir(base_dir, config)
    state_error = _read_state_error(config_dir / "state.json")

    # Find latest timestamp directory (YYYYMMDD_HHMMSS).
    latest_run_dir: Optional[Path] = None
    for entry in config_dir.iterdir() if config_dir.exists() else []:
        if not entry.is_dir():
            continue
        name = entry.name
        if len(name) != 15 or name[8] != "_":
            continue
        if not (name[:8].isdigit() and name[9:].isdigit()):
            continue
        if latest_run_dir is None or name > latest_run_dir.name:
            latest_run_dir = entry

    if latest_run_dir is None:
        return None, None, [], state_error

    # Collect only from latest run dir.
    images: List[Path] = []
    for ext in sorted(IMAGE_EXTENSIONS):
        images.extend(sorted(latest_run_dir.glob(f"*{ext}"), key=lambda p: p.name.lower()))

    pdf = (latest_run_dir / "slides.pdf") if (latest_run_dir / "slides.pdf").exists() else None
    pptx_preferred = latest_run_dir / "slides_editable.pptx"
    pptx_fallback = latest_run_dir / "slides.pptx"
    pptx = pptx_preferred if pptx_preferred.exists() else (pptx_fallback if pptx_fallback.exists() else None)
    return pdf, pptx, images, state_error


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


def run_paper2slides(files: Iterable[Dict[str, Any]], options: Dict[str, Any]) -> Dict[str, Any]:
    files = list(files)
    if not files:
        raise RuntimeError("No files provided for Paper2Slides")

    decoded: List[Tuple[str, bytes]] = []
    for index, payload in enumerate(files):
        decoded.append(_decode_file_payload(payload, f"input-{index}.bin"))

    cache_root = _resolve_cache_root()
    max_items_raw = (os.getenv("PAPER2SLIDES_CACHE_MAX_ITEMS") or "").strip()
    try:
        cache_max_items = int(max_items_raw) if max_items_raw else 100
    except Exception:
        cache_max_items = 100

    if cache_root is None:
        # Fallback: old temp behavior (no caching).
        temp_dir = Path(tempfile.mkdtemp(prefix="paper2slides-"))
        try:
            written_paths: List[Path] = []
            for name, data in decoded:
                target = temp_dir / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                written_paths.append(target)

            input_path = str(written_paths[0]) if len(written_paths) == 1 else str(temp_dir)
            outputs_root = temp_dir / "outputs"
            outputs_root.mkdir(parents=True, exist_ok=True)

            args = [sys.executable] + _build_command_args(input_path, options, str(outputs_root))
            _run_command(args, cwd=str(temp_dir))

            pdf, pptx, images, state_error = _resolve_latest_run_outputs(
                outputs_root=outputs_root, input_path=input_path, options=options
            )
            if state_error:
                raise RuntimeError(state_error)
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
    cache_key = _compute_cache_key(decoded)
    cache_dir = (cache_root / cache_key).resolve()
    inputs_dir = cache_dir / "inputs"
    outputs_root = cache_dir / "outputs"
    lock_path = cache_dir / ".lock"

    # Best-effort cleanup (skip our own cache dir).
    _maybe_cleanup_cache(cache_root, max_items=cache_max_items, keep={cache_dir})

    # Write inputs into cache (stable paths) and run under an exclusive lock.
    inputs_dir.mkdir(parents=True, exist_ok=True)
    written_paths: List[Path] = []
    for name, data in decoded:
        target = inputs_dir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        written_paths.append(target)

    input_path = str(written_paths[0]) if len(written_paths) == 1 else str(inputs_dir)
    outputs_root.mkdir(parents=True, exist_ok=True)

    args = [sys.executable] + _build_command_args(input_path, options, str(outputs_root))
    with _FileLock(lock_path):
        _run_command(args, cwd=str(cache_dir))

        pdf, pptx, images, state_error = _resolve_latest_run_outputs(
            outputs_root=outputs_root, input_path=input_path, options=options
        )
        if state_error:
            raise RuntimeError(state_error)
        if not pdf and not pptx and not images:
            raise RuntimeError("Paper2Slides finished but no outputs were found")

        result = {"images": []}
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

from __future__ import annotations

import base64
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


def run_paper2slides(files: Iterable[Dict[str, Any]], options: Dict[str, Any]) -> Dict[str, Any]:
    files = list(files)
    if not files:
        raise RuntimeError("No files provided for Paper2Slides")

    temp_dir = Path(tempfile.mkdtemp(prefix="paper2slides-"))
    try:
        written_paths: List[Path] = []
        for index, payload in enumerate(files):
            name, data = _decode_file_payload(payload, f"input-{index}.bin")
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

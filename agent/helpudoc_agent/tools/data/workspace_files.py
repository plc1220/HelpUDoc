"""Workspace scanning and artifact snapshot helpers."""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from .constants import ALLOWED_ARTIFACT_EXTENSIONS, WORKSPACE_SCAN_EXCLUDED_DIRS

logger = logging.getLogger(__name__)

def _workspace_rel(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()
def _should_skip_directory(name: str) -> bool:
    if name in WORKSPACE_SCAN_EXCLUDED_DIRS:
        return True
    return name.startswith(".")


def _iter_workspace_files(
    root: Path,
    *,
    allowed_extensions: Optional[Set[str]] = None,
    preferred_dirs: Tuple[str, ...] = (),
    include_root_recursive: bool = False,
) -> List[Path]:
    seen: Set[Path] = set()
    files: List[Path] = []

    def _append_file(path: Path) -> None:
        if allowed_extensions and path.suffix.lower() not in allowed_extensions:
            return
        resolved = path.resolve()
        if resolved in seen:
            return
        seen.add(resolved)
        files.append(path)

    for child in root.iterdir():
        if child.is_file():
            _append_file(child)

    preferred_roots: List[Path] = []
    for dirname in preferred_dirs:
        candidate = root / dirname
        if candidate.exists() and candidate.is_dir():
            preferred_roots.append(candidate)

    def _scan_recursive(base: Path) -> None:
        for current_root, dirnames, filenames in os.walk(base):
            current_path = Path(current_root)
            if current_path != base and _should_skip_directory(current_path.name):
                dirnames[:] = []
                continue
            dirnames[:] = [
                dirname for dirname in dirnames if not _should_skip_directory(dirname)
            ]
            for filename in filenames:
                _append_file(current_path / filename)

    for base in preferred_roots:
        _scan_recursive(base)
    if include_root_recursive or not preferred_roots:
        _scan_recursive(root)
    return files


def _snapshot_workspace(root: Path) -> Dict[str, Tuple[int, int]]:
    snapshot: Dict[str, Tuple[int, int]] = {}
    for path in _iter_workspace_files(
        root,
        allowed_extensions=set(ALLOWED_ARTIFACT_EXTENSIONS.keys()),
        preferred_dirs=("charts", "reports", "dashboards", "exports", "data_exports"),
        include_root_recursive=True,
    ):
        rel = path.relative_to(root).as_posix()
        try:
            stat = path.stat()
        except OSError:
            continue
        snapshot[rel] = (int(stat.st_mtime * 1e9), stat.st_size)
    return snapshot


def _detect_new_files(
    root: Path, before: Dict[str, Tuple[int, int]], after: Dict[str, Tuple[int, int]]
) -> List[Dict[str, Any]]:
    artifacts: List[Dict[str, Any]] = []
    for rel, meta in after.items():
        if rel in before:
            continue
        path = root / rel
        ext = path.suffix.lower()
        if ext not in ALLOWED_ARTIFACT_EXTENSIONS:
            continue
        mime = ALLOWED_ARTIFACT_EXTENSIONS[ext]
        artifacts.append(
            {
                "path": rel,
                "mimeType": mime,
                "size": meta[1],
            }
        )
    return artifacts


def _cleanup_new_files(
    root: Path,
    before: Dict[str, Tuple[int, int]],
    after: Dict[str, Tuple[int, int]],
) -> None:
    for rel in after:
        if rel in before:
            continue
        path = root / rel
        try:
            if path.exists():
                path.unlink()
        except OSError:
            logger.warning("Failed to clean up artifact %s", path, exc_info=True)


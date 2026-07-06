#!/usr/bin/env python3
# Copyright (c) OpenAI. All rights reserved.
"""Helpers for public container_tools scripts to resolve Codex runtime dependencies."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


def _exe_name(name: str) -> str:
    if os.name == "nt" and not name.lower().endswith(".exe"):
        return name + ".exe"
    return name


def _candidate_dependency_roots() -> list[Path]:
    roots: list[Path] = []
    for env_name in (
        "CODEX_RUNTIME_DEPENDENCIES",
        "CODEX_WORKSPACE_DEPENDENCIES",
        "CODEX_DEPENDENCIES",
    ):
        value = os.environ.get(env_name)
        if value:
            roots.append(Path(value).expanduser())

    executable = Path(sys.executable).resolve()
    for parent in executable.parents:
        if (parent / "node" / "bin" / _exe_name("node")).exists():
            roots.append(parent)
            break
        if (parent / "bin").exists() and (parent / "python").exists():
            roots.append(parent)
            break

    roots.append(
        Path.home() / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies"
    )

    seen: set[Path] = set()
    unique: list[Path] = []
    for root in roots:
        resolved = root.resolve()
        if resolved not in seen:
            unique.append(resolved)
            seen.add(resolved)
    return unique


def dependency_root() -> Path:
    for root in _candidate_dependency_roots():
        if root.exists():
            return root
    return _candidate_dependency_roots()[0]


def runtime_bin_dir() -> str:
    return str(dependency_root() / "bin")


def runtime_binary(name: str) -> str:
    exe_name = _exe_name(name)
    for root in _candidate_dependency_roots():
        candidates = [root / "bin" / exe_name]
        if name == "node":
            candidates.insert(0, root / "node" / "bin" / exe_name)
        for candidate in candidates:
            if candidate.exists():
                return str(candidate)
    return shutil.which(name) or name


def poppler_bin_dir() -> str | None:
    binaries = [Path(runtime_binary(name)) for name in ("pdfinfo", "pdftoppm")]
    if not all(binary.is_file() for binary in binaries):
        return None
    bin_dirs = {binary.resolve().parent for binary in binaries}
    return str(bin_dirs.pop()) if len(bin_dirs) == 1 else None


def node_binary() -> str:
    return runtime_binary("node")


def node_modules_dir() -> str:
    return str(dependency_root() / "node" / "node_modules")


def runtime_env() -> dict[str, str]:
    env = os.environ.copy()
    bin_dir = runtime_bin_dir()
    env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
    env.setdefault("NODE_PATH", node_modules_dir())
    return env

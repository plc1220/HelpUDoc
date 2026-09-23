"""Disposition of a skill's declared artifact pack at the start of a run.

A workspace directory is shared by everyone in the workspace and a skill writes
its pack to fixed paths -- `skills/research/SKILL.md` declares fifteen of them.
Nothing distinguished "the report this run wrote" from "the report that was
already there", so a run inherited an earlier run's pack as its own starting
state. A tester was shown a report on a subject she had never asked about.

The pack is never deleted. `file_versions` already keeps per-file history, so a
replaced report stays recoverable through normal version history; the archive
here exists only to stop the agent reading the previous pack as its own work.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import logging
from pathlib import Path
import shutil
from typing import Any, Dict, List

from .state import WorkspaceState

logger = logging.getLogger(__name__)

# Sits under `.system/`, which `isInternalWorkspacePath` already keeps out of the
# file browser, the artifact commit and the provenance trail, and which
# `SkillScopedFilesystemBackend` hides from the agent.
ARCHIVE_ROOT = ".system/archive"

PACK_DISPOSITION_KEY = "_artifact_pack_disposition"
PACK_ARCHIVED_KEY = "_artifact_pack_archived_for_run"

CONTINUE = "continue"
REPLACE = "replace"
VALID_DISPOSITIONS = (CONTINUE, REPLACE)


@dataclass(frozen=True)
class ExistingPack:
    paths: List[str]
    newest_mtime: str
    protected: List[str]

    @property
    def count(self) -> int:
        return len(self.paths)


def declared_pack_paths(context: Dict[str, Any] | None) -> List[str]:
    """Fixed paths the active skill declares as its output.

    `pattern:` entries are globs describing a shape rather than one file, so they
    name nothing to archive and are skipped.
    """
    policy = (context or {}).get("active_skill_policy") or {}
    if not isinstance(policy, dict) or not bool(policy.get("requires_workspace_artifacts")):
        return []
    paths: List[str] = []
    for raw in policy.get("required_artifacts") or []:
        item = str(raw or "").strip()
        if not item or item.startswith("pattern:"):
            continue
        paths.append(item.lstrip("/"))
    return paths


def detect_existing_pack(workspace_state: WorkspaceState) -> ExistingPack | None:
    """Which of the declared paths are already on disk, and how recent they are.

    Authorship is deliberately not reported. The agent has no access to the file
    records that hold it, and guessing an owner from the filesystem would be worse
    than saying nothing.
    """
    context = workspace_state.context if isinstance(workspace_state.context, dict) else {}
    declared = declared_pack_paths(context)
    if not declared:
        return None
    root = workspace_state.root_path
    protected_set = {
        str(item).strip().replace("\\", "/").lstrip("/")
        for item in (context.get("protected_file_paths") or [])
        if str(item).strip()
    }
    present: List[str] = []
    protected: List[str] = []
    newest_ns = 0
    for relative in declared:
        path = root / relative
        if not path.is_file():
            continue
        present.append(relative)
        if relative in protected_set:
            protected.append(relative)
        try:
            newest_ns = max(newest_ns, path.stat().st_mtime_ns)
        except OSError:
            continue
    if not present:
        return None
    newest = (
        datetime.fromtimestamp(newest_ns / 1_000_000_000, tz=timezone.utc)
        .strftime("%Y-%m-%d %H:%M UTC")
        if newest_ns
        else "unknown"
    )
    return ExistingPack(paths=present, newest_mtime=newest, protected=protected)


class ProtectedPackError(RuntimeError):
    """Raised when replacing a pack would move a signed-off file."""


def archive_existing_pack(workspace_state: WorkspaceState, run_id: str) -> List[str]:
    """Move the declared pack aside so this run starts from its own work.

    Refuses outright when any declared path is approved or published. Moving
    signed-off work is worse than refusing to start, so the caller surfaces that
    rather than silently working around it.
    """
    context = workspace_state.context if isinstance(workspace_state.context, dict) else {}
    pack = detect_existing_pack(workspace_state)
    if pack is None:
        return []
    if pack.protected:
        raise ProtectedPackError(
            "Cannot replace the existing artifact pack because these files are approved "
            f"or published: {', '.join(sorted(pack.protected))}."
        )
    root = workspace_state.root_path
    scope = str(run_id or "").strip() or "unscoped"
    destination_root = root / ARCHIVE_ROOT / scope
    moved: List[str] = []
    for relative in pack.paths:
        source = root / relative
        target = destination_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(source), str(target))
        except OSError:
            logger.exception("Failed to archive pack file %s", relative)
            continue
        moved.append(relative)
    context[PACK_ARCHIVED_KEY] = scope
    logger.info(
        "Archived existing artifact pack (workspace=%s run=%s files=%s)",
        workspace_state.workspace_id,
        scope,
        len(moved),
    )
    return moved


def set_pack_disposition(workspace_state: WorkspaceState, disposition: str) -> None:
    context = workspace_state.context
    if isinstance(context, dict):
        context[PACK_DISPOSITION_KEY] = disposition


def pack_disposition(context: Dict[str, Any] | None) -> str:
    return str((context or {}).get(PACK_DISPOSITION_KEY) or "").strip().lower()


def already_archived_for_run(context: Dict[str, Any] | None, run_id: str) -> bool:
    """A second `load_skill` in one run must not archive the run's own output."""
    scope = str(run_id or "").strip() or "unscoped"
    return str((context or {}).get(PACK_ARCHIVED_KEY) or "") == scope


def pack_notice_markdown(pack: ExistingPack, disposition: str) -> str:
    """The line the human reads on the approval card before deciding."""
    if disposition == REPLACE:
        outcome = (
            "This plan **replaces** it. The existing files are archived and stay "
            "recoverable from file version history."
        )
    else:
        outcome = "This plan **continues** it, building on the existing files."
    return (
        f"> **An existing artifact pack is already in this workspace** "
        f"({pack.count} file(s), last updated {pack.newest_mtime}). {outcome}\n\n"
    )

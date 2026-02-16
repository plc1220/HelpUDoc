"""Skill discovery and workspace syncing helpers."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List
import shutil
import yaml


@dataclass(frozen=True)
class SkillPolicy:
    requires_hitl_plan: bool = False
    requires_workspace_artifacts: bool = False
    required_artifacts_mode: str | None = None
    required_artifacts: List[str] | None = None


@dataclass(frozen=True)
class SkillMetadata:
    skill_id: str
    name: str
    description: str | None
    tools: List[str]
    policy: SkillPolicy
    path: Path


def _parse_frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    raw = parts[1].strip()
    if not raw:
        return {}
    data = yaml.safe_load(raw)
    return data if isinstance(data, dict) else {}


def _normalize_tools(value: object) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def _infer_skill_policy(skill_id: str, content: str, meta: dict) -> SkillPolicy:
    tools = _normalize_tools(meta.get("tools"))
    lower = content.lower()
    has_hitl_keyword = any(
        keyword in lower
        for keyword in (
            "request_plan_approval",
            "human approval",
            "approve, edit, or reject",
            "plan first",
            "before any research",
            "before execution",
        )
    )
    has_file_keyword = any(
        keyword in lower
        for keyword in (
            "write all report content to markdown files",
            "write_file",
            "workspace artifacts",
            "write the section file",
            "consolidate final report",
        )
    )
    requires_hitl_plan = has_hitl_keyword or ("request_plan_approval" in tools)
    requires_workspace_artifacts = has_file_keyword or ("write_file" in lower)

    required_artifacts_mode: str | None = None
    required_artifacts: List[str] | None = None
    if skill_id == "research":
        required_artifacts_mode = "full_pack"
        required_artifacts = [
            "/question.txt",
            "/research_plan.md",
            "/research_notes.md",
            "/knowledge_graph.md",
            "/synthesis.md",
            "/final-research-report.md",
            "pattern:/0[1-9]_*.md",
        ]
        requires_hitl_plan = True
        requires_workspace_artifacts = True
    elif requires_workspace_artifacts:
        required_artifacts_mode = "minimal"

    return SkillPolicy(
        requires_hitl_plan=requires_hitl_plan,
        requires_workspace_artifacts=requires_workspace_artifacts,
        required_artifacts_mode=required_artifacts_mode,
        required_artifacts=required_artifacts,
    )


def load_skills(skills_root: Path) -> List[SkillMetadata]:
    skills: List[SkillMetadata] = []
    if not skills_root.exists():
        return skills
    for entry in sorted(skills_root.iterdir()):
        if not entry.is_dir():
            continue
        skill_file = entry / "SKILL.md"
        if not skill_file.exists():
            continue
        try:
            content = skill_file.read_text(encoding="utf-8")
        except Exception:
            continue
        meta = _parse_frontmatter(content)
        skill_id = entry.name
        name = str(meta.get("name") or skill_id)
        description = meta.get("description")
        tools = _normalize_tools(meta.get("tools"))
        policy = _infer_skill_policy(skill_id, content, meta)
        skills.append(
            SkillMetadata(
                skill_id=skill_id,
                name=name,
                description=description,
                tools=tools,
                policy=policy,
                path=skill_file,
            )
        )
    return skills


def collect_tool_names(skills: Iterable[SkillMetadata]) -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []

    def _append(tool_name: str) -> None:
        if not tool_name or tool_name in seen:
            return
        seen.add(tool_name)
        ordered.append(tool_name)

    for skill in skills:
        for tool in skill.tools:
            _append(tool)
        if skill.policy.requires_hitl_plan:
            _append("request_plan_approval")
    return ordered


def sync_skills_to_workspace(skills_root: Path, workspace_root: Path) -> None:
    if not skills_root.exists():
        return
    dest = workspace_root / "skills"
    try:
        shutil.copytree(skills_root, dest, dirs_exist_ok=True)
    except Exception:
        return

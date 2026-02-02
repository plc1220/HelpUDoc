"""Skill discovery and workspace syncing helpers."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List
import shutil
import yaml


@dataclass(frozen=True)
class SkillMetadata:
    skill_id: str
    name: str
    description: str | None
    tools: List[str]
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
        skills.append(SkillMetadata(skill_id=skill_id, name=name, description=description, tools=tools, path=skill_file))
    return skills


def collect_tool_names(skills: Iterable[SkillMetadata]) -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []
    for skill in skills:
        for tool in skill.tools:
            if tool in seen:
                continue
            seen.add(tool)
            ordered.append(tool)
    return ordered


def sync_skills_to_workspace(skills_root: Path, workspace_root: Path) -> None:
    if not skills_root.exists():
        return
    dest = workspace_root / "skills"
    try:
        shutil.copytree(skills_root, dest, dirs_exist_ok=True)
    except Exception:
        return

"""Skill discovery and workspace syncing helpers."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, List
import shutil
import yaml


@dataclass(frozen=True)
class SkillPolicy:
    requires_hitl_plan: bool = False
    requires_workspace_artifacts: bool = False
    required_artifacts_mode: str | None = None
    required_artifacts: List[str] | None = None
    pre_plan_search_limit: int = 0


@dataclass(frozen=True)
class SkillMetadata:
    skill_id: str
    name: str
    description: str | None
    tools: List[str]
    mcp_servers: List[str]
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


def _normalize_optional_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "no", "n", "off"}:
            return False
    return None


def _infer_skill_policy(skill_id: str, content: str, meta: dict) -> SkillPolicy:
    tools = _normalize_tools(meta.get("tools"))
    lower = content.lower()
    explicit_requires_hitl_plan = _normalize_optional_bool(meta.get("requires_hitl_plan"))
    explicit_requires_workspace_artifacts = _normalize_optional_bool(meta.get("requires_workspace_artifacts"))
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
    requires_hitl_plan = (
        explicit_requires_hitl_plan
        if explicit_requires_hitl_plan is not None
        else has_hitl_keyword or ("request_plan_approval" in tools)
    )
    requires_workspace_artifacts = (
        explicit_requires_workspace_artifacts
        if explicit_requires_workspace_artifacts is not None
        else has_file_keyword or ("write_file" in lower)
    )
    raw_pre_plan_limit = meta.get("pre_plan_search_limit")
    pre_plan_search_limit = 0
    if isinstance(raw_pre_plan_limit, int):
        pre_plan_search_limit = max(0, raw_pre_plan_limit)
    elif isinstance(raw_pre_plan_limit, str):
        try:
            pre_plan_search_limit = max(0, int(raw_pre_plan_limit.strip()))
        except ValueError:
            pre_plan_search_limit = 0

    required_artifacts_mode: str | None = None
    required_artifacts: List[str] | None = None
    # Canonical skill id for policy matching (strip leading "data/" etc.)
    base_id = skill_id.split("/")[-1] if "/" in skill_id else skill_id
    if base_id == "research" or skill_id == "research":
        required_artifacts_mode = "full_pack"
        required_artifacts = [
            "/question.txt",
            "/preliminary_search_notes.md",
            "/research_plan.md",
            "/research_notes.md",
            "/knowledge_graph.md",
            "/synthesis.md",
            "/final-research-report.md",
            "pattern:/0[1-9]_*.md",
        ]
        requires_hitl_plan = True
        requires_workspace_artifacts = True
        pre_plan_search_limit = pre_plan_search_limit or 3
    elif requires_workspace_artifacts:
        required_artifacts_mode = "minimal"

    return SkillPolicy(
        requires_hitl_plan=requires_hitl_plan,
        requires_workspace_artifacts=requires_workspace_artifacts,
        required_artifacts_mode=required_artifacts_mode,
        required_artifacts=required_artifacts,
        pre_plan_search_limit=pre_plan_search_limit,
    )


def _skill_id_from_path(skills_root: Path, skill_dir: Path) -> str:
    """Return a POSIX-relative skill id such as 'data' or 'data/analyze'."""
    rel = skill_dir.relative_to(skills_root)
    return rel.as_posix()


def load_skills(skills_root: Path) -> List[SkillMetadata]:
    """Recursively discover all SKILL.md files under *skills_root*.

    Nested skills (e.g. ``skills/data/analyze/SKILL.md``) receive ids like
    ``data/analyze``.  Top-level skills continue to use their directory name.
    """
    skills: List[SkillMetadata] = []
    if not skills_root.exists():
        return skills

    # rglob finds every SKILL.md at any depth; sorted gives stable ordering.
    skill_files = sorted(skills_root.rglob("SKILL.md"))

    # Deduplicate by resolved path (symlinks) just in case.
    seen_paths: set[Path] = set()
    for skill_file in skill_files:
        resolved = skill_file.resolve()
        if resolved in seen_paths:
            continue
        seen_paths.add(resolved)

        skill_dir = skill_file.parent
        skill_id = _skill_id_from_path(skills_root, skill_dir)

        try:
            content = skill_file.read_text(encoding="utf-8")
        except Exception:
            continue

        meta = _parse_frontmatter(content)
        name = str(meta.get("name") or skill_id)
        description = meta.get("description")
        tools = _normalize_tools(meta.get("tools"))
        mcp_servers = _normalize_tools(meta.get("mcp_servers"))
        policy = _infer_skill_policy(skill_id, content, meta)
        skills.append(
            SkillMetadata(
                skill_id=skill_id,
                name=name,
                description=description,
                tools=tools,
                mcp_servers=mcp_servers,
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


# ---------------------------------------------------------------------------
# Runtime enforcement helpers
# ---------------------------------------------------------------------------

#: Tools that are always permitted regardless of the active skill's declared scope.
ALWAYS_ALLOWED_TOOLS: frozenset[str] = frozenset(
    {
        "list_skills",
        "load_skill",
        # Human-in-the-loop / clarification
        "request_plan_approval",
        "request_clarification",
        "request_human_action",
    }
)


def _coerce_active_skill_scope(active_skill: SkillMetadata | dict[str, Any] | None) -> SkillMetadata | None:
    if active_skill is None:
        return None
    if isinstance(active_skill, SkillMetadata):
        return active_skill
    if isinstance(active_skill, dict):
        raw_skill_id = str(active_skill.get("skill_id") or active_skill.get("id") or "").strip()
        tools = _normalize_tools(active_skill.get("tools"))
        mcp_servers = _normalize_tools(active_skill.get("mcp_servers"))
        if not raw_skill_id and not tools and not mcp_servers:
            return None
        return SkillMetadata(
            skill_id=raw_skill_id or "<active-skill>",
            name=str(active_skill.get("name") or raw_skill_id or "<active-skill>"),
            description=active_skill.get("description") if isinstance(active_skill.get("description"), str) else None,
            tools=tools,
            mcp_servers=mcp_servers,
            policy=SkillPolicy(),
            path=Path(str(active_skill.get("path") or ".")),
        )
    return None


def is_tool_allowed(
    tool_name: str,
    active_skill: SkillMetadata | dict[str, Any] | None,
    tool_mcp_server: str | None = None,
) -> bool:
    """Return True if *tool_name* is permitted given the *active_skill* scope.

    Rules (in priority order):
    1. Always-allowed tools are unconditionally permitted.
    2. If no skill is active, every tool is permitted.
    3. Built-in tools (``tool_mcp_server`` is None) are permitted only if
       declared in the skill's ``tools`` list.
    4. MCP tools are permitted only if their originating server name is declared
       in the skill's ``mcp_servers`` list.
    """
    if tool_name in ALWAYS_ALLOWED_TOOLS:
        return True
    active_skill = _coerce_active_skill_scope(active_skill)
    if active_skill is None:
        return True
    if tool_mcp_server is None:
        # Built-in tool – check tools list.
        return tool_name in active_skill.tools
    # MCP tool – check mcp_servers list.
    return tool_mcp_server in active_skill.mcp_servers


def sync_skills_to_workspace(skills_root: Path, workspace_root: Path) -> None:
    if not skills_root.exists():
        return
    dest = workspace_root / "skills"
    try:
        shutil.copytree(skills_root, dest, dirs_exist_ok=True)
    except Exception:
        return

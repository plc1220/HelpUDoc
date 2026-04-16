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


TOOL_FACTORY_EXPANSIONS: dict[str, tuple[str, ...]] = {
    "data_agent_tools": (
        "get_table_schema",
        "run_sql_query",
        "materialize_bigquery_to_parquet",
        "generate_chart_config",
        "generate_summary",
        "generate_dashboard",
    ),
}


SKILL_MCP_SERVER_ELIGIBILITY: dict[str, tuple[str, ...]] = {
    "proposal-writing": ("aws-pricing", "aws-knowledge"),
    "general": ("aws-pricing", "aws-knowledge"),
}


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


def _normalize_optional_string(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_string_list(value: object) -> List[str] | None:
    normalized = _normalize_tools(value)
    return normalized or None


def _infer_skill_policy(skill_id: str, content: str, meta: dict) -> SkillPolicy:
    tools = _normalize_tools(meta.get("tools"))
    lower = content.lower()
    explicit_requires_hitl_plan = _normalize_optional_bool(meta.get("requires_hitl_plan"))
    explicit_requires_workspace_artifacts = _normalize_optional_bool(meta.get("requires_workspace_artifacts"))
    explicit_required_artifacts_mode = _normalize_optional_string(meta.get("required_artifacts_mode"))
    explicit_required_artifacts = _normalize_string_list(meta.get("required_artifacts"))
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
        else bool(explicit_required_artifacts) or has_file_keyword or ("write_file" in lower)
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

    required_artifacts_mode = explicit_required_artifacts_mode
    required_artifacts = explicit_required_artifacts
    if requires_workspace_artifacts and not required_artifacts_mode:
        required_artifacts_mode = "strict" if required_artifacts else "minimal"

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


def find_skill(skills_root: Path | None, skill_id_or_name: str) -> SkillMetadata | None:
    if skills_root is None or not skills_root.exists():
        return None
    normalized = str(skill_id_or_name or "").strip()
    if not normalized:
        return None
    for skill in load_skills(skills_root):
        if normalized in {skill.skill_id, skill.name}:
            return skill
    return None


def expand_runtime_tool_names(tool_names: Iterable[str]) -> List[str]:
    seen: set[str] = set()
    expanded: List[str] = []
    for raw_tool_name in tool_names:
        tool_name = str(raw_tool_name or "").strip()
        if not tool_name:
            continue
        if tool_name not in seen:
            seen.add(tool_name)
            expanded.append(tool_name)
        for runtime_tool_name in TOOL_FACTORY_EXPANSIONS.get(tool_name, ()):
            if runtime_tool_name in seen:
                continue
            seen.add(runtime_tool_name)
            expanded.append(runtime_tool_name)
    return expanded


def activate_skill_context(context: dict[str, Any], skill: SkillMetadata) -> None:
    runtime_tools = expand_runtime_tool_names(skill.tools)
    allowed_mcp_servers = list(skill.mcp_servers)
    preferred_mcp_server = str(context.get("preferred_mcp_server") or "").strip()
    if preferred_mcp_server and preferred_mcp_server not in allowed_mcp_servers:
        allowed_mcp_servers.append(preferred_mcp_server)
    context["active_skill"] = skill.skill_id
    context["active_skill_scope"] = {
        "skill_id": skill.skill_id,
        "name": skill.name,
        "tools": runtime_tools,
        "declared_tools": list(skill.tools),
        "mcp_servers": allowed_mcp_servers,
    }
    context["active_skill_policy"] = {
        "requires_hitl_plan": skill.policy.requires_hitl_plan,
        "requires_workspace_artifacts": skill.policy.requires_workspace_artifacts,
        "required_artifacts_mode": skill.policy.required_artifacts_mode,
        "required_artifacts": skill.policy.required_artifacts or [],
        "pre_plan_search_limit": max(0, int(skill.policy.pre_plan_search_limit or 0)),
    }
    # Plan approval is per top-level task; a newly activated skill starts fresh unless
    # the workspace is explicitly configured to auto-approve plan reviews.
    context["plan_approved"] = bool(context.get("skip_plan_approvals"))
    context["pre_plan_search_count"] = 0


def read_skill_content(skill: SkillMetadata) -> str:
    return skill.path.read_text(encoding="utf-8")


def build_skill_policy_lines(skill: SkillMetadata) -> List[str]:
    declared_tools = list(skill.tools)
    runtime_tools = expand_runtime_tool_names(declared_tools)
    policy_lines = [
        f"Skill policy for {skill.skill_id}:",
        f"- requires_hitl_plan: {'true' if skill.policy.requires_hitl_plan else 'false'}",
        f"- requires_workspace_artifacts: {'true' if skill.policy.requires_workspace_artifacts else 'false'}",
        f"- tools: {', '.join(declared_tools) if declared_tools else '(none declared)'}",
    ]
    if runtime_tools != declared_tools:
        policy_lines.append(f"- resolved_tools: {', '.join(runtime_tools)}")
    policy_lines.append(
        f"- mcp_servers: {', '.join(skill.mcp_servers) if skill.mcp_servers else '(none declared)'}"
    )
    if skill.policy.requires_hitl_plan:
        policy_lines.append(
            "- You must call request_plan_approval before side-effecting execution."
        )
    else:
        policy_lines.append(
            "- Do not call request_plan_approval for this skill unless the user explicitly asks for a review gate."
        )
    return policy_lines


def build_loaded_skill_text(skill: SkillMetadata, content: str) -> str:
    policy_lines = build_skill_policy_lines(skill)
    return f"Loaded skill: {skill.skill_id}\n\n" + "\n".join(policy_lines) + f"\n\n{content}"


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


def is_skill_allowed(
    skill: SkillMetadata | str,
    context: dict[str, Any] | None,
) -> bool:
    if not isinstance(context, dict):
        return True
    mcp_policy = context.get("mcp_policy")
    if isinstance(mcp_policy, dict) and bool(mcp_policy.get("isAdmin", False)):
        return True
    allowed_skill_ids = context.get("skill_allow_ids")
    if not isinstance(allowed_skill_ids, list):
        return True
    normalized_allowed = {str(item).strip() for item in allowed_skill_ids if str(item).strip()}
    if not normalized_allowed:
        return False
    skill_id = skill.skill_id if isinstance(skill, SkillMetadata) else str(skill).strip()
    return skill_id in normalized_allowed


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
        # Empty tool allowlists are intentionally treated as unrestricted access
        # for backwards compatibility with older skills that omit `tools:`.
        if not active_skill.tools:
            return True
        return tool_name in active_skill.tools
    # Empty MCP allowlists are likewise unrestricted for skills that omit
    # `mcp_servers:` entirely.
    if not active_skill.mcp_servers:
        return True
    return tool_mcp_server in active_skill.mcp_servers


def get_candidate_mcp_servers(
    active_skill: SkillMetadata | dict[str, Any] | None,
    preferred_server: str | None = None,
) -> List[str]:
    """Return MCP servers eligible for binding for the active skill.

    This is intentionally narrower than runtime tool allowlisting. We only bind
    MCP servers for explicitly approved skills to keep Gemini-facing schemas
    small and reduce whole-run failures from incompatible MCP tool definitions.
    """
    candidates: List[str] = []
    resolved_skill = _coerce_active_skill_scope(active_skill)
    if resolved_skill is not None:
        candidates.extend(SKILL_MCP_SERVER_ELIGIBILITY.get(resolved_skill.skill_id, ()))
    normalized_preferred = str(preferred_server or "").strip()
    if normalized_preferred and normalized_preferred not in candidates:
        candidates.append(normalized_preferred)
    return candidates


def sync_skills_to_workspace(skills_root: Path, workspace_root: Path) -> None:
    if not skills_root.exists():
        return
    dest = workspace_root / "skills"
    try:
        shutil.copytree(skills_root, dest, dirs_exist_ok=True)
    except Exception:
        return

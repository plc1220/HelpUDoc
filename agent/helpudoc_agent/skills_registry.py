"""Skill discovery and workspace syncing helpers."""
from __future__ import annotations

from dataclasses import dataclass, field
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
    sandbox_scripts: List["SkillSandboxScript"] = field(default_factory=list)
    interaction_contract: dict[str, Any] | None = None
    plugin_id: str | None = None
    inherits_plugin_defaults: bool = False


@dataclass(frozen=True)
class SkillSandboxScript:
    name: str
    path: str
    sha256: str
    timeout_seconds: int = 120
    outputs: List[str] = field(default_factory=list)
    source_dir: Path | None = field(default=None, compare=False, repr=False)


@dataclass(frozen=True)
class PluginExecution:
    mode: str = "scope_bundle"


@dataclass(frozen=True)
class PluginMetadata:
    plugin_id: str
    display_name: str
    description: str | None
    default_skill: str | None
    skills: List[str]
    default_tools: List[str]
    default_mcp_servers: List[str]
    default_sandbox_scripts: List["SkillSandboxScript"]
    execution: PluginExecution
    path: Path
    valid: bool = True
    errors: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class ResolvedSkillScope:
    skill_id: str
    name: str
    plugin_id: str | None
    plugin_name: str | None
    declared_tools: List[str]
    runtime_tools: List[str]
    mcp_servers: List[str]
    sandbox_scripts: List["SkillSandboxScript"]
    interaction_contract: dict[str, Any] | None


TOOL_FACTORY_EXPANSIONS: dict[str, tuple[str, ...]] = {}


SKILL_MCP_SERVER_ELIGIBILITY: dict[str, tuple[str, ...]] = {
    "proposal-writing": (
        "aws-pricing",
        "aws-knowledge",
        "google-developer-knowledge",
        "gcp-cost",
    ),
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


def _dedupe_ordered(values: Iterable[str]) -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []
    for raw in values:
        value = str(raw or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def _normalize_sandbox_scripts(
    value: object,
    *,
    source_dir: Path | None = None,
) -> List[SkillSandboxScript]:
    if not isinstance(value, list):
        return []
    scripts: List[SkillSandboxScript] = []
    for raw in value:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        path = str(raw.get("path") or "").strip()
        sha256 = str(raw.get("sha256") or "").strip().lower()
        if not name or not path or not sha256:
            continue
        raw_timeout = raw.get("timeout_seconds", 120)
        try:
            timeout_seconds = int(raw_timeout)
        except (TypeError, ValueError):
            timeout_seconds = 120
        timeout_seconds = min(3600, max(1, timeout_seconds))
        outputs = _normalize_tools(raw.get("outputs"))
        scripts.append(
            SkillSandboxScript(
                name=name,
                path=path,
                sha256=sha256,
                timeout_seconds=timeout_seconds,
                outputs=outputs,
                source_dir=source_dir.resolve() if source_dir is not None else None,
            )
        )
    return scripts


def _normalize_interaction_contract(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    raw_gates = value.get("gates")
    if not isinstance(raw_gates, list):
        return None
    gates: list[dict[str, Any]] = []
    for raw_gate in raw_gates:
        if not isinstance(raw_gate, dict):
            continue
        gate_id = str(raw_gate.get("gate_id") or raw_gate.get("gateId") or raw_gate.get("id") or "").strip()
        component = str(raw_gate.get("component") or "").strip()
        if not gate_id or not component:
            continue
        gate = dict(raw_gate)
        gate["gate_id"] = gate_id
        gate["component"] = component
        gate["required"] = bool(raw_gate.get("required", True))
        gates.append(gate)
    return {"gates": gates} if gates else None


def _load_interaction_contract(skill_dir: Path, meta: dict) -> dict[str, Any] | None:
    inline = _normalize_interaction_contract(meta.get("interaction_contract") or meta.get("a2ui_contract"))
    if inline is not None:
        return inline
    for filename in ("interaction_contract.yaml", "interaction_contract.yml", "a2ui_contract.yaml", "a2ui_contract.yml"):
        path = skill_dir / filename
        if not path.exists():
            continue
        try:
            loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        normalized = _normalize_interaction_contract(loaded)
        if normalized is not None:
            return normalized
    return None


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


def _load_plugin_manifest(path: Path) -> PluginMetadata:
    errors: List[str] = []
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return PluginMetadata(
            plugin_id=path.parent.name,
            display_name=path.parent.name,
            description=None,
            default_skill=None,
            skills=[],
            default_tools=[],
            default_mcp_servers=[],
            default_sandbox_scripts=[],
            execution=PluginExecution(),
            path=path,
            valid=False,
            errors=[f"Failed to read plugin manifest: {exc}"],
        )
    data = raw if isinstance(raw, dict) else {}
    plugin_id = str(data.get("id") or path.parent.name).strip()
    if not plugin_id:
        plugin_id = path.parent.name
        errors.append("Plugin id is missing.")
    display_name = str(data.get("display_name") or data.get("displayName") or plugin_id).strip() or plugin_id
    description = data.get("description") if isinstance(data.get("description"), str) else None
    default_skill = _normalize_optional_string(data.get("default_skill") or data.get("defaultSkill"))
    skills = _normalize_tools(data.get("skills"))
    default_tools = _normalize_tools(data.get("default_tools") or data.get("defaultTools"))
    default_mcp_servers = _normalize_tools(data.get("default_mcp_servers") or data.get("defaultMcpServers"))
    default_sandbox_scripts = _normalize_sandbox_scripts(
        data.get("default_sandbox_scripts") or data.get("defaultSandboxScripts"),
        source_dir=path.parent,
    )
    execution_payload = data.get("execution") if isinstance(data.get("execution"), dict) else {}
    execution_mode = str(execution_payload.get("mode") or "scope_bundle").strip() or "scope_bundle"
    if execution_mode != "scope_bundle":
        errors.append(f"Unsupported execution mode for v1: {execution_mode}")
    if default_skill and default_skill not in skills:
        errors.append(f"default_skill '{default_skill}' is not listed in skills.")
    return PluginMetadata(
        plugin_id=plugin_id,
        display_name=display_name,
        description=description,
        default_skill=default_skill,
        skills=skills,
        default_tools=default_tools,
        default_mcp_servers=default_mcp_servers,
        default_sandbox_scripts=default_sandbox_scripts,
        execution=PluginExecution(mode=execution_mode),
        path=path,
        valid=not errors,
        errors=errors,
    )


def load_plugins(plugins_root: Path | None, skills: Iterable[SkillMetadata] | None = None) -> List[PluginMetadata]:
    """Discover plugin manifests from *plugins_root*.

    A plugin is a capability bundle over existing skills; v1 does not move or
    rename skills. Invalid manifests are returned with validation errors so
    admin surfaces can show actionable status.
    """
    if plugins_root is None or not plugins_root.exists():
        return []
    manifests: List[Path] = []
    for filename in ("plugin.yaml", "plugin.yml"):
        manifests.extend(sorted(plugins_root.glob(f"*/{filename}")))
    seen: set[Path] = set()
    skill_ids = {skill.skill_id for skill in skills or []}
    plugins: List[PluginMetadata] = []
    for manifest in sorted(manifests):
        resolved = manifest.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        plugin = _load_plugin_manifest(manifest)
        errors = list(plugin.errors)
        if skill_ids:
            for skill_id in plugin.skills:
                if skill_id not in skill_ids:
                    errors.append(f"Referenced skill '{skill_id}' was not found.")
        if errors != plugin.errors:
            plugin = PluginMetadata(
                plugin_id=plugin.plugin_id,
                display_name=plugin.display_name,
                description=plugin.description,
                default_skill=plugin.default_skill,
                skills=plugin.skills,
                default_tools=plugin.default_tools,
                default_mcp_servers=plugin.default_mcp_servers,
                default_sandbox_scripts=plugin.default_sandbox_scripts,
                execution=plugin.execution,
                path=plugin.path,
                valid=False,
                errors=errors,
            )
        plugins.append(plugin)
    return plugins


def find_plugin_for_skill(
    skill: SkillMetadata,
    plugins_root: Path | None = None,
    plugins: Iterable[PluginMetadata] | None = None,
) -> PluginMetadata | None:
    loaded = list(plugins) if plugins is not None else load_plugins(plugins_root)
    if not loaded:
        return None
    if skill.plugin_id:
        for plugin in loaded:
            if plugin.plugin_id == skill.plugin_id:
                return plugin
    for plugin in loaded:
        if skill.skill_id in plugin.skills:
            return plugin
    return None


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
        plugin_id = _normalize_optional_string(meta.get("plugin") or meta.get("plugin_id") or meta.get("pluginId"))
        inherits_plugin_defaults = bool(_normalize_optional_bool(meta.get("inherits_plugin_defaults") or meta.get("inheritsPluginDefaults")))
        sandbox_scripts = _normalize_sandbox_scripts(meta.get("sandbox_scripts"), source_dir=skill_dir)
        interaction_contract = _load_interaction_contract(skill_dir, meta)
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
                sandbox_scripts=sandbox_scripts,
                interaction_contract=interaction_contract,
                plugin_id=plugin_id,
                inherits_plugin_defaults=inherits_plugin_defaults,
            )
        )
    return skills


def resolve_skill_scope(
    skill: SkillMetadata,
    plugins_root: Path | None = None,
    plugins: Iterable[PluginMetadata] | None = None,
) -> ResolvedSkillScope:
    plugin = find_plugin_for_skill(skill, plugins_root=plugins_root, plugins=plugins)
    inherited_tools: List[str] = []
    inherited_mcp_servers: List[str] = []
    inherited_sandbox_scripts: List[SkillSandboxScript] = []
    if plugin is not None and skill.inherits_plugin_defaults:
        inherited_tools = list(plugin.default_tools)
        inherited_mcp_servers = list(plugin.default_mcp_servers)
        inherited_sandbox_scripts = list(plugin.default_sandbox_scripts)
    declared_tools = _dedupe_ordered([*inherited_tools, *skill.tools])
    runtime_tools = expand_runtime_tool_names(declared_tools)
    mcp_servers = _dedupe_ordered([*inherited_mcp_servers, *skill.mcp_servers])
    sandbox_scripts_by_name: dict[str, SkillSandboxScript] = {}
    for script in [*inherited_sandbox_scripts, *skill.sandbox_scripts]:
        if script.name:
            sandbox_scripts_by_name[script.name] = script
    return ResolvedSkillScope(
        skill_id=skill.skill_id,
        name=skill.name,
        plugin_id=plugin.plugin_id if plugin else skill.plugin_id,
        plugin_name=plugin.display_name if plugin else None,
        declared_tools=declared_tools,
        runtime_tools=runtime_tools,
        mcp_servers=mcp_servers,
        sandbox_scripts=list(sandbox_scripts_by_name.values()),
        interaction_contract=skill.interaction_contract,
    )


def collect_tool_names(
    skills: Iterable[SkillMetadata],
    plugins_root: Path | None = None,
    plugins: Iterable[PluginMetadata] | None = None,
) -> List[str]:
    skill_list = list(skills)
    plugin_list = list(plugins) if plugins is not None else load_plugins(plugins_root, skill_list)
    seen: set[str] = set()
    ordered: List[str] = []

    def _append(tool_name: str) -> None:
        if not tool_name or tool_name in seen:
            return
        seen.add(tool_name)
        ordered.append(tool_name)

    for skill in skill_list:
        scope = resolve_skill_scope(skill, plugins=plugin_list)
        for tool in scope.declared_tools:
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
    candidates = {normalized}
    if normalized.endswith("-slide"):
        candidates.add(f"{normalized}s")
    if normalized.endswith("/slide"):
        candidates.add(f"{normalized}s")
    for skill in load_skills(skills_root):
        if candidates.intersection({skill.skill_id, skill.name}):
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


def activate_skill_context(
    context: dict[str, Any],
    skill: SkillMetadata,
    plugins_root: Path | None = None,
    plugins: Iterable[PluginMetadata] | None = None,
) -> None:
    scope = resolve_skill_scope(skill, plugins_root=plugins_root, plugins=plugins)
    runtime_tools = list(scope.runtime_tools)
    allowed_mcp_servers = list(scope.mcp_servers)
    preferred_mcp_server = str(context.get("preferred_mcp_server") or "").strip()
    if preferred_mcp_server and preferred_mcp_server not in allowed_mcp_servers:
        allowed_mcp_servers.append(preferred_mcp_server)
    context["active_skill"] = skill.skill_id
    context["active_skill_scope"] = {
        "skill_id": skill.skill_id,
        "name": skill.name,
        "plugin_id": scope.plugin_id,
        "plugin_name": scope.plugin_name,
        "tools": runtime_tools,
        "declared_tools": list(scope.declared_tools),
        "skill_declared_tools": list(skill.tools),
        "mcp_servers": allowed_mcp_servers,
        "sandbox_scripts": [
            {
                "name": script.name,
                "path": script.path,
                "sha256": script.sha256,
                "timeout_seconds": script.timeout_seconds,
                "outputs": list(script.outputs),
            }
            for script in scope.sandbox_scripts
        ],
    }
    if scope.interaction_contract:
        context["active_skill_scope"]["interaction_contract"] = scope.interaction_contract
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


_LEARNINGS_FILENAME = "HELPUDOC_LEARNINGS.md"


def helpudoc_learnings_path(skill: SkillMetadata) -> Path:
    return skill.path.parent / "docs" / _LEARNINGS_FILENAME


def read_helpudoc_learnings(skill: SkillMetadata) -> str | None:
    path = helpudoc_learnings_path(skill)
    try:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    except Exception:
        return None
    return None


def routing_hint_from_learnings(text: str | None, max_len: int = 220) -> str | None:
    if not text or not str(text).strip():
        return None
    lines = [ln.strip() for ln in str(text).splitlines()]
    lines = [ln for ln in lines if ln and not ln.startswith("#")]
    if not lines:
        return None
    snippet = " ".join(lines[:4])[:max_len].strip()
    return snippet or None


def build_skill_policy_lines(
    skill: SkillMetadata,
    plugins_root: Path | None = None,
    plugins: Iterable[PluginMetadata] | None = None,
) -> List[str]:
    scope = resolve_skill_scope(skill, plugins_root=plugins_root, plugins=plugins)
    declared_tools = list(scope.declared_tools)
    runtime_tools = list(scope.runtime_tools)
    policy_lines = [
        f"Skill policy for {skill.skill_id}:",
        f"- requires_hitl_plan: {'true' if skill.policy.requires_hitl_plan else 'false'}",
        f"- requires_workspace_artifacts: {'true' if skill.policy.requires_workspace_artifacts else 'false'}",
        f"- tools: {', '.join(declared_tools) if declared_tools else '(none declared)'}",
    ]
    if scope.plugin_id:
        policy_lines.append(f"- plugin: {scope.plugin_id}")
    if runtime_tools != declared_tools:
        policy_lines.append(f"- resolved_tools: {', '.join(runtime_tools)}")
    policy_lines.append(
        f"- mcp_servers: {', '.join(scope.mcp_servers) if scope.mcp_servers else '(none declared)'}"
    )
    if scope.sandbox_scripts:
        policy_lines.append(
            "- sandbox_scripts: "
            + ", ".join(script.name for script in scope.sandbox_scripts)
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


def build_loaded_skill_text(
    skill: SkillMetadata,
    content: str,
    plugins_root: Path | None = None,
    plugins: Iterable[PluginMetadata] | None = None,
) -> str:
    policy_lines = build_skill_policy_lines(skill, plugins_root=plugins_root, plugins=plugins)
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
        "request_ui",
        "workflow_action",
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
            interaction_contract=active_skill.get("interaction_contract")
            if isinstance(active_skill.get("interaction_contract"), dict)
            else None,
            plugin_id=str(active_skill.get("plugin_id") or "").strip() or None,
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
        if tool_name == "run_skill_python_script":
            return tool_name in active_skill.tools
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
        candidates.extend(resolved_skill.mcp_servers)
        if not candidates:
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

"""Skill listing, loading, and sandbox script execution tools."""
from __future__ import annotations

from typing import List, Optional

from langchain_core.tools import Tool, tool

from ....configuration import Settings
from ....sandbox_runner import (
    SandboxExecutionError,
    SandboxUnavailableError,
    run_skill_python_script_in_kubernetes,
)
from ....skills_registry import (
    activate_skill_context,
    build_loaded_skill_text,
    find_skill,
    is_skill_allowed,
    load_skills,
    read_helpudoc_learnings,
    read_skill_content,
    routing_hint_from_learnings,
)
from ....state import WorkspaceState
from ....tagged_file_policy import tagged_files_mode_guard
from ..constants import MAX_DISTINCT_SKILLS_PER_TURN, MAX_SKILL_LOAD_ATTEMPTS_PER_TURN


def build_list_skills_tool(settings: Settings, workspace_state: WorkspaceState) -> Tool:
    skills_root = settings.backend.skills_root

    @tool
    def list_skills() -> str:
        """List available skills and their descriptions."""
        blocked = tagged_files_mode_guard(workspace_state.context, "list_skills")
        if blocked:
            return blocked
        if skills_root is None or not skills_root.exists():
            return "No skills directory configured."
        skills = [skill for skill in load_skills(skills_root) if is_skill_allowed(skill, workspace_state.context)]
        if not skills:
            return "No skills found."
        lines = []
        for skill in skills:
            parts: List[str] = []
            if skill.description:
                parts.append(str(skill.description).strip())
            hint = routing_hint_from_learnings(read_helpudoc_learnings(skill))
            if hint:
                parts.append(f"routing hint: {hint}")
            detail = f": {' | '.join(parts)}" if parts else ""
            lines.append(f"- {skill.skill_id}{detail}")
        return "Available skills:\n" + "\n".join(lines)

    list_skills.name = "list_skills"
    list_skills.description = "List available skills and their descriptions."
    return list_skills


def build_load_skill_tool(settings: Settings, workspace_state: WorkspaceState) -> Tool:
    skills_root = settings.backend.skills_root

    @tool
    def load_skill(skill_id: str) -> str:
        """Load the full content of a skill by id or name."""
        blocked = tagged_files_mode_guard(workspace_state.context, "load_skill")
        if blocked:
            return blocked
        if skills_root is None or not skills_root.exists():
            return "No skills directory configured."
        skills = [skill for skill in load_skills(skills_root) if is_skill_allowed(skill, workspace_state.context)]
        if not skills:
            return "No skills found."
        normalized = skill_id.strip()
        skill = find_skill(skills_root, normalized)
        if skill is None:
            available = ", ".join(sorted({s.skill_id for s in skills}))
            return f"Skill '{normalized}' not found. Available skills: {available}"

        if not is_skill_allowed(skill, workspace_state.context):
            return f"Skill '{skill.skill_id}' is not allowed for this user."

        attempts = int(workspace_state.context.get("skill_load_attempts_this_turn") or 0) + 1
        workspace_state.context["skill_load_attempts_this_turn"] = attempts
        if attempts > MAX_SKILL_LOAD_ATTEMPTS_PER_TURN:
            return (
                "Skill load limit reached for this user turn. "
                "Stop loading skills and either use the active skill's tools or ask for clarification."
            )

        loaded = workspace_state.context.get("loaded_skill_ids_this_turn")
        loaded_ids = [str(item).strip() for item in loaded] if isinstance(loaded, list) else []
        if skill.skill_id not in loaded_ids:
            if len(loaded_ids) >= MAX_DISTINCT_SKILLS_PER_TURN:
                return (
                    "Skill switch limit reached for this user turn. "
                    f"Already loaded: {', '.join(loaded_ids)}. "
                    "Continue with the active skill or ask for clarification."
                )
            loaded_ids.append(skill.skill_id)
            workspace_state.context["loaded_skill_ids_this_turn"] = loaded_ids

        try:
            content = read_skill_content(skill)
        except Exception as exc:  # pragma: no cover - filesystem guard
            return f"Failed to read skill '{skill.skill_id}': {exc}"
        learnings = read_helpudoc_learnings(skill)
        if learnings and learnings.strip():
            content = (
                f"{content.rstrip()}\n\n---\n\n## HelpUDoc approved learnings (docs/HELPUDOC_LEARNINGS.md)\n\n"
                f"{learnings.strip()}\n"
            )
        activate_skill_context(workspace_state.context, skill)
        return build_loaded_skill_text(skill, content)

    load_skill.name = "load_skill"
    load_skill.description = "Load the full content of a skill by id or name."
    return load_skill


def build_run_skill_python_script_tool(settings: Settings, workspace_state: WorkspaceState) -> Tool:
    skills_root = settings.backend.skills_root

    @tool
    def run_skill_python_script(
        script_name: str,
        input_paths: Optional[List[str]] = None,
        args: Optional[List[str]] = None,
    ) -> str:
        """Run a declared Python script from the active skill inside a Kubernetes sandbox."""
        blocked = tagged_files_mode_guard(workspace_state.context, "run_skill_python_script")
        if blocked:
            return blocked
        try:
            result = run_skill_python_script_in_kubernetes(
                skills_root=skills_root,
                workspace_state=workspace_state,
                script_name=script_name,
                input_paths=input_paths or [],
                args=args or [],
            )
        except SandboxUnavailableError as exc:
            return str(exc)
        except SandboxExecutionError as exc:
            return f"Skill sandbox execution blocked: {exc}"

        lines = [
            "SKILL_SANDBOX_RUN_COMPLETED",
            f"Run ID: {result.run_id}",
            f"Job: {result.job_name}",
        ]
        if result.output_files:
            lines.append("Output files:")
            lines.extend(f"- {item.path} ({item.size} bytes)" for item in result.output_files)
        else:
            lines.append("Output files: (none declared or produced)")
        if result.stdout:
            lines.append("STDOUT:")
            lines.append(result.stdout[:8000])
        if result.stderr:
            lines.append("STDERR:")
            lines.append(result.stderr[:4000])
        return "\n".join(lines)

    run_skill_python_script.name = "run_skill_python_script"
    run_skill_python_script.description = (
        "Run a Python script declared in the active skill's sandbox_scripts frontmatter. "
        "Scripts execute in a Kubernetes Job sandbox; pass input_paths as workspace files and args as argv."
    )
    return run_skill_python_script

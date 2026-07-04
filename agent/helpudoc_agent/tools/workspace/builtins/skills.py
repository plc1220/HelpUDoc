"""Skill listing, loading, and sandbox script execution tools."""
from __future__ import annotations

import json
from typing import List, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import Tool, tool
from pydantic import BaseModel, Field

from ....configuration import Settings
from ....sandbox_runner import (
    SandboxExecutionError,
    SandboxUnavailableError,
    run_skill_python_script as run_declared_skill_python_script,
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

MAX_SKILL_ASSET_MANIFEST_ITEMS = 40


def _skill_asset_backend_paths(skill) -> list[str]:
    skill_dir = skill.path.parent.resolve()
    paths: list[str] = []
    for path in sorted(skill_dir.rglob("*")):
        if (
            not path.is_file()
            or path.name == "SKILL.md"
            or "__pycache__" in path.parts
            or ".git" in path.parts
            or path.name == ".DS_Store"
        ):
            continue
        try:
            rel = path.resolve().relative_to(skill_dir).as_posix()
        except ValueError:
            continue
        paths.append(f"/skills/{skill.skill_id}/{rel}")
    return paths


def _format_skill_asset_manifest(skill_id: str, asset_paths: list[str]) -> str:
    if not asset_paths:
        return ""
    shown = asset_paths[:MAX_SKILL_ASSET_MANIFEST_ITEMS]
    lines = [
        "---",
        "",
        "## Local Skill Asset Files",
        "",
        (
            "Bundled asset files for this skill are available through the skill backend. "
            "When the skill instructions reference a relative support file, read the corresponding "
            "path below with read_file. Do not use web search to fetch these bundled assets."
        ),
        "",
    ]
    lines.extend(f"- {path}" for path in shown)
    if len(asset_paths) > len(shown):
        lines.append(f"- ... {len(asset_paths) - len(shown)} more files under /skills/{skill_id}/")
    return "\n".join(lines)


class RunSkillPythonScriptInput(BaseModel):
    script_name: str = Field(description="Declared sandbox script name from the active skill.")
    input_paths: Optional[List[str]] = Field(
        default=None,
        description="Workspace file paths to stage into the sandbox.",
    )
    args: Optional[List[str]] = Field(
        default=None,
        description="Command-line arguments to pass to the script.",
    )


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
    plugins_root = getattr(settings.backend, "plugins_root", None)

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
        activate_skill_context(workspace_state.context, skill, plugins_root=plugins_root)
        asset_paths = _skill_asset_backend_paths(skill)
        asset_manifest = _format_skill_asset_manifest(skill.skill_id, asset_paths)
        if asset_manifest:
            content = f"{content.rstrip()}\n\n{asset_manifest}\n"
        return build_loaded_skill_text(skill, content, plugins_root=plugins_root)

    load_skill.name = "load_skill"
    load_skill.description = "Load the full content of a skill by id or name."
    return load_skill


def build_run_skill_python_script_tool(settings: Settings, workspace_state: WorkspaceState) -> Tool:
    skills_root = settings.backend.skills_root
    plugins_root = getattr(settings.backend, "plugins_root", None)

    def _read_output_payload(result_path: str) -> object | None:
        rel = str(result_path or "").strip().replace("\\", "/").lstrip("/")
        if not rel:
            return None
        candidate = (workspace_state.root_path / rel).resolve()
        root = workspace_state.root_path.resolve()
        if candidate != root and root not in candidate.parents:
            return None
        if not candidate.is_file():
            return None
        try:
            return json.loads(candidate.read_text(encoding="utf-8"))
        except Exception:
            return None

    def _emit_script_events(result, callbacks: Optional[CallbackManagerForToolRun]) -> None:
        if callbacks is None:
            return
        output_paths = {item.path for item in result.output_files}
        run_prefix = f"/sandbox-runs/{result.run_id}/"
        tool_payload = None
        dashboard_payload = None
        for output_path in output_paths:
            if output_path == f"{run_prefix}out/tool_artifacts.json":
                tool_payload = _read_output_payload(output_path)
            elif output_path == f"{run_prefix}out/dashboard_artifacts.json":
                dashboard_payload = _read_output_payload(output_path)
        try:
            run_id = getattr(callbacks, "run_id", None)
            if isinstance(tool_payload, dict):
                if run_id is not None:
                    callbacks.on_custom_event("tool_artifacts", tool_payload, run_id=run_id)
                else:
                    callbacks.on_custom_event("tool_artifacts", tool_payload)
            dashboard_events = []
            if isinstance(dashboard_payload, list):
                dashboard_events = [item for item in dashboard_payload if isinstance(item, dict)]
            elif isinstance(dashboard_payload, dict):
                raw_events = dashboard_payload.get("dashboardArtifacts")
                if isinstance(raw_events, list):
                    dashboard_events = [item for item in raw_events if isinstance(item, dict)]
                else:
                    dashboard_events = [dashboard_payload]
            for event in dashboard_events:
                event.setdefault("workspaceId", workspace_state.workspace_id)
                if run_id is not None:
                    callbacks.on_custom_event("dashboard_artifact", event, run_id=run_id)
                else:
                    callbacks.on_custom_event("dashboard_artifact", event)
        except Exception:
            return

    @tool(args_schema=RunSkillPythonScriptInput)
    def run_skill_python_script(
        script_name: str,
        input_paths: Optional[List[str]] = None,
        args: Optional[List[str]] = None,
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Run a declared Python script from the active skill inside the configured sandbox."""
        blocked = tagged_files_mode_guard(workspace_state.context, "run_skill_python_script")
        if blocked:
            return blocked
        try:
            result = run_declared_skill_python_script(
                skills_root=skills_root,
                plugins_root=plugins_root,
                workspace_state=workspace_state,
                script_name=script_name,
                input_paths=input_paths or [],
                args=args or [],
            )
        except SandboxUnavailableError as exc:
            return str(exc)
        except SandboxExecutionError as exc:
            return f"Skill sandbox execution blocked: {exc}"
        _emit_script_events(result, callbacks)

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
        "Scripts execute in the configured local or Kubernetes sandbox; pass input_paths as workspace files and args as argv."
    )
    return run_skill_python_script

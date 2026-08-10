"""Skill listing, loading, and sandbox script execution tools."""
from __future__ import annotations

import json
from pathlib import PurePosixPath
from typing import List, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import Tool, tool
from pydantic import BaseModel, Field

from ....configuration import Settings
from ....sandbox_runner import (
    SandboxExecutionError,
    SandboxUnavailableError,
    run_inline_python as run_inline_skill_python,
    run_skill_python_script as run_declared_skill_python_script,
)
from ....skills_registry import (
    activate_skill_context,
    build_loaded_skill_text,
    find_skill_for_context,
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
MAX_DATA_WORKSPACE_QUERIES_PER_TURN = 10


def _data_workspace_action(args: List[str]) -> str:
    raw = ""
    if "--request-json" in args:
        index = args.index("--request-json") + 1
        if index < len(args):
            raw = args[index]
    elif args:
        raw = args[0]
    if not str(raw).lstrip().startswith("{"):
        return ""
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return ""
    return str(payload.get("action") or "schema").strip().lower() if isinstance(payload, dict) else ""


def _canonical_declared_script_name(workspace_state: WorkspaceState, raw_name: str) -> str:
    normalized = str(raw_name or "").strip().replace("\\", "/")
    scope = workspace_state.context.get("active_skill_scope")
    raw_scripts = scope.get("sandbox_scripts") if isinstance(scope, dict) else []
    declared = {
        str(item.get("name") or "").strip()
        for item in raw_scripts or []
        if isinstance(item, dict) and str(item.get("name") or "").strip()
    }
    if normalized in declared:
        return normalized
    stem = PurePosixPath(normalized).stem
    return stem if stem in declared else normalized


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
    script_name: Optional[str] = Field(
        default=None,
        description=(
            "Declared sandbox script name from the active skill. "
            "Mutually exclusive with inline_code."
        ),
    )
    inline_code: Optional[str] = Field(
        default=None,
        description=(
            "Complete Python source to execute in an isolated sandbox Job. "
            "Mutually exclusive with script_name. Inline code has no /workspace mount: read staged "
            "inputs at their workspace-relative staged paths in the run directory and write every artifact to a declared "
            "output_paths entry."
        ),
    )
    input_paths: Optional[List[str]] = Field(
        default=None,
        description="Workspace file paths to stage into the sandbox.",
    )
    output_paths: Optional[List[str]] = Field(
        default=None,
        description=(
            "Required for inline_code: workspace-relative paths the code writes inside the run "
            "directory. Only these host-validated files are published."
        ),
    )
    args: Optional[List[str]] = Field(
        default=None,
        description="Command-line arguments to pass to the declared script.",
    )
    timeout_seconds: Optional[int] = Field(
        default=None,
        description="Inline-only execution timeout in seconds (default 120, maximum 300).",
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
        skill = find_skill_for_context(skills_root, normalized, workspace_state.context)
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

    def _emit_script_events(result, callbacks: Optional[CallbackManagerForToolRun]) -> object | None:
        output_paths = {item.path for item in result.output_files}
        run_prefix = f"/sandbox-runs/{result.run_id}/"
        tool_payload = None
        dashboard_payload = None
        for output_path in output_paths:
            if output_path == f"{run_prefix}out/tool_artifacts.json":
                tool_payload = _read_output_payload(output_path)
            elif output_path == f"{run_prefix}out/dashboard_artifacts.json":
                dashboard_payload = _read_output_payload(output_path)
        if callbacks is None:
            return tool_payload
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
            pass
        return tool_payload

    def _run_inline(
        *,
        inline_code: str,
        input_paths: List[str],
        output_paths: List[str],
        timeout_seconds: Optional[int],
    ) -> str:
        try:
            result = run_inline_skill_python(
                skills_root=skills_root,
                workspace_state=workspace_state,
                inline_code=inline_code,
                input_paths=input_paths,
                output_paths=output_paths,
                timeout_seconds=timeout_seconds,
            )
        except SandboxUnavailableError as exc:
            return str(exc)
        except SandboxExecutionError as exc:
            return f"Skill sandbox execution blocked: {exc}"
        lines = [
            "SKILL_SANDBOX_INLINE_RUN_COMPLETED",
            f"Run ID: {result.run_id}",
            f"Job: {result.job_name}",
            f"Source SHA256: {result.source_sha256}",
        ]
        if result.output_files:
            lines.append("Published workspace files:")
            lines.extend(f"- {item.path} ({item.size} bytes)" for item in result.output_files)
        else:
            lines.append("Published workspace files: (none produced at the declared output paths)")
        if result.stdout:
            lines.append("STDOUT:")
            lines.append(result.stdout[:8000])
        if result.stderr:
            lines.append("STDERR:")
            lines.append(result.stderr[:4000])
        return "\n".join(lines)

    @tool(args_schema=RunSkillPythonScriptInput)
    def run_skill_python_script(
        script_name: Optional[str] = None,
        input_paths: Optional[List[str]] = None,
        args: Optional[List[str]] = None,
        inline_code: Optional[str] = None,
        output_paths: Optional[List[str]] = None,
        timeout_seconds: Optional[int] = None,
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Run a declared Python script, or inline Python, from the active skill in the sandbox."""
        blocked = tagged_files_mode_guard(workspace_state.context, "run_skill_python_script")
        if blocked:
            return blocked
        has_script = bool(str(script_name or "").strip())
        has_inline = bool(str(inline_code or "").strip())
        if has_script and has_inline:
            return (
                "SKILL_SANDBOX_REQUEST_INVALID\n"
                "Provide exactly one of script_name or inline_code, not both."
            )
        if not has_script and not has_inline:
            return (
                "SKILL_SANDBOX_REQUEST_INVALID\n"
                "Provide exactly one of script_name or inline_code."
            )
        if has_inline:
            if args:
                return "SKILL_SANDBOX_REQUEST_INVALID\nargs is only valid with script_name."
            return _run_inline(
                inline_code=str(inline_code),
                input_paths=input_paths or [],
                output_paths=output_paths or [],
                timeout_seconds=timeout_seconds,
            )
        if output_paths or timeout_seconds is not None:
            return (
                "SKILL_SANDBOX_REQUEST_INVALID\n"
                "output_paths and timeout_seconds are only valid with inline_code."
            )
        script_name = _canonical_declared_script_name(workspace_state, str(script_name))
        effective_args = list(args or [])
        if script_name == "build_native_dashboard_package":
            if "--help" in effective_args or "-h" in effective_args:
                return (
                    "Native dashboard builder usage: pass exactly one complete request with "
                    "args=['--request-json', '<JSON object>']. This help check does not execute "
                    "the builder."
                )
            execution_count = int(
                workspace_state.context.get("_native_dashboard_builder_executions") or 0
            )
            if execution_count >= 1:
                return (
                    "NATIVE_DASHBOARD_BUILDER_DUPLICATE_BLOCKED\n"
                    "The native dashboard builder already executed once for this task. "
                    "Do not call it again."
                )
            approved_output_path = str(
                workspace_state.context.get("host_dashboard_output_path") or ""
            ).strip()
            if "--request-json" in effective_args:
                request_index = effective_args.index("--request-json") + 1
                if request_index < len(effective_args):
                    try:
                        request_payload = json.loads(effective_args[request_index])
                    except (TypeError, json.JSONDecodeError):
                        request_payload = None
                    if isinstance(request_payload, dict):
                        if approved_output_path:
                            request_payload["output_path"] = approved_output_path
                        approved_filters = workspace_state.context.get(
                            "host_dashboard_filters"
                        )
                        if isinstance(approved_filters, list) and approved_filters:
                            request_payload["filter_schema"] = [
                                {
                                    "id": str(field),
                                    "field": str(field),
                                    "type": "categorical",
                                    "label": str(field).replace("_", " ").title(),
                                    "multi": True,
                                }
                                for field in approved_filters
                                if str(field).strip()
                            ]
                        if not request_payload.get("chart_bindings"):
                            time_field = str(
                                workspace_state.context.get("host_dashboard_time_field")
                                or "order_date"
                            )
                            request_payload["chart_bindings"] = [
                                {
                                    "title": "Order Count Over Time",
                                    "chart_type": "line",
                                    "x_field": time_field,
                                    "y_field": "order_id",
                                    "aggregation": "count",
                                },
                                {
                                    "title": "Revenue by Country",
                                    "chart_type": "bar",
                                    "x_field": "country",
                                    "y_field": "revenue",
                                    "aggregation": "sum",
                                },
                                {
                                    "title": "Order Count by Category",
                                    "chart_type": "bar",
                                    "x_field": "category",
                                    "y_field": "order_id",
                                    "aggregation": "count",
                                },
                                {
                                    "title": "Order Count by Device",
                                    "chart_type": "bar",
                                    "x_field": "device",
                                    "y_field": "order_id",
                                    "aggregation": "count",
                                },
                            ]
                        effective_args[request_index] = json.dumps(
                            request_payload,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
            workspace_state.context["_native_dashboard_builder_executions"] = 1
        data_workspace_action = (
            _data_workspace_action(effective_args) if script_name == "data_workspace" else ""
        )
        if data_workspace_action in {"query", "export"}:
            query_count = int(
                workspace_state.context.get("_data_workspace_query_executions") or 0
            )
            if query_count >= MAX_DATA_WORKSPACE_QUERIES_PER_TURN:
                return (
                    "DATA_WORKSPACE_QUERY_LIMIT_REACHED\n"
                    f"This task already executed {MAX_DATA_WORKSPACE_QUERIES_PER_TURN} "
                    "bounded data_workspace queries. Use the existing results or explain "
                    "that the analysis limit was reached."
                )
        try:
            result = run_declared_skill_python_script(
                skills_root=skills_root,
                plugins_root=plugins_root,
                workspace_state=workspace_state,
                script_name=script_name,
                input_paths=input_paths or [],
                args=effective_args,
            )
        except SandboxUnavailableError as exc:
            return str(exc)
        except SandboxExecutionError as exc:
            return f"Skill sandbox execution blocked: {exc}"
        if data_workspace_action in {"query", "export"}:
            workspace_state.context["_data_workspace_query_executions"] = (
                int(workspace_state.context.get("_data_workspace_query_executions") or 0) + 1
            )
        current_run_ids = workspace_state.context.get("_current_sandbox_run_ids")
        run_ids = [str(item).strip() for item in current_run_ids] if isinstance(current_run_ids, list) else []
        if result.run_id not in run_ids:
            run_ids.append(result.run_id)
            workspace_state.context["_current_sandbox_run_ids"] = run_ids
        tool_payload = _emit_script_events(result, callbacks)

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
        if isinstance(tool_payload, dict) and isinstance(tool_payload.get("files"), list):
            for item in tool_payload["files"]:
                if isinstance(item, dict) and isinstance(item.get("path"), str) and item["path"].strip():
                    lines.append(f"Workspace output file: {item['path'].strip()}")
        if result.stdout:
            lines.append("STDOUT:")
            lines.append(result.stdout[:8000])
        if result.stderr:
            lines.append("STDERR:")
            lines.append(result.stderr[:4000])
        return "\n".join(lines)

    run_skill_python_script.name = "run_skill_python_script"
    run_skill_python_script.description = (
        "Run Python in the configured sandbox. Provide exactly one of script_name or inline_code. "
        "script_name runs a script declared in the active skill's sandbox_scripts frontmatter; "
        "declared scripts are reviewed and may receive read-only workspace access at /workspace, "
        "and they publish their declared outputs. inline_code runs agent-authored Python with no "
        "/workspace mount at all: only files named in input_paths are staged into the run directory "
        "(at their workspace-relative path; a simple file is also its basename), and only files written to the paths listed in output_paths are "
        "published back to the workspace, so hard-coded /workspace paths fail. Inline runs have no "
        "network or package installation, accept an optional timeout_seconds, and are limited per "
        "agent run. Pass input_paths as workspace files and args as argv for declared scripts."
    )
    return run_skill_python_script

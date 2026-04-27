"""Tool creation helpers."""
from __future__ import annotations

import concurrent.futures
import json
import logging
import os
import re
import time
from importlib import import_module
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from uuid import uuid4

from langchain_core.tools import tool
from langchain_core.tools import Tool
from langgraph.types import interrupt

try:
    import vertexai
    from google import genai
    from google.genai.types import GenerateContentConfig, HttpOptions, ImageConfig, Modality
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise RuntimeError("Gemini dependencies are required") from exc

from .bigquery_export_tools import build_export_bigquery_query_tool
from .clarification_responses import normalize_clarification_resume_payload
from .configuration import Settings, ToolConfig
from .skills_registry import (
    SkillPolicy,
    activate_skill_context,
    build_loaded_skill_text,
    find_skill,
    is_skill_allowed,
    load_skills,
    read_skill_content,
)
from .rag_indexer import RagConfig, WorkspaceRagStore
from .state import WorkspaceState
from .tagged_file_policy import is_tagged_files_only, tagged_files_mode_guard
from .utils import SourceTracker, extract_web_url

logger = logging.getLogger(__name__)

_MAX_SKILL_LOAD_ATTEMPTS_PER_TURN = 8
_MAX_DISTINCT_SKILLS_PER_TURN = 3


class MissingToolBuilderError(RuntimeError):
    """Raised when a configured tool builder cannot be loaded."""


def _dict_has_keys(value: Any, keys: set[str]) -> bool:
    return isinstance(value, dict) and any(key in value for key in keys)


def _interrupt_with_retry(
    payload: Dict[str, Any],
    *,
    valid_keys: set[str],
    stale_keys: set[str],
    label: str,
    attempts: int = 2,
) -> Any:
    """Retry once when an interrupt receives a stale resume payload from a prior step."""
    response: Any = None
    for attempt in range(attempts):
        response = interrupt(payload)
        if not _dict_has_keys(response, stale_keys) or _dict_has_keys(response, valid_keys):
            return response
        logger.warning("%s received stale interrupt resume payload on attempt %s; retrying", label, attempt + 1)
    return response


def _get_active_skill_policy(workspace_state: WorkspaceState) -> SkillPolicy:
    raw = workspace_state.context.get("active_skill_policy")
    if isinstance(raw, SkillPolicy):
        return raw
    if isinstance(raw, dict):
        raw_pre_plan_limit = raw.get("pre_plan_search_limit")
        try:
            pre_plan_limit = int(raw_pre_plan_limit or 0)
        except (TypeError, ValueError):
            pre_plan_limit = 0
        return SkillPolicy(
            requires_hitl_plan=bool(raw.get("requires_hitl_plan")),
            requires_workspace_artifacts=bool(raw.get("requires_workspace_artifacts")),
            required_artifacts_mode=str(raw.get("required_artifacts_mode") or "") or None,
            required_artifacts=list(raw.get("required_artifacts") or []) or None,
            pre_plan_search_limit=max(0, pre_plan_limit),
        )
    return SkillPolicy()


def _is_plan_approved(workspace_state: WorkspaceState) -> bool:
    if workspace_state.context.get("skip_plan_approvals"):
        return True
    return bool(workspace_state.context.get("plan_approved"))


def _plan_gate_message() -> str:
    return (
        "Plan approval required before execution. "
        "Call request_plan_approval with title, summary, and checklist first."
    )


def _plan_gate_with_presearch_message(used: int, limit: int) -> str:
    base = _plan_gate_message()
    if limit <= 0:
        return base
    return f"{base} Pre-plan search limit reached ({used}/{limit})."


def _read_text_truncated(path: Path, max_chars: int) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:  # pragma: no cover - filesystem guard
        return f"[Error reading file: {exc}]"
    if max_chars > 0 and len(text) > max_chars:
        return text[:max_chars] + "\n\n[Truncated]"
    return text


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        logger.warning("Invalid int for %s=%r; using default=%s", name, raw, default)
        return default


def _clamp_min(name: str, value: int, minimum: int) -> int:
    if value < minimum:
        logger.warning("%s=%s is too small; clamping to %s", name, value, minimum)
        return minimum
    return value


# Gemini's backend enforces a minimum deadline for some operations (notably search).
_MIN_GEMINI_TIMEOUT_S = 10

_DEFAULT_SEARCH_TIMEOUT = _clamp_min(
    "GOOGLE_SEARCH_TIMEOUT_SECONDS",
    _env_int("GOOGLE_SEARCH_TIMEOUT_SECONDS", 30),
    _MIN_GEMINI_TIMEOUT_S,
)
_DEFAULT_HTTP_TIMEOUT = _clamp_min(
    "GEMINI_HTTP_TIMEOUT_SECONDS",
    _env_int("GEMINI_HTTP_TIMEOUT_SECONDS", 180),
    _MIN_GEMINI_TIMEOUT_S,
)
_DEFAULT_SEARCH_HTTP_TIMEOUT = _clamp_min(
    "GEMINI_SEARCH_HTTP_TIMEOUT_SECONDS",
    _env_int("GEMINI_SEARCH_HTTP_TIMEOUT_SECONDS", _DEFAULT_SEARCH_TIMEOUT),
    _MIN_GEMINI_TIMEOUT_S,
)
_SEARCH_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=4)


def _seconds_to_ms(seconds: int) -> int:
    # google.genai HttpOptions.timeout is milliseconds (see google.genai._api_client.get_timeout_in_seconds).
    return int(seconds) * 1000


def _generate_with_timeout(
    *,
    client,
    model_name: str,
    contents: str,
    config: dict,
    timeout_s: int,
    label: str,
):
    def _call():
        return client.models.generate_content(
            model=model_name,
            contents=contents,
            config=config,
        )

    start = time.monotonic()
    logger.info("%s started", label)
    future = _SEARCH_EXECUTOR.submit(_call)
    try:
        response = future.result(timeout=timeout_s)
    except concurrent.futures.TimeoutError:
        logger.warning("%s timed out after %ss", label, timeout_s)
        return None, f"timeout after {timeout_s}s"
    except Exception as exc:
        logger.exception("%s failed", label)
        return None, str(exc)
    finally:
        elapsed = time.monotonic() - start
        logger.info("%s completed in %.2fs", label, elapsed)
    return response, None


class GeminiClientManager:
    """Initializes and caches a Gemini client per service."""

    def __init__(self, settings: Settings):
        model_cfg = settings.model
        if model_cfg.provider != "gemini":
            raise ValueError(f"Unsupported model provider {model_cfg.provider}")

        api_key = model_cfg.api_key or os.getenv("GOOGLE_CLOUD_API_KEY") or os.getenv("GEMINI_API_KEY")
        use_vertex = model_cfg.use_vertex_ai

        client_kwargs: dict = {}
        if api_key:
            client_kwargs["api_key"] = api_key

        if use_vertex:
            if not model_cfg.project or not model_cfg.location:
                raise ValueError("Vertex AI mode requires both project and location")
            vertexai.init(project=model_cfg.project, location=model_cfg.location)
            client_kwargs.update(
                {
                    "vertexai": True,
                    "project": model_cfg.project,
                    "location": model_cfg.location,
                }
            )
        else:
            client_kwargs["vertexai"] = False

        # Main client: used for most model calls (allow longer runtime).
        self.client = genai.Client(
            **client_kwargs,
            http_options=HttpOptions(timeout=_seconds_to_ms(_DEFAULT_HTTP_TIMEOUT)),
        )
        # Search client: used for google_search tool calls (keep timeouts tight so a flaky network
        # can't stall runs or accumulate hung threads over time).
        self.search_client = genai.Client(
            **client_kwargs,
            http_options=HttpOptions(timeout=_seconds_to_ms(_DEFAULT_SEARCH_HTTP_TIMEOUT)),
        )
        self.model_name = model_cfg.chat_model_name
        self.image_model_name = model_cfg.image_model_name


class ToolFactory:
    """Builds tool instances for a given workspace state."""

    def __init__(self, settings: Settings, source_tracker: SourceTracker, gemini_manager: GeminiClientManager):
        self.settings = settings
        self.source_tracker = source_tracker
        self.gemini_manager = gemini_manager
        self._builtin_map: Dict[str, Callable[[WorkspaceState], Tool]] = {
            "google_search": self._build_google_search_tool,
            "gemini_image": self._build_gemini_image_tool,
            "google_grounded_search": self._build_google_grounded_search_tool,
            "export_bigquery_query": self._build_export_bigquery_query_tool,
            "append_to_report": self._build_append_to_report_tool,
            "create_pdf_from_images": self._build_create_pdf_from_images_tool,
            "get_image_url": self._build_get_image_url_tool,
            "rag_query": self._build_rag_query_tool,
            "list_skills": self._build_list_skills_tool,
            "load_skill": self._build_load_skill_tool,
            "request_plan_approval": self._build_request_plan_approval_tool,
            "request_clarification": self._build_request_clarification_tool,
            "request_human_action": self._build_request_human_action_tool,
        }

    def build_tools(self, tool_names: List[str], workspace_state: WorkspaceState) -> List[Tool]:
        tools: List[Tool] = []
        for name in tool_names:
            config = self.settings.get_tool(name)
            try:
                built = self._build_tool(config, workspace_state)
            except MissingToolBuilderError as exc:
                logger.warning("Skipping unavailable tool '%s': %s", name, exc)
                continue
            if isinstance(built, list):
                tools.extend(built)
            else:
                tools.append(built)
        return tools

    def _build_tool(self, config: ToolConfig, workspace_state: WorkspaceState) -> Tool | List[Tool]:
        if config.name in self._builtin_map:
            return self._builtin_map[config.name](workspace_state)
        if config.entrypoint:
            return self._load_entrypoint(config.entrypoint, workspace_state)
        raise ValueError(f"Tool '{config.name}' has no builder")

    def _load_entrypoint(self, entrypoint: str, workspace_state: WorkspaceState) -> Tool | List[Tool]:
        module_path, attr = entrypoint.split(":")
        try:
            module = import_module(module_path)
        except ModuleNotFoundError as exc:
            if exc.name == module_path or module_path.startswith(f"{exc.name}."):
                raise MissingToolBuilderError(
                    f"module '{module_path}' could not be imported"
                ) from exc
            raise
        try:
            factory = getattr(module, attr)
        except AttributeError as exc:
            raise MissingToolBuilderError(
                f"entrypoint '{entrypoint}' is missing attribute '{attr}'"
            ) from exc
        try:
            return factory(workspace_state=workspace_state, source_tracker=self.source_tracker)
        except TypeError:
            return factory()

    def _build_google_search_tool(self, workspace_state: WorkspaceState) -> Tool:
        return build_google_search_tool(
            workspace_state=workspace_state,
            source_tracker=self.source_tracker,
            client=self.gemini_manager.search_client,
            model_name=self.gemini_manager.model_name,
            tool_name="google_search",
            tool_description="Use Gemini's built-in search to gather fresh information.",
            search_label="google_search",
        )

    def _build_gemini_image_tool(self, workspace_state: WorkspaceState) -> Tool:
        return build_gemini_image_tool(
            workspace_state=workspace_state,
            client=self.gemini_manager.client,
            model_name=self.gemini_manager.image_model_name,
        )

    def _build_google_grounded_search_tool(self, workspace_state: WorkspaceState) -> Tool:
        """Compatibility alias of google_search for existing prompts/skills."""
        return build_google_search_tool(
            workspace_state=workspace_state,
            source_tracker=self.source_tracker,
            client=self.gemini_manager.search_client,
            model_name=self.gemini_manager.model_name,
            tool_name="google_grounded_search",
            tool_description="Alias of google_search with citations for backward compatibility.",
            search_label="google_grounded_search",
        )

    def _build_export_bigquery_query_tool(self, workspace_state: WorkspaceState) -> Tool:
        return build_export_bigquery_query_tool(workspace_state=workspace_state)

    def _build_list_skills_tool(self, workspace_state: WorkspaceState) -> Tool:
        """List available skills from the shared skills registry."""
        skills_root = self.settings.backend.skills_root

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
                desc = f": {skill.description}" if skill.description else ""
                lines.append(f"- {skill.skill_id}{desc}")
            return "Available skills:\n" + "\n".join(lines)

        list_skills.name = "list_skills"
        list_skills.description = "List available skills and their descriptions."
        return list_skills

    def _build_load_skill_tool(self, workspace_state: WorkspaceState) -> Tool:
        """Load the full content of a specific skill."""
        skills_root = self.settings.backend.skills_root

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
            if skill is not None:
                if not is_skill_allowed(skill, workspace_state.context):
                    return f"Skill '{skill.skill_id}' is not allowed for this user."

                attempts = int(workspace_state.context.get("skill_load_attempts_this_turn") or 0) + 1
                workspace_state.context["skill_load_attempts_this_turn"] = attempts
                if attempts > _MAX_SKILL_LOAD_ATTEMPTS_PER_TURN:
                    return (
                        "Skill load limit reached for this user turn. "
                        "Stop loading skills and either use the active skill's tools or ask for clarification."
                    )

                loaded = workspace_state.context.get("loaded_skill_ids_this_turn")
                loaded_ids = [str(item).strip() for item in loaded] if isinstance(loaded, list) else []
                if skill.skill_id not in loaded_ids:
                    if len(loaded_ids) >= _MAX_DISTINCT_SKILLS_PER_TURN:
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
                activate_skill_context(workspace_state.context, skill)
                return build_loaded_skill_text(skill, content)
            available = ", ".join(sorted({skill.skill_id for skill in skills}))
            return f"Skill '{normalized}' not found. Available skills: {available}"

        load_skill.name = "load_skill"
        load_skill.description = "Load the full content of a skill by id or name."
        return load_skill

    def _build_request_plan_approval_tool(self, workspace_state: WorkspaceState) -> Tool:
        """Request human review for a plan before running execution steps."""

        @tool
        def request_plan_approval(
            plan_title: str,
            plan_summary: str = "",
            execution_checklist: str = "",
            plan_summary_markdown: str = "",
            steps: Optional[List[Dict[str, Any]]] = None,
            plan_file_path: str = "",
            status_label: str = "Pending Approval",
            step_index: int = 0,
            step_count: int = 1,
            risky_actions: str = "None",
            reviewer_feedback: str = "",
            edited_plan_content: str = "",
        ) -> str:
            """Request human approval/edit/rejection for a proposed execution plan."""
            title = (plan_title or "").strip()
            summary = (plan_summary or "").strip()
            summary_markdown = (plan_summary_markdown or "").strip()
            checklist = (execution_checklist or "").strip()
            normalized_steps = steps if isinstance(steps, list) else []
            plan_path = (plan_file_path or "").strip() or "research_plan.md"
            status = (status_label or "").strip() or "Pending Approval"
            risks = (risky_actions or "").strip()
            feedback = (reviewer_feedback or "").strip()
            draft_content = (edited_plan_content or "").strip()

            if not title:
                return "Plan approval blocked: plan_title is required."
            if not summary_markdown and not summary:
                return "Plan approval blocked: plan_summary_markdown or plan_summary is required."
            if not normalized_steps and not checklist:
                return "Plan approval blocked: steps or execution_checklist is required."

            workspace_state.context["last_plan_feedback"] = feedback
            workspace_state.context["last_plan_file_path"] = plan_path

            if workspace_state.context.get("skip_plan_approvals"):
                workspace_state.context["plan_approved"] = True
                return (
                    "PLAN_APPROVAL_SKIPPED_TRUSTED_MODE\n"
                    f"Title: {title}\n"
                    f"Summary: {summary_markdown or summary}\n"
                    f"Execution checklist: {checklist or json.dumps(normalized_steps, ensure_ascii=False)}\n"
                    f"Plan file path: {plan_path}\n"
                    f"Status label: {status}\n"
                    f"Risky actions: {risks}\n"
                    "Workspace trusted mode is enabled, so plan approval was skipped. Continue executing the plan."
                )

            # If a reviewer provides edit feedback, require one more approval round.
            # This prevents immediate continuation after edit and enforces explicit
            # confirmation of the revised plan.
            if feedback:
                workspace_state.context["plan_approved"] = False
                return (
                    "PLAN_EDIT_FEEDBACK_RECORDED\n"
                    f"Title: {title}\n"
                    f"Summary: {summary_markdown or summary}\n"
                    f"Execution checklist: {checklist or json.dumps(normalized_steps, ensure_ascii=False)}\n"
                    f"Plan file path: {plan_path}\n"
                    f"Status label: {status}\n"
                    f"Risky actions: {risks}\n"
                    f"Reviewer feedback: {feedback}\n"
                    f"Edited draft included: {'yes' if draft_content else 'no'}\n"
                    "Do not execute yet. Revise the plan and call request_plan_approval again for final approval."
                )

            workspace_state.context["plan_approved"] = True

            return (
                "PLAN_APPROVAL_RECORDED\n"
                f"Title: {title}\n"
                f"Summary: {summary_markdown or summary}\n"
                f"Execution checklist: {checklist or json.dumps(normalized_steps, ensure_ascii=False)}\n"
                f"Plan file path: {plan_path}\n"
                f"Status label: {status}\n"
                f"Risky actions: {risks}\n"
                "Reviewer feedback: None\n"
                "Plan decision has been applied. Continue executing the approved plan."
            )

        request_plan_approval.name = "request_plan_approval"
        request_plan_approval.description = (
            "Ask human to approve, edit, or reject a proposed plan before execution."
        )
        return request_plan_approval

    def _build_request_clarification_tool(self, workspace_state: WorkspaceState) -> Tool:
        """Pause execution and ask the human a clarification question."""

        @tool
        def request_clarification(
            title: str,
            description: str = "",
            options_json: str = "[]",
            questions_json: str = "[]",
            allow_freeform: bool = True,
            multi_select: bool = False,
            placeholder: str = "",
            submit_label: str = "Continue",
            step_index: int = 0,
            step_count: int = 1,
            context_json: str = "{}",
        ) -> str:
            """Ask the human for clarification with optional selectable choices and typed feedback."""
            prompt_title = (title or "").strip()
            prompt_description = (description or "").strip()
            if not prompt_title:
                return "Clarification request blocked: title is required."

            parsed_choices: List[Dict[str, str]] = []
            try:
                raw_options = json.loads(options_json or "[]")
            except json.JSONDecodeError:
                raw_options = []
            if isinstance(raw_options, list):
                for index, item in enumerate(raw_options):
                    if isinstance(item, str) and item.strip():
                        parsed_choices.append(
                            {
                                "id": f"choice-{index + 1}",
                                "label": item.strip(),
                                "value": item.strip(),
                            }
                        )
                    elif isinstance(item, dict):
                        label = str(item.get("label") or item.get("value") or "").strip()
                        value = str(item.get("value") or label).strip()
                        if not label or not value:
                            continue
                        parsed_choices.append(
                            {
                                "id": str(item.get("id") or f"choice-{index + 1}").strip(),
                                "label": label,
                                "value": value,
                                **(
                                    {"description": str(item.get("description")).strip()}
                                    if str(item.get("description") or "").strip()
                                    else {}
                                ),
                            }
                        )

            parsed_questions: List[Dict[str, Any]] = []
            try:
                raw_questions = json.loads(questions_json or "[]")
            except json.JSONDecodeError:
                raw_questions = []
            if isinstance(raw_questions, list):
                for index, item in enumerate(raw_questions):
                    if not isinstance(item, dict):
                        continue
                    header = str(item.get("header") or item.get("title") or f"Question {index + 1}").strip()
                    question = str(item.get("question") or item.get("prompt") or item.get("description") or "").strip()
                    if not header or not question:
                        continue
                    parsed_question_options: List[Dict[str, str]] = []
                    raw_question_options = item.get("options")
                    if isinstance(raw_question_options, list):
                        for option_index, option in enumerate(raw_question_options):
                            if isinstance(option, str) and option.strip():
                                parsed_question_options.append(
                                    {
                                        "id": f"{header.lower().replace(' ', '-')}-{option_index + 1}",
                                        "label": option.strip(),
                                        "value": option.strip(),
                                    }
                                )
                            elif isinstance(option, dict):
                                label = str(option.get("label") or option.get("value") or "").strip()
                                value = str(option.get("value") or label).strip()
                                if not label or not value:
                                    continue
                                parsed_question_options.append(
                                    {
                                        "id": str(option.get("id") or f"{header.lower().replace(' ', '-')}-{option_index + 1}").strip(),
                                        "label": label,
                                        "value": value,
                                        **(
                                            {"description": str(option.get("description")).strip()}
                                            if str(option.get("description") or "").strip()
                                            else {}
                                        ),
                                    }
                                )
                    parsed_questions.append(
                        {
                            "id": str(item.get("id") or header.lower().replace(" ", "-")).strip(),
                            "header": header,
                            "question": question,
                            **({"options": parsed_question_options} if parsed_question_options else {}),
                        }
                    )

            input_mode = "text"
            if not parsed_questions:
                if parsed_choices and allow_freeform:
                    input_mode = "text_or_choice"
                elif parsed_choices:
                    input_mode = "choice"

            display_payload: Dict[str, Any] = {}
            try:
                parsed_context = json.loads(context_json or "{}")
                if isinstance(parsed_context, dict):
                    display_payload = parsed_context
            except json.JSONDecodeError:
                display_payload = {}

            action_choices = [] if parsed_questions else parsed_choices
            interrupt_payload = {
                "kind": "clarification",
                "title": prompt_title,
                "description": prompt_description,
                "step_index": max(0, int(step_index or 0)),
                "step_count": max(1, int(step_count or 1)),
                "actions": [
                    {
                        "id": choice["id"],
                        "label": choice["label"],
                        "style": "secondary",
                        "inputMode": "none",
                        "value": choice["value"],
                        **({"payload": {"selectedChoiceId": choice["id"]}} if choice.get("id") else {}),
                    }
                    for choice in action_choices
                ]
                + (
                    [
                        {
                            "id": "clarification-text",
                            "label": (submit_label or "Continue").strip() or "Continue",
                            "style": "primary",
                            "inputMode": "text",
                            "placeholder": (placeholder or "").strip(),
                            "submitLabel": (submit_label or "Continue").strip() or "Continue",
                        }
                    ]
                    if allow_freeform or not parsed_choices
                    else []
                ),
                "response_spec": {
                    "inputMode": input_mode,
                    "multiple": bool(multi_select),
                    "submitLabel": (submit_label or "Continue").strip() or "Continue",
                    "placeholder": (placeholder or "").strip(),
                    "choices": parsed_choices,
                    **({"questions": parsed_questions} if parsed_questions else {}),
                },
                "display_payload": display_payload,
            }

            response = _interrupt_with_retry(
                interrupt_payload,
                valid_keys={"message", "selectedChoiceIds", "selectedValues", "answersByQuestionId"},
                stale_keys={"decisions", "action"},
                label="request_clarification",
            )
            if isinstance(response, dict):
                return normalize_clarification_resume_payload(
                    response,
                    questions=parsed_questions,
                    choices=parsed_choices,
                )
            return str(response)

        request_clarification.name = "request_clarification"
        request_clarification.description = (
            "Pause execution to ask the human a clarification question. "
            "If a loaded skill says AskUserQuestion, AskUserChoice, or otherwise requires a structured user choice, use this tool instead of asking in chat prose. "
            "Use options_json for clickable suggestions and allow_freeform for typed input. "
            "For multi-question discovery forms, pass questions_json with objects like "
            '{"header":"Purpose","question":"What is this presentation for?","options":[{"label":"Pitch deck","value":"Pitch deck","description":"Selling an idea to investors"}]}. '
            "Do not pass section headers like Purpose or Length as the only options."
        )
        return request_clarification

    def _build_request_human_action_tool(self, workspace_state: WorkspaceState) -> Tool:
        """Pause execution and ask the human to choose from arbitrary actions."""

        @tool
        def request_human_action(
            title: str,
            description: str = "",
            actions_json: str = "[]",
            kind: str = "approval",
            step_index: int = 0,
            step_count: int = 1,
            context_json: str = "{}",
        ) -> str:
            """Ask the human to choose an action, optionally with scoped text input."""
            prompt_title = (title or "").strip()
            prompt_description = (description or "").strip()
            interrupt_kind = (kind or "approval").strip().lower()
            if interrupt_kind not in {"approval", "clarification"}:
                interrupt_kind = "approval"
            if not prompt_title:
                return "Human action request blocked: title is required."

            parsed_actions: List[Dict[str, Any]] = []
            try:
                raw_actions = json.loads(actions_json or "[]")
            except json.JSONDecodeError:
                raw_actions = []

            if isinstance(raw_actions, list):
                for index, item in enumerate(raw_actions):
                    if not isinstance(item, dict):
                        continue
                    action_id = str(item.get("id") or f"action-{index + 1}").strip()
                    label = str(item.get("label") or "").strip()
                    if not action_id or not label:
                        continue
                    style = str(item.get("style") or "secondary").strip().lower()
                    if style not in {"primary", "secondary", "danger"}:
                        style = "secondary"
                    input_mode = str(item.get("inputMode") or "none").strip().lower()
                    if input_mode not in {"none", "text"}:
                        input_mode = "none"
                    action_payload = item.get("payload")
                    action: Dict[str, Any] = {
                        "id": action_id,
                        "label": label,
                        "style": style,
                        "inputMode": input_mode,
                    }
                    if isinstance(item.get("placeholder"), str) and item["placeholder"].strip():
                        action["placeholder"] = item["placeholder"].strip()
                    if isinstance(item.get("submitLabel"), str) and item["submitLabel"].strip():
                        action["submitLabel"] = item["submitLabel"].strip()
                    if isinstance(item.get("confirm"), bool):
                        action["confirm"] = item["confirm"]
                    if isinstance(item.get("value"), str) and item["value"].strip():
                        action["value"] = item["value"].strip()
                    if isinstance(action_payload, dict):
                        action["payload"] = action_payload
                    parsed_actions.append(action)

            if not parsed_actions:
                return "Human action request blocked: provide at least one valid action in actions_json."

            display_payload: Dict[str, Any] = {}
            try:
                parsed_context = json.loads(context_json or "{}")
                if isinstance(parsed_context, dict):
                    display_payload = parsed_context
            except json.JSONDecodeError:
                display_payload = {}

            interrupt_payload = {
                "kind": interrupt_kind,
                "title": prompt_title,
                "description": prompt_description,
                "step_index": max(0, int(step_index or 0)),
                "step_count": max(1, int(step_count or 1)),
                "actions": parsed_actions,
                "display_payload": display_payload,
            }

            response = _interrupt_with_retry(
                interrupt_payload,
                valid_keys={"action"},
                stale_keys={"decisions", "message", "selectedChoiceIds", "selectedValues"},
                label="request_human_action",
            )
            if isinstance(response, dict):
                return json.dumps(response, ensure_ascii=False)
            return str(response)

        request_human_action.name = "request_human_action"
        request_human_action.description = (
            "Pause execution and ask the human to choose from arbitrary actions. "
            "Each action can be button-only or require scoped text input."
        )
        return request_human_action

    def _build_append_to_report_tool(self, workspace_state: WorkspaceState) -> Tool:
        """Append a section file to the stitched proposal inside the workspace."""
        root = workspace_state.root_path.resolve()

        def _resolve(path_str: str) -> Path:
            candidate = (root / path_str.lstrip("/")).resolve()
            if root not in candidate.parents and candidate != root:
                raise ValueError("Path must remain inside the workspace")
            return candidate

        def _display(path_obj: Path) -> str:
            try:
                return "/" + path_obj.relative_to(root).as_posix()
            except ValueError:
                return str(path_obj)

        @tool
        def append_to_report(source_path: str, target_path: str = "/Final_Proposal.md") -> str:
            """Append content from source_path into target_path with a separator."""
            blocked = tagged_files_mode_guard(workspace_state.context, "append_to_report")
            if blocked:
                return blocked
            try:
                source = _resolve(source_path)
                target = _resolve(target_path)
            except ValueError as exc:
                return str(exc)

            if not source.exists():
                return f"Source file '{_display(source)}' not found"

            try:
                source_text = source.read_text(encoding="utf-8").strip()
            except Exception as exc:  # pragma: no cover - filesystem guard
                return f"Error reading source '{_display(source)}': {exc}"

            target.parent.mkdir(parents=True, exist_ok=True)

            try:
                if target.exists():
                    existing = target.read_text(encoding="utf-8").rstrip()
                    stitched = f"{existing}\n\n{source_text}\n\n---\n"
                else:
                    stitched = f"{source_text}\n\n---\n"
                target.write_text(stitched, encoding="utf-8")
            except Exception as exc:  # pragma: no cover - filesystem guard
                return f"Error writing target '{_display(target)}': {exc}"

            return f"Appended {_display(source)} to {_display(target)}"

        append_to_report.name = "append_to_report"
        append_to_report.description = "Stitch a generated section into the final proposal."
        return append_to_report

    def _build_create_pdf_from_images_tool(self, workspace_state: WorkspaceState) -> Tool:
        """Create a multi-page PDF from workspace images."""
        root = workspace_state.root_path.resolve()

        def _is_inside_workspace(path_obj: Path) -> bool:
            return path_obj == root or root in path_obj.parents

        def _display(path_obj: Path) -> str:
            try:
                return "/" + path_obj.relative_to(root).as_posix()
            except ValueError:
                return str(path_obj)

        def _resolve_output(path_str: str) -> Path:
            normalized = str(path_str or "").strip() or "stitched_images.pdf"
            if not normalized.lower().endswith(".pdf"):
                normalized += ".pdf"
            candidate = (root / normalized.lstrip("/")).resolve()
            if not _is_inside_workspace(candidate):
                raise ValueError("Output path must remain inside the workspace")
            return candidate

        def _resolve_image(path_str: str) -> Path:
            raw = str(path_str or "").strip().replace("\\", "/")
            if not raw:
                raise ValueError("Image path cannot be empty")

            candidates: list[Path] = []
            raw_path = Path(raw)
            if raw_path.is_absolute():
                candidates.append(raw_path)
            candidates.append(root / raw.lstrip("/"))

            for candidate in candidates:
                resolved = candidate.resolve()
                if _is_inside_workspace(resolved) and resolved.is_file():
                    return resolved

            matches = [path for path in root.rglob("*") if path.is_file() and path.name == raw]
            if not matches:
                needle = raw.lower()
                matches = [path for path in root.rglob("*") if path.is_file() and needle in path.name.lower()]
            if len(matches) == 1:
                return matches[0].resolve()
            if len(matches) > 1:
                options = ", ".join(_display(match) for match in matches[:8])
                raise ValueError(f"Image path '{raw}' is ambiguous. Matches: {options}")
            raise ValueError(f"Image file '{raw}' not found in the workspace")

        def _page_size_points(page_size: str, width: int, height: int) -> tuple[float, float]:
            normalized = (page_size or "image").strip().lower()
            if normalized in {"a4", "a4_portrait"}:
                return 595.2756, 841.8898
            if normalized in {"letter", "us-letter"}:
                return 612.0, 792.0
            if normalized in {"image", "auto", "source"}:
                return float(width), float(height)
            raise ValueError("page_size must be one of: image, auto, A4, letter")

        @tool
        def create_pdf_from_images(
            image_paths: List[str],
            output_path: str = "/stitched_images.pdf",
            page_size: str = "image",
            fit_mode: str = "contain",
        ) -> str:
            """Create a multi-page PDF with one workspace image per page."""
            blocked = tagged_files_mode_guard(workspace_state.context, "create_pdf_from_images")
            if blocked:
                return blocked
            if not image_paths:
                return "No image paths provided."

            try:
                output = _resolve_output(output_path)
                resolved_images = [_resolve_image(path) for path in image_paths]
                normalized_fit = (fit_mode or "contain").strip().lower()
                if normalized_fit not in {"contain", "cover", "stretch"}:
                    return "fit_mode must be one of: contain, cover, stretch"

                import fitz  # PyMuPDF

                doc = fitz.open()
                for image_path in resolved_images:
                    with Image.open(image_path) as img:
                        width, height = img.size
                    page_width, page_height = _page_size_points(page_size, width, height)
                    page = doc.new_page(width=page_width, height=page_height)

                    if normalized_fit == "stretch":
                        rect = fitz.Rect(0, 0, page_width, page_height)
                    else:
                        scale = min(page_width / width, page_height / height)
                        if normalized_fit == "cover":
                            scale = max(page_width / width, page_height / height)
                        draw_width = width * scale
                        draw_height = height * scale
                        left = (page_width - draw_width) / 2
                        top = (page_height - draw_height) / 2
                        rect = fitz.Rect(left, top, left + draw_width, top + draw_height)
                    page.insert_image(rect, filename=str(image_path), keep_proportion=normalized_fit != "stretch")

                output.parent.mkdir(parents=True, exist_ok=True)
                doc.save(output)
                doc.close()
            except Exception as exc:
                return f"Error creating PDF: {exc}"

            image_list = ", ".join(_display(path) for path in resolved_images)
            return f"Created PDF {_display(output)} with {len(resolved_images)} pages from: {image_list}"

        create_pdf_from_images.name = "create_pdf_from_images"
        create_pdf_from_images.description = (
            "Create a multi-page PDF from workspace image files, preserving the supplied image order."
        )
        return create_pdf_from_images

    def _build_get_image_url_tool(self, workspace_state: WorkspaceState) -> Tool:
        """Get public URLs for images stored in MinIO/S3."""
        
        @tool
        def get_image_url(file_name: str) -> str:
            """Get the public URL for an image file stored in MinIO/S3.
            
            Args:
                file_name: The name of the image file (e.g., 'chart.png', 'diagram.jpg')
            
            Returns:
                The public URL of the image if found, or an error message if not found.
            """
            blocked = tagged_files_mode_guard(workspace_state.context, "get_image_url")
            if blocked:
                return blocked
            try:
                import json
                import os
                from pathlib import Path
                
                workspace_root = workspace_state.root_path
                
                # Look for a .workspace_metadata.json file that contains file information
                metadata_file = workspace_root / ".workspace_metadata.json"
                
                if not metadata_file.exists():
                    # If no metadata file exists, try to find the file locally and construct URL
                    # Search for the file in the workspace
                    matching_files = list(workspace_root.rglob(file_name))
                    
                    if not matching_files:
                        # Try partial match
                        matching_files = [
                            f for f in workspace_root.rglob("*")
                            if f.is_file() and file_name.lower() in f.name.lower()
                        ]
                    
                    if not matching_files:
                        return f"Error: No file found with name '{file_name}' in the workspace."
                    
                    # Get the first match
                    found_file = matching_files[0]
                    relative_path = found_file.relative_to(workspace_root)
                    
                    # Construct MinIO URL based on environment variables or defaults
                    s3_endpoint = os.getenv('S3_ENDPOINT') or os.getenv('MINIO_ENDPOINT') or 'http://localhost:9000'
                    s3_bucket = os.getenv('S3_BUCKET_NAME') or 'helpudoc'
                    workspace_id = workspace_state.workspace_id
                    
                    # Normalize the S3 key
                    s3_key = f"{workspace_id}/{relative_path.as_posix()}"
                    public_url = f"{s3_endpoint.rstrip('/')}/{s3_bucket}/{s3_key}"
                    
                    return (
                        f"File found: {found_file.name}\n"
                        f"Local path: /{relative_path.as_posix()}\n"
                        f"Potential public URL: {public_url}\n\n"
                        f"Note: This URL is constructed based on the file location. "
                        f"If the file hasn't been uploaded to MinIO/S3 yet, the URL may not be accessible."
                    )
                
                # Read metadata file if it exists
                with open(metadata_file, 'r') as f:
                    metadata = json.load(f)
                
                files = metadata.get('files', [])
                
                # Search for exact match first
                matching_file = None
                for file_info in files:
                    if file_info.get('name') == file_name:
                        matching_file = file_info
                        break
                
                # Try partial match if exact match not found
                if not matching_file:
                    for file_info in files:
                        if file_name.lower() in file_info.get('name', '').lower():
                            matching_file = file_info
                            break
                
                if not matching_file:
                    return f"Error: No file found with name '{file_name}' in workspace metadata."
                
                # Check if file has a public URL
                public_url = matching_file.get('publicUrl')
                if public_url:
                    return (
                        f"File: {matching_file['name']}\n"
                        f"Public URL: {public_url}\n"
                        f"MIME Type: {matching_file.get('mimeType', 'unknown')}"
                    )
                else:
                    storage_type = matching_file.get('storageType', 'unknown')
                    if storage_type == 'local':
                        return (
                            f"File '{matching_file['name']}' is stored locally and does not have a public URL.\n"
                            f"The file needs to be uploaded to MinIO/S3 to get a public URL."
                        )
                    else:
                        return f"Error: File '{matching_file['name']}' does not have a public URL available."
                    
            except Exception as e:
                import traceback
                return f"Error retrieving image URL: {str(e)}\n{traceback.format_exc()}"
        
        get_image_url.name = "get_image_url"
        get_image_url.description = "Retrieve the public URL for an image file stored in MinIO/S3."
        return get_image_url

    def _build_rag_query_tool(self, workspace_state: WorkspaceState) -> Tool:
        rag_cfg = RagConfig.from_env(self.settings.backend.workspace_root)
        rag_store = WorkspaceRagStore(self.settings.backend.workspace_root, rag_cfg)

        def _normalize_file_paths(paths: List[str]) -> List[str]:
            normalized: List[str] = []
            for raw in paths:
                if not raw:
                    continue
                cleaned = str(raw).strip().replace("\\", "/")
                if not cleaned:
                    continue
                lowered = cleaned.lower()
                if "tagged files" in lowered:
                    continue
                if cleaned.startswith(("-", "*", "•")):
                    cleaned = cleaned.lstrip("-*•").strip()
                if cleaned.startswith(":"):
                    cleaned = cleaned.lstrip(":").strip()
                if cleaned.startswith(("'", "\"")) and cleaned.endswith(("'", "\"")):
                    cleaned = cleaned[1:-1].strip()
                if not cleaned.startswith("/"):
                    cleaned = f"/{cleaned.lstrip('/')}"
                normalized.append(cleaned)
            return sorted(set(normalized))

        def _allow_basename_match(path_value: str) -> bool:
            normalized = str(path_value or "").strip().replace("\\", "/").lstrip("/")
            if not normalized:
                return False
            if normalized.startswith(".system/"):
                return False
            return "/" not in normalized

        @tool
        async def rag_query(
            query: str,
            file_paths: Optional[List[str]] = None,
            mode: str = "naive",
            include_references: bool = False,
        ) -> str:
            """Retrieve context from LightRAG, optionally restricted to specific file paths."""
            if not query or not query.strip():
                raise ValueError("Query is required")
            effective_paths = file_paths or workspace_state.context.get("tagged_files") or []
            normalized = _normalize_file_paths(effective_paths)
            if normalized and mode != "hybrid":
                mode = "hybrid"
            cached_context = workspace_state.context.get("tagged_rag_context")
            if cached_context and is_tagged_files_only(workspace_state.context):
                return str(cached_context)
            keywords: List[str] = [query.strip()]
            if normalized:
                keywords.extend(normalized)
                keywords.extend([Path(item).name for item in normalized if item])
            response = await rag_store.query_data(
                workspace_state.workspace_id,
                query,
                mode=mode,
                include_references=include_references,
                hl_keywords=keywords,
                ll_keywords=keywords,
            )
            data = response.get("data") if isinstance(response, dict) else None
            chunks = data.get("chunks", []) if isinstance(data, dict) else []
            if not chunks and mode != "naive":
                response = await rag_store.query_data(
                    workspace_state.workspace_id,
                    query,
                    mode="naive",
                    include_references=include_references,
                    hl_keywords=keywords,
                    ll_keywords=keywords,
                )
                data = response.get("data") if isinstance(response, dict) else None
                chunks = data.get("chunks", []) if isinstance(data, dict) else []
            if not chunks and mode != "hybrid":
                response = await rag_store.query_data(
                    workspace_state.workspace_id,
                    query,
                    mode="hybrid",
                    include_references=include_references,
                    hl_keywords=keywords,
                    ll_keywords=keywords,
                )
                data = response.get("data") if isinstance(response, dict) else None
                chunks = data.get("chunks", []) if isinstance(data, dict) else []
            if normalized:
                normalized_basenames = {Path(item).name for item in normalized if _allow_basename_match(item)}
                filtered = []
                for chunk in chunks:
                    file_path = chunk.get("file_path") or ""
                    if file_path in normalized:
                        filtered.append(chunk)
                        continue
                    if Path(file_path).name in normalized_basenames:
                        filtered.append(chunk)
                chunks = filtered
            if not chunks:
                # Common case: a tagged file exists on disk but isn't indexed yet (e.g., newly
                # generated artifacts). When file paths are specified, fall back to raw file
                # reads for small/text files so the agent can proceed without RAG.
                if normalized:
                    workspace_root = workspace_state.root_path.resolve()
                    max_chars = int(getattr(rag_cfg, "max_text_chars", 250000) or 250000)
                    max_chars = min(max_chars, 40000)
                    supported_text_suffixes = {
                        ".md",
                        ".txt",
                        ".json",
                        ".yaml",
                        ".yml",
                        ".toml",
                        ".csv",
                        ".ts",
                        ".tsx",
                        ".js",
                        ".jsx",
                        ".py",
                        ".sql",
                    }
                    parts: List[str] = []
                    for rel in normalized:
                        rel_clean = rel.lstrip("/")
                        candidate = (workspace_root / rel_clean).resolve()
                        if workspace_root not in candidate.parents and candidate != workspace_root:
                            continue
                        if not candidate.exists() or not candidate.is_file():
                            parts.append(f"[{rel}] [File not found on disk]")
                            continue
                        if candidate.suffix.lower() not in supported_text_suffixes:
                            parts.append(
                                f"[{rel}] [Not indexed and not a supported text file type for fallback: {candidate.suffix}]"
                            )
                            continue
                        parts.append(f"[{rel}] {_read_text_truncated(candidate, max_chars)}")
                    if parts:
                        return "\n\n".join(parts)
                return (
                    "No relevant context found for the requested file(s)."
                    if normalized
                    else "No relevant context found."
                )
            lines: List[str] = []
            for chunk in chunks:
                content = chunk.get("content") or ""
                if not content:
                    continue
                file_path = chunk.get("file_path") or "unknown_source"
                lines.append(f"[{file_path}] {content}")
            return "\n\n".join(lines) if lines else "No relevant context found."

        rag_query.name = "rag_query"
        rag_query.description = (
            "Retrieve workspace context from LightRAG. "
            "Use file_paths to restrict results to specific tagged files."
        )
        return rag_query


def _build_grounded_google_search_tool(
    workspace_state: WorkspaceState,
    source_tracker: SourceTracker,
    *,
    client,
    model_name: str,
    tool_name: str,
    tool_description: str,
    search_label: str,
) -> Tool:
    """Create a Gemini-grounded Google search tool and persist discovered sources."""
    tracker = source_tracker

    @tool
    def grounded_search(query: str, max_results: int = 5) -> str:
        """Run a Gemini native Google search for the given query."""
        blocked = tagged_files_mode_guard(workspace_state.context, tool_name)
        if blocked:
            return blocked
        policy = _get_active_skill_policy(workspace_state)
        if policy.requires_hitl_plan and not _is_plan_approved(workspace_state):
            limit = max(0, int(policy.pre_plan_search_limit or 0))
            raw_used = workspace_state.context.get("pre_plan_search_count", 0)
            try:
                used = max(0, int(raw_used))
            except (TypeError, ValueError):
                used = 0
            if limit <= 0 or used >= limit:
                return _plan_gate_with_presearch_message(used, limit)
            # Count attempts before executing the search to prevent infinite retries on failures.
            workspace_state.context["pre_plan_search_count"] = used + 1

        try:
            max_results = max(1, int(max_results or 1))
        except (TypeError, ValueError):
            max_results = 5
        search_prompt = (
            f"Search the web for information about: {query}\n\n"
            f"Return a comprehensive summary, citing up to {max_results} relevant sources."
        )
        response, error = _generate_with_timeout(
            client=client,
            model_name=model_name,
            contents=search_prompt,
            config={
                "tools": [{"google_search": {}}],
                "temperature": 0,
            },
            timeout_s=_DEFAULT_SEARCH_TIMEOUT,
            label=search_label,
        )
        if error:
            return f"Search failed ({error})."

        summary = response.text or "No results found."
        sources: List[Dict[str, str]] = []
        sources_str = "\n\n--- SOURCES ---"

        if response.candidates and response.candidates[0].grounding_metadata:
            grounding_chunks = response.candidates[0].grounding_metadata.grounding_chunks or []
            web_chunks = [chunk for chunk in grounding_chunks if hasattr(chunk, "web") and chunk.web]

            seen_urls = set()
            for chunk in web_chunks:
                actual_url = extract_web_url(chunk.web)
                if not actual_url or actual_url in seen_urls:
                    continue
                sources.append(
                    {
                        "title": getattr(chunk.web, "title", None) or "Untitled",
                        "url": actual_url,
                    }
                )
                seen_urls.add(actual_url)

        if sources:
            tracker.record(workspace_state, sources)
            for src in sources[:max_results]:
                sources_str += f"\nTitle: {src['title']}\nURL: {src['url']}\n"
        else:
            sources_str += "\nNo sources were found for this query."

        return summary + sources_str

    grounded_search.name = tool_name
    grounded_search.description = tool_description
    return grounded_search


def build_google_search_tool(
    workspace_state: WorkspaceState,
    source_tracker: SourceTracker,
    client=None,
    model_name: str | None = None,
    *,
    tool_name: str = "google_search",
    tool_description: str = "Use Gemini's built-in search to gather fresh information.",
    search_label: str = "google_search",
) -> Tool:
    """Public builder so YAML entrypoints stay accurate."""
    if client is None or model_name is None:
        raise ValueError("Gemini client and model name are required")
    return _build_grounded_google_search_tool(
        workspace_state=workspace_state,
        source_tracker=source_tracker,
        client=client,
        model_name=model_name,
        tool_name=tool_name,
        tool_description=tool_description,
        search_label=search_label,
    )


def build_gemini_image_tool(
    workspace_state: WorkspaceState,
    client=None,
    model_name: str | None = None,
) -> Tool:
    """Create a Gemini image generation/editing tool."""
    if client is None or model_name is None:
        raise ValueError("Gemini client and image model name are required")

    output_dir = workspace_state.root_path

    def _resolve_source_image(path_str: str) -> Image.Image:
        candidate = Path(path_str)
        if not candidate.is_absolute():
            candidate = workspace_state.root_path / candidate
        candidate = candidate.resolve()
        workspace_root = workspace_state.root_path.resolve()
        if workspace_root not in candidate.parents and candidate != workspace_root:
            raise ValueError("Source image path must be inside the workspace")
        if not candidate.exists():
            raise FileNotFoundError(f"Source image '{candidate}' not found")
        with Image.open(candidate) as img:
            return img.copy()

    def _sanitize_prefix(raw_prefix: str | None) -> str:
        if raw_prefix and raw_prefix.strip():
            candidate = raw_prefix.strip()
        else:
            candidate = f"gemini-image-{uuid4().hex[:8]}"
        safe = "".join(
            ch if ch.isalnum() or ch in ("-", "_") else "-"
            for ch in candidate
        )
        return safe or f"gemini-image-{uuid4().hex[:8]}"

    def _is_explicit_image_request(prompt: str) -> bool:
        text = (prompt or "").lower()
        keywords = (
            "image",
            "picture",
            "photo",
            "diagram",
            "figure",
            "illustration",
            "render",
            "draw",
            "sketch",
            "visual",
            "edit",
            "generate",
        )
        return any(keyword in text for keyword in keywords)

    def _save_inline_image(inline_data, prefix: str, index: int) -> str:
        filename = f"{prefix}-{index + 1}.png"
        destination = output_dir / filename
        with BytesIO(inline_data.data) as stream:
            with Image.open(stream) as image:
                image.save(destination)
        return str(destination.relative_to(workspace_state.root_path))

    def _extract_json_payload(text: str) -> str:
        fenced = re.search(r"```json\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
        if fenced:
            return fenced.group(1).strip()
        return text.strip()

    def _save_json_payload(payload: dict, prefix: str) -> str:
        filename = f"{prefix}.json"
        destination = output_dir / filename
        with open(destination, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        return str(destination.relative_to(workspace_state.root_path))

    @tool
    def gemini_image(
        prompt: str,
        source_image_path: str | None = None,
        output_name_prefix: str | None = None,
        extract_assets: bool = False,
        assets_output_name: str | None = None,
    ) -> str:
        """Generate or edit an image with Gemini.

        Args:
            prompt: Description of the image or edit instructions.
            source_image_path: Optional path (relative to workspace root) to edit an existing image.
            output_name_prefix: Optional file name prefix for the saved image(s).
            extract_assets: If true, request a JSON asset description instead of images.
            assets_output_name: Optional JSON file name prefix for extracted assets.

        Returns:
            Summary text describing Gemini's response and the saved image paths.
        """

        if not prompt.strip():
            return "Skipped gemini_image: prompt is required for image generation/editing."

        blocked = tagged_files_mode_guard(workspace_state.context, "gemini_image")
        if blocked:
            return blocked

        if not _is_explicit_image_request(prompt):
            return "Skipped gemini_image: user did not explicitly request image generation/editing."

        if source_image_path:
            try:
                source_image = _resolve_source_image(source_image_path)
            except Exception as exc:
                return f"Skipped gemini_image: {exc}"
            contents: List[object] = [source_image, prompt]
        else:
            contents = [prompt]

        prefix = _sanitize_prefix(output_name_prefix)
        assets_prefix = _sanitize_prefix(assets_output_name or f"{prefix}-assets")
        if extract_assets:
            assets_prompt = (
                "Return JSON only for PPTX reconstruction. "
                "Schema: {\"version\":\"1\",\"canvas\":{\"width\":int,\"height\":int},"
                "\"elements\":[{\"type\":\"text\",\"bbox\":[x0,y0,x1,y1],"
                "\"text\":\"...\",\"font_size\":number,\"bold\":bool,\"italic\":bool,"
                "\"underline\":bool,\"color_rgb\":[r,g,b],\"align\":\"left|center|right|justify\"},"
                "{\"type\":\"image\",\"bbox\":[x0,y0,x1,y1],\"description\":\"...\"},"
                "{\"type\":\"table\",\"bbox\":[x0,y0,x1,y1],\"rows\":int,\"cols\":int,"
                "\"cells\":[[\"...\"]]}]}. "
                "Use pixel coordinates matching the input image. "
                "If unsure, omit fields rather than guessing."
            )
            response = client.models.generate_content(
                model=model_name,
                contents=[*contents, assets_prompt],
                config=GenerateContentConfig(
                    response_modalities=[Modality.TEXT],
                    candidate_count=1,
                ),
            )
        else:
            response = client.models.generate_content(
                model=model_name,
                contents=contents,
                config=GenerateContentConfig(
                    response_modalities=[Modality.IMAGE, Modality.TEXT],
                    candidate_count=1,
                    image_config=ImageConfig(
                        aspectRatio="1:1",
                    ),
                ),
            )

        text_parts: List[str] = []
        saved_images: List[str] = []

        if not response.candidates:
            raise RuntimeError("Gemini did not return any candidates")

        for candidate in response.candidates:
            if not candidate.content:
                continue
            for part in candidate.content.parts:
                if getattr(part, "text", None):
                    text_parts.append(part.text)
                elif getattr(part, "inline_data", None):
                    saved = _save_inline_image(part.inline_data, prefix, len(saved_images))
                    saved_images.append(saved)

        summary_lines = []
        if extract_assets:
            if not text_parts:
                return "No JSON was returned by Gemini."
            raw_text = "\n".join(text_parts).strip()
            json_text = _extract_json_payload(raw_text)
            try:
                payload = json.loads(json_text)
            except json.JSONDecodeError as exc:
                return f"Failed to parse JSON from Gemini: {exc}"
            saved_json = _save_json_payload(payload, assets_prefix)
            summary_lines.append("Saved JSON:")
            summary_lines.append(saved_json)
            return "\n".join(summary_lines)

        if text_parts:
            summary_lines.append("\n".join(text_parts).strip())
        if saved_images:
            summary_lines.append("Saved images:")
            summary_lines.extend(saved_images)
        else:
            summary_lines.append("No images were returned by Gemini.")
        return "\n".join(summary_lines)

    gemini_image.name = "gemini_image"
    gemini_image.description = (
        "Generate or edit workspace images using Gemini models; can also extract JSON layout assets."
    )
    return gemini_image


#
# MCP integration lives in helpudoc_agent.mcp_manager (MCPServerManager).
#

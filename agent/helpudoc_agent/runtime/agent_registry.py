"""Build and cache DeepAgents / LangChain agents for workspace runs."""
from __future__ import annotations

from copy import deepcopy
import json
import logging
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Tuple

from deepagents.backends import CompositeBackend, FilesystemBackend
from deepagents.backends.protocol import (
    EditResult,
    FileDownloadResponse,
    FileUploadResponse,
    GlobResult,
    GrepResult,
    LsResult,
    ReadResult,
    WriteResult,
)
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware, TodoListMiddleware
from langchain_quickjs.middleware import CodeInterpreterMiddleware

from helpudoc_agent.middleware.interaction_contract import InteractionContractMiddleware
from helpudoc_agent.middleware.implicit_input_guard import ImplicitInputGuardMiddleware
from langchain.agents.middleware.summarization import SummarizationMiddleware
from langgraph.checkpoint.memory import MemorySaver
from ..configuration import Settings
from ..gemini_chat import create_chat_google_generative_ai
from ..state import WorkspaceState, AgentRuntimeState
from ..tools_and_schemas import ToolFactory
from ..skills_registry import (
    SkillMetadata,
    collect_tool_names,
    find_skill_for_context,
    get_candidate_mcp_servers,
    is_skill_allowed,
    load_skills,
    sync_skills_to_workspace,
)
from ..bigquery_export_tools import load_bigquery_defaults
from ..mcp_manager import MCPServerManager
from ..tool_guard import GuardedTool
from ..memory_store import UserScopedStoreBackend
from ..tools.workspace.builtins.skill_proposals import workspace_skill_proposals_enabled

logger = logging.getLogger(__name__)

SKILL_BUILDER_PERSONA = "skill-builder"

# The Skill Creator proposes files; the user's approval step writes them. Withhold the
# tools that would let it act directly, rather than relying on the prompt to decline.
# Scoped to this persona: widening `_WORKSPACE_MUTATING_TOOLS` instead would also change
# what a published read-only workspace blocks, which is a separate decision.
SKILL_BUILDER_DENIED_TOOLS = frozenset({
    "append_to_report",
    "create_pdf_from_images",
    "document_execute",
    "edit_file",
    "export_bigquery_query",
    "image_generation",
    # The Skill Creator dialog reads its json action block; it renders no proposal cards.
    "propose_skill",
    "run_skill_python_script",
    "upload_files",
    "write_file",
})

# The Skill Creator's contract with the dialog that renders its output.
#
# `SkillCreatorDialog.parseActions` scans each reply for a fenced ```json block holding
# `{"actions": [...]}` and fills the Proposed draft panel from it. Nothing else populates
# that panel, so a reply without the block leaves it on its placeholder however good the
# prose is. The persona was advertised in `/agents` but never given a prompt, so the
# builder ran on the general prompt and did what a general assistant does: wrote files and
# described them.
SKILL_BUILDER_SYSTEM_PROMPT = (
    "You are the Skill Creator. You help a user design one skill and you propose its "
    "files. You never create the skill yourself.\n\n"
    "Do not write, edit, or delete any file. The user's approval step applies your "
    "proposal; acting directly would bypass the review their platform requires.\n\n"
    "Ask about the workflow, its inputs, its constraints, and what a good result looks "
    "like. Ask one focused question at a time and stop asking once you can write the "
    "skill. Reply in plain prose while you are still asking.\n\n"
    "When you have enough to propose the skill, reply with a short summary followed by "
    "exactly one fenced json block of this shape:\n\n"
    "```json\n"
    '{"actions": [\n'
    '  {"type": "create_skill", "skillId": "kebab-case-id", "name": "Display name", '
    '"description": "When and how to use this skill."},\n'
    '  {"type": "upsert_text", "skillId": "kebab-case-id", "path": "SKILL.md", '
    '"content": "---\\nname: ...\\n---\\n..."}\n'
    "]}\n"
    "```\n\n"
    "Every action carries the same `skillId`, including the file actions -- the batch "
    "describes one skill.\n\n"
    "Rules for the block: emit it only when proposing, never while asking a question; "
    "emit exactly one, as the last thing in the reply; put every file in it, with "
    "`SKILL.md` first. Paths are relative to the skill folder -- `SKILL.md`, "
    "`references/guide.md`, `scripts/run.py` -- never absolute and never starting with "
    "`skills/`.\n\n"
    "SKILL.md opens with YAML frontmatter holding `name` and `description`, and lists "
    "`tools` only where the skill genuinely needs them. An empty `tools: []` does not "
    "mean 'no tools' to this runtime, it means 'unrestricted', so omit the key instead "
    "of writing an empty list."
)

# Appended to the general prompt while ENABLE_WORKSPACE_SKILL_PROPOSALS is on. Asked how
# to create skills, the agent used to say "add a folder under /skills/" and then did it.
SKILL_PROPOSAL_PROMPT = (
    "\n\nCreating skills: when the user asks to create, convert or package skills -- for "
    "example from an attached document -- call propose_skill once per skill. Put every file in "
    "it, SKILL.md first, opening with YAML frontmatter that has name and description. Never "
    "write skill files with write_file or edit_file; /skills/ is read-only. Each proposal "
    "appears to the user as a card. They save it as a private draft, which runs at once in "
    "their own private workspaces, then submit it for review from Skill Governance, choosing "
    "the owning Team. If they ask how to create skills here, describe that flow."
)

GENERAL_SYSTEM_PROMPT = (
    "You are a general assistant. Use skills for specialized tasks. "
    "Apply progressive disclosure: call list_skills to discover relevant skills, "
    "then load_skill for only the matching SKILL.md and follow its instructions. "
    "If tools are listed in a skill frontmatter, use only those tools while executing that skill; "
    "if no tools are listed, you may use any appropriate tools. "
    "Routing override: if the request mentions .ppt, .pptx, PowerPoint, Google Slides, native slide decks, deck templates, editing an existing deck, or producing a PowerPoint/Google Slides deliverable, load the pptx skill. "
    "Do not load frontend-slides for PPTX-related work. Use frontend-slides only when the user explicitly asks for a browser-native HTML/web presentation or an animated interactive HTML deck. "
    "For tagged or named PDFs load the pdf skill; for DOCX or Word documents load the docx skill; "
    "for XLSX, XLSM, CSV, or TSV files load the xlsx skill. Search the original document on demand "
    "with search_document and use bounded inspect_document calls; do not require a derived copy or vector index. "
    "For supplied @kb context, read the OKF index with knowledge_read and follow only relevant concepts, "
    "using knowledge_search when discovery is needed. "
    "Once a skill is loaded, stay within that skill's workflow until its completion criteria are met "
    "(for example: report requests should end with the report artifact tool, dashboard requests should end with the dashboard tool). "
    "Do not assume skills are copied into the workspace. "
    "For proposal/SOW/RFP requests, always load the proposal-writing skill and write "
    "the proposal to workspace markdown files using write_file (and append_to_report if needed). "
    "Only call request_plan_approval when the loaded skill explicitly requires a plan review checkpoint or the active skill policy says requires_hitl_plan=true. "
    "Use workflow_action to express workflow control as structured data instead of chat prose. "
    "When user input is needed, call workflow_action with action='request_user_interaction' and include gate_id, presentation, props_json, and context_json; "
    "request_interaction and request_clarification are lower-level compatibility tools for the same kind of user-input pause. "
    "If execution is blocked on missing user intent or an unresolved choice, emit a structured user-input action instead of guessing. "
    "When a loaded skill says AskUserQuestion, asks for approval, or asks the human to pick among named options, "
    "you must use workflow_action(action='request_user_interaction'), request_clarification, request_interaction, or request_human_action with structured payloads instead of plain chat prose. "
    "For multi-question forms, populate questions_json. For chooser steps, populate options_json or actions_json with explicit labels, values, and descriptions. "
    "If you need the human to choose from arbitrary next-step actions, call request_human_action. "
    "After calling workflow_action(action='request_user_interaction'), request_interaction, request_clarification, or request_human_action, stop and wait for the resume payload. "
    "Do not continue to later phases, generate previews, or write additional artifacts until the interrupt has been answered. "
    "Only proceed with side-effecting tools after approval (or after applying user edits). "
    "Reply in chat with brief status updates, not full sections. "
    "If no skill applies, proceed with best-effort behavior. "
    "Treat tagged files, published knowledge, and prior workspace documents as grounded project context, "
    "but not as authoritative sources for facts that may have changed recently. "
    "When the user asks for the latest/current model version, pricing, dates, schedules, or other time-sensitive facts, "
    "verify them with allowed fresh sources such as the requested MCP server, official documentation, google_search, "
    "or the url_context tool for explicit user-provided links instead of repeating stale artifact text. "
    "If fresh sources disagree with an attached artifact, say so clearly and prefer the verified fresh source for the answer. "
    "When the user message begins with a [Host time] block, treat those timestamps as authoritative for "
    "\"today\", calendar years, deadlines, and filenames—do not assume an older year from training data."
)

BASE_AGENT_PROMPT = "In order to complete the objective that the user asks of you, you have access to a number of standard tools."


def build_bigquery_defaults_prompt() -> str:
    """State the deployment's BigQuery project and location in the system prompt.

    The `bigquery-managed` tools take `projectId` as a model-supplied argument, and
    `list_dataset_ids` has no location parameter at all. Nothing in the transport can
    fill either one: `X-goog-user-project` only attributes quota, and MCPServerConfig
    carries no default-args field. Without this block the model has no project in
    context and reaches for `bigquery-public-data`, which is world-readable and sits in
    the US multi-region, so every answer looked like a wrong-region default.

    Read from `load_bigquery_defaults()` rather than written into `skills/*/SKILL.md` so
    dev and prod each state their own project without re-seeding skills-pvc.

    This steers defaults; it is not an access control. Every call carries the end user's
    delegated OAuth token, so BigQuery IAM still decides what they may read.
    """
    defaults = load_bigquery_defaults()
    project = defaults["project"]
    location = defaults["location"]
    return (
        "\n\nBigQuery defaults for this deployment:\n"
        f"- Default project is `{project}`. Pass `projectId: \"{project}\"` on every "
        "`bigquery-managed` call unless the user names a different project.\n"
        "- If the user supplies their own project ID, use theirs for that request and keep "
        "using it for follow-up calls in the same thread.\n"
        "- Never query `bigquery-public-data` unless the user names it or asks for public "
        "sample data. It is not this deployment's data and must not be used to answer a "
        "question about \"my datasets\" or \"our tables\".\n"
        f"- Default job location is `{location}`. `list_dataset_ids` returns every dataset "
        "in a project regardless of region; to list datasets for one region, run "
        f"`execute_sql` against "
        f"`<project>.region-{location}.INFORMATION_SCHEMA.SCHEMATA`.\n"
        "- Use `execute_sql` when the user wants to read results. Use "
        "`export_bigquery_query` only when the user asked for a file, or when the result is "
        "too large to read in chat; it always writes a workspace file and never returns "
        "rows, so it cannot answer \"show me N rows\"."
    )

ALWAYS_AVAILABLE_TOOL_GROUPS = (
    "load_skill",
    "list_skills",
    "knowledge_navigation",
    "request_interaction",
    "workflow_action",
    # The only way an agent may help create a skill: /skills/ is read-only.
    "propose_skill",
)

_STRUCTURED_DATA_SUFFIXES = frozenset({".csv", ".tsv", ".parquet", ".json"})
_DATA_ARTIFACT_OUTPUT_DIRS = frozenset({"sandbox-runs", "charts", "dashboards", "reports"})

# Product-managed storage, not documents anyone authored: immutable file versions,
# upload staging, OKF knowledge bundles, and the archived artifact packs of earlier
# runs. The backend already keeps this out of the file browser, the artifact commit
# and the provenance trail (`isInternalWorkspacePath`); the agent had no equivalent
# rule, so it could list and read every superseded version of every file.
#
# `sandbox-runs/` is deliberately not here. The data skill reads its own current
# run's outputs through this backend, and `_data_path_is_visible` already bounds
# that to the run's own ids; hiding the directory outright would break it.
_INTERNAL_AGENT_DIR_NAMES = frozenset({".system"})


def _is_internal_agent_path(file_path: Any) -> bool:
    normalized = str(file_path or "").strip().replace("\\", "/")
    return any(part in _INTERNAL_AGENT_DIR_NAMES for part in normalized.split("/") if part)


class ReadOnlySkillsBackend(FilesystemBackend):
    """Serve the shared skill catalog at /skills/ for reading only.

    The agent reads a loaded skill's references and assets from here. Writes were never
    meant to land here: /skills/ is every team's catalog, and the backend's startup
    backfill registers any new folder as an active governed skill with no creator. A
    chat on aiengine-dev wrote ten such skills on 2026-10-12 by asking the agent to
    convert a Word document. Skills change only through the Skill Creator draft flow,
    which records the creator and the owning team and goes through review.

    The async variants (awrite, aedit, aupload_files) delegate to these methods in
    deepagents' BackendProtocol, so they are refused too.
    """

    _MESSAGE = (
        "Cannot {operation} '{path}': /skills/ is the shared skill catalog and is read-only. "
        "To create a skill, call propose_skill so the user can save it as a private draft for "
        "review. Do not write skill files anywhere else as a workaround."
    )

    @staticmethod
    def _catalog_path(file_path: str) -> str:
        normalized = "/" + str(file_path or "").strip().replace("\\", "/").lstrip("/")
        return normalized if normalized.startswith("/skills/") else "/skills" + normalized

    def _refusal(self, operation: str, file_path: str) -> str:
        return self._MESSAGE.format(operation=operation, path=self._catalog_path(file_path))

    def write(self, file_path: str, content: str) -> WriteResult:
        return WriteResult(error=self._refusal("write", file_path))

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        return EditResult(error=self._refusal("edit", file_path))

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return [FileUploadResponse(path=path, error=self._refusal("upload", path)) for path, _ in files]


class ScopedSkillsBackend(ReadOnlySkillsBackend):
    """/skills/ as this user's skills only: each one read from the package it loads.

    The plain route exposed the whole catalog: every team's skills whatever their
    grants, and .governed-versions/, which holds every governed version and other
    users' private drafts. It also served a pinned version's or a draft's support
    files from the mutable default folder, because load_skill names them
    /skills/<id>/<file> while the package lives under .governed-versions.

    A path resolves to a skill by its longest leading segment run that is a skill ID,
    so /skills/data/analyze/x is the data/analyze skill, not a file of data. That skill
    must pass is_skill_allowed, and its files come from find_skill_for_context: the
    same package load_skill used, pin or draft included. Anything else, including any
    dot-folder, reads as not found. Writes stay refused (ReadOnlySkillsBackend).
    """

    def __init__(self, *, workspace_state: WorkspaceState, root_dir: str, **kwargs: Any) -> None:
        super().__init__(root_dir=root_dir, **kwargs)
        self.workspace_state = workspace_state
        self.skills_root = Path(root_dir)
        self._resolved: dict[str, SkillMetadata | None] = {}
        self._package_backends: dict[str, FilesystemBackend] = {}

    # -- resolution -----------------------------------------------------------------
    def _context(self) -> dict[str, Any] | None:
        context = self.workspace_state.context
        return context if isinstance(context, dict) else None

    def _is_catalog_skill(self, skill_id: str) -> bool:
        return (self.skills_root / skill_id / "SKILL.md").is_file()

    def _allowed_skill(self, skill_id: str) -> SkillMetadata | None:
        if skill_id not in self._resolved:
            skill = None
            if is_skill_allowed(skill_id, self._context()):
                found = find_skill_for_context(self.skills_root, skill_id, self._context())
                # find_skill_for_context also matches display names; a path must name the ID.
                if found is not None and found.skill_id == skill_id:
                    skill = found
            self._resolved[skill_id] = skill
        return self._resolved[skill_id]

    def _allowed_skill_ids(self) -> list[str]:
        context = self._context()
        allowed = context.get("skill_allow_ids") if context else None
        if isinstance(allowed, list):
            candidates = [str(item).strip() for item in allowed if str(item).strip()]
        else:
            candidates = [skill.skill_id for skill in load_skills(self.skills_root)]
        return sorted({skill_id for skill_id in candidates if self._allowed_skill(skill_id) is not None})

    @staticmethod
    def _segments(path: str | None) -> list[str]:
        return [part for part in str(path or "").replace("\\", "/").split("/") if part]

    def _resolve(self, path: str | None) -> tuple[SkillMetadata, str] | None:
        """Map a route path to (skill, path inside its package), or None."""
        segments = self._segments(path)
        if not segments or any(part.startswith(".") or part == ".." for part in segments):
            return None
        for length in range(len(segments), 0, -1):
            skill_id = "/".join(segments[:length])
            skill = self._allowed_skill(skill_id)
            if skill is not None:
                return skill, "/" + "/".join(segments[length:])
            if self._is_catalog_skill(skill_id):
                return None  # the deepest skill on this path is not available to this user
        return None

    def _package_backend(self, skill: SkillMetadata) -> FilesystemBackend:
        root = str(skill.path.parent.resolve())
        if root not in self._package_backends:
            self._package_backends[root] = FilesystemBackend(root_dir=root, virtual_mode=True)
        return self._package_backends[root]

    def _visible(self, skill: SkillMetadata, inner_path: str) -> bool:
        """Hide dot-entries and nested skills this user may not open."""
        segments = self._segments(inner_path)
        if any(part.startswith(".") for part in segments):
            return False
        for length in range(1, len(segments) + 1):
            nested = skill.skill_id + "/" + "/".join(segments[:length])
            if self._is_catalog_skill(nested) and self._allowed_skill(nested) is None:
                return False
        return True

    def _outer(self, skill: SkillMetadata, inner_path: str) -> str:
        return f"/{skill.skill_id}/{inner_path.lstrip('/')}"

    def _remap(self, skill: SkillMetadata, entries: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
        mapped = []
        for entry in entries or []:
            inner = str(entry.get("path") or "")
            if self._visible(skill, inner):
                mapped.append({**entry, "path": self._outer(skill, inner)})
        return mapped

    def _scope_roots(self, path: str | None) -> list[tuple[SkillMetadata, str]] | None:
        """Skills a search at *path* covers: one resolved skill, or every allowed one below a prefix."""
        resolved = self._resolve(path)
        if resolved is not None:
            return [resolved]
        prefix = self._segments(path)
        roots = []
        for skill_id in self._allowed_skill_ids():
            if self._segments(skill_id)[: len(prefix)] == prefix:
                skill = self._allowed_skill(skill_id)
                if skill is not None:
                    roots.append((skill, "/"))
        return roots or None

    @staticmethod
    def _not_found(path: str | None) -> str:
        return f"Path '/skills/{str(path or '').lstrip('/')}' not found"

    # -- read side ------------------------------------------------------------------
    def ls(self, path: str) -> LsResult:
        resolved = self._resolve(path)
        if resolved is not None:
            skill, inner = resolved
            result = self._package_backend(skill).ls(inner if inner.endswith("/") else inner + "/")
            if result.error:
                return LsResult(error=self._not_found(path))
            return LsResult(entries=self._remap(skill, result.entries))
        # A prefix of allowed IDs, such as "/" or "/data/" when only data/analyze is allowed.
        prefix = self._segments(path)
        children = sorted({
            self._segments(skill_id)[len(prefix)]
            for skill_id in self._allowed_skill_ids()
            if len(self._segments(skill_id)) > len(prefix) and self._segments(skill_id)[: len(prefix)] == prefix
        })
        if not children:
            return LsResult(error=self._not_found(path))
        base = "/" + "/".join(prefix) + "/" if prefix else "/"
        return LsResult(entries=[{"path": f"{base}{child}/", "is_dir": True} for child in children])

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        resolved = self._resolve(file_path)
        if resolved is None or not self._visible(*resolved):
            return ReadResult(error=f"File '/skills/{str(file_path or '').lstrip('/')}' not found")
        skill, inner = resolved
        return self._package_backend(skill).read(inner, offset, limit)

    def glob(self, pattern: str, path: str = "/") -> GlobResult:
        roots = self._scope_roots(path)
        if roots is None:
            return GlobResult(error=self._not_found(path))
        matches: list[dict[str, Any]] = []
        for skill, inner in roots:
            result = self._package_backend(skill).glob(pattern, inner)
            if not result.error:
                matches.extend(self._remap(skill, result.matches))
        return GlobResult(matches=matches)

    def grep(self, pattern: str, path: str | None = None, glob: str | None = None) -> GrepResult:
        roots = self._scope_roots(path or "/")
        if roots is None:
            return GrepResult(error=self._not_found(path))
        matches: list[dict[str, Any]] = []
        for skill, inner in roots:
            result = self._package_backend(skill).grep(pattern, inner, glob)
            if result.error:
                return GrepResult(error=result.error)  # an invalid pattern, reported once
            matches.extend(self._remap(skill, result.matches))
        return GrepResult(matches=matches)

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        responses: list[FileDownloadResponse] = []
        for path in paths:
            resolved = self._resolve(path)
            if resolved is None or not self._visible(*resolved):
                responses.append(FileDownloadResponse(path=path, content=None, error="file_not_found"))
                continue
            skill, inner = resolved
            response = self._package_backend(skill).download_files([inner])[0]
            responses.append(FileDownloadResponse(path=path, content=response.content, error=response.error))
        return responses


class SkillScopedFilesystemBackend(FilesystemBackend):
    """Keep structured source rows out of a Data Analytics model context."""

    def __init__(self, *, workspace_state: WorkspaceState, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.workspace_state = workspace_state

    def _data_skill_context(self) -> tuple[bool, dict[str, Any]]:
        context = self.workspace_state.context if isinstance(self.workspace_state.context, dict) else {}
        skill_id = str(context.get("active_skill") or "").strip()
        return skill_id == "data" or skill_id.startswith("data/"), context

    def _workspace_write_error(self, operation: str, file_path: str) -> str | None:
        context = self.workspace_state.context if isinstance(self.workspace_state.context, dict) else {}
        virtual_path = self._virtual_path(file_path)
        if (
            str(context.get("active_skill") or "").strip() == "research"
            and virtual_path == PurePosixPath("/final-research-report.md")
            and int(context.get("google_search_source_count", 0) or 0) < 1
        ):
            return (
                f"Cannot {operation} '{file_path}' because this research run has no verified Google Search sources. "
                "Stop and report that live web research is unavailable; do not create a sourced report from model memory."
            )
        protected = context.get("protected_file_paths")
        if isinstance(protected, (list, tuple, set)) and protected:
            relative = str(virtual_path).lstrip("/")
            if relative in {str(item).strip().lstrip("/") for item in protected}:
                return (
                    f"Cannot {operation} '{file_path}' because it is approved or published. "
                    "Signed-off files are read-only. Say so and leave it unchanged, or ask an "
                    "owner or publisher to send it back to review first."
                )
        is_published = context.get("workspace_mode") == "published_read_only"
        write_denied = context.get("can_write_workspace") is False
        if not (is_published or write_denied):
            return None
        if is_published:
            return (
                f"Cannot {operation} '{file_path}' in a published workspace. "
                "Use the published workspace for analysis or edit its Working version."
            )
        return (
            f"Cannot {operation} '{file_path}' with the current workspace access or editing policy. "
            "Ask an owner to grant edit access or review the proposed change."
        )

    def write(self, file_path: str, content: str) -> WriteResult:
        if _is_internal_agent_path(file_path):
            return WriteResult(error=f"Cannot write '{file_path}': reserved system path.")
        error = self._workspace_write_error("write", file_path)
        if error:
            return WriteResult(error=error)
        return super().write(file_path, content)

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        error = self._workspace_write_error("edit", file_path)
        if error:
            return EditResult(error=error)
        return super().edit(file_path, old_string, new_string, replace_all)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        responses: list[FileUploadResponse] = []
        allowed_files: list[tuple[str, bytes]] = []
        for file_path, content in files:
            error = self._workspace_write_error("upload", file_path)
            if error:
                responses.append(FileUploadResponse(path=file_path, error=error))
            else:
                allowed_files.append((file_path, content))
        if allowed_files:
            responses.extend(super().upload_files(allowed_files))
        return responses

    @staticmethod
    def _virtual_path(file_path: str) -> PurePosixPath:
        normalized = str(file_path or "").strip().replace("\\", "/")
        return PurePosixPath("/" + normalized.lstrip("/"))

    def _data_path_is_visible(self, file_path: str, context: dict[str, Any]) -> bool:
        virtual_path = self._virtual_path(file_path)
        top_level = virtual_path.parts[1] if len(virtual_path.parts) > 1 else ""
        if top_level == "sandbox-runs" and len(virtual_path.parts) > 2:
            current_run_ids = {
                str(item).strip()
                for item in context.get("_current_sandbox_run_ids") or []
                if str(item).strip()
            }
            return virtual_path.parts[2] in current_run_ids
        if top_level in {"charts", "dashboards", "reports"} and len(virtual_path.parts) > 2:
            tagged_files = {
                str(item).strip().replace("\\", "/").lstrip("/")
                for item in context.get("tagged_files") or []
                if str(item).strip()
            }
            normalized = str(file_path or "").strip().replace("\\", "/").lstrip("/")
            return normalized in tagged_files
        return True

    def ls(self, path: str) -> LsResult:
        if _is_internal_agent_path(path):
            return LsResult(entries=[])
        result = super().ls(path)
        if result.entries:
            result = LsResult(
                error=result.error,
                entries=[
                    entry
                    for entry in result.entries
                    if not _is_internal_agent_path(entry.get("path"))
                ],
            )
        is_data_skill, context = self._data_skill_context()
        if not is_data_skill or not result.entries:
            return result
        if not self._data_path_is_visible(path, context):
            return LsResult(entries=[])
        return LsResult(
            error=result.error,
            entries=[
                entry
                for entry in result.entries
                if self._data_path_is_visible(str(entry.get("path") or ""), context)
            ],
        )

    def glob(self, pattern: str, path: str = "/") -> GlobResult:
        result = super().glob(pattern, path=path)
        if result.matches:
            result = GlobResult(
                error=result.error,
                matches=[
                    match
                    for match in result.matches
                    if not _is_internal_agent_path(match.get("path"))
                ],
            )
        is_data_skill, context = self._data_skill_context()
        if not is_data_skill or not result.matches:
            return result
        return GlobResult(
            error=result.error,
            matches=[
                match
                for match in result.matches
                if self._data_path_is_visible(str(match.get("path") or ""), context)
            ],
        )

    def grep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
    ) -> GrepResult:
        result = super().grep(pattern, path=path, glob=glob)
        if result.matches:
            result = GrepResult(
                error=result.error,
                matches=[
                    match
                    for match in result.matches
                    if not _is_internal_agent_path(match.get("path"))
                ],
            )
        is_data_skill, context = self._data_skill_context()
        if not is_data_skill or not result.matches:
            return result
        visible_matches = []
        for match in result.matches:
            match_path = str(match.get("path") or "")
            virtual_path = self._virtual_path(match_path)
            top_level = virtual_path.parts[1] if len(virtual_path.parts) > 1 else ""
            if (
                virtual_path.suffix.lower() in _STRUCTURED_DATA_SUFFIXES
                and top_level not in _DATA_ARTIFACT_OUTPUT_DIRS
            ):
                continue
            if self._data_path_is_visible(match_path, context):
                visible_matches.append(match)
        return GrepResult(error=result.error, matches=visible_matches)

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        if _is_internal_agent_path(file_path):
            return ReadResult(
                error=(
                    f"Read blocked for '{file_path}'. This path holds product-managed "
                    "storage (file version history, knowledge bundles, archived packs), "
                    "not workspace documents."
                )
            )
        is_data_skill, context = self._data_skill_context()
        skill_id = str(context.get("active_skill") or "").strip()
        normalized = str(file_path or "").strip().replace("\\", "/")
        virtual_path = self._virtual_path(file_path)
        top_level = virtual_path.parts[1] if len(virtual_path.parts) > 1 else ""
        if (
            is_data_skill
            and top_level == "sandbox-runs"
            and len(virtual_path.parts) > 2
        ):
            current_run_ids = {
                str(item).strip()
                for item in context.get("_current_sandbox_run_ids") or []
                if str(item).strip()
            }
            sandbox_run_id = virtual_path.parts[2]
            if sandbox_run_id not in current_run_ids:
                return ReadResult(
                    error=(
                        f"Prior sandbox artifact read blocked for '{normalized}'. "
                        "Data Analytics may read only sandbox outputs created during "
                        "the current top-level task."
                    )
                )
        if (
            is_data_skill
            and top_level in {"charts", "dashboards", "reports"}
            and virtual_path.suffix.lower() in _STRUCTURED_DATA_SUFFIXES
        ):
            tagged_files = {
                str(item).strip().replace("\\", "/").lstrip("/")
                for item in context.get("tagged_files") or []
                if str(item).strip()
            }
            relative_path = normalized.lstrip("/")
            if relative_path not in tagged_files:
                return ReadResult(
                    error=(
                        f"Untagged prior artifact read blocked for '{normalized}'. "
                        "Data Analytics may not reuse prior chart, dashboard, or report "
                        "artifacts unless the user explicitly tags that artifact."
                    )
                )
        if (
            is_data_skill
            and virtual_path.suffix.lower() in _STRUCTURED_DATA_SUFFIXES
            and top_level not in _DATA_ARTIFACT_OUTPUT_DIRS
        ):
            return ReadResult(
                error=(
                    f"Structured data read blocked for '{normalized}' while Data Analytics skill "
                    f"'{skill_id}' is active. Use run_skill_python_script with the declared "
                    "'data_workspace' script for schema, profile, and bounded SQL queries instead "
                    "of paging raw rows into model context."
                )
            )
        return super().read(file_path, offset=offset, limit=limit)


def _normalize_mcp_candidate_servers(server_names: Any) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_name in server_names or []:
        name = str(raw_name or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        normalized.append(name)
    return normalized


def _include_always_available_tool_groups(
    tool_names: list[str],
    configured_tools: Dict[str, Any],
) -> list[str]:
    resolved = list(tool_names)
    for name in ALWAYS_AVAILABLE_TOOL_GROUPS:
        if name in configured_tools and name not in resolved:
            resolved.append(name)
    return resolved


def _runtime_tool_names(
    skill_tool_names: list[str],
    configured_tools: Dict[str, Any],
    *,
    persona: str,
    proposals_enabled: bool,
) -> list[str]:
    """Tools bound for a run, before the sandbox and search switches.

    Skills that declare tools narrow the set; when none do, every configured tool is
    bound. The persona's denials come after both, because either step can add a tool
    back: the all-tools fallback returned write_file to the Skill Creator, and the
    always-available groups would return propose_skill.
    """
    if not skill_tool_names:
        names = list(configured_tools.keys())
    else:
        names = _include_always_available_tool_groups(skill_tool_names, configured_tools)
    if persona == SKILL_BUILDER_PERSONA:
        names = [name for name in names if name not in SKILL_BUILDER_DENIED_TOOLS]
    if not proposals_enabled:
        names = [name for name in names if name != "propose_skill"]
    return names


def _clone_preservable_context(context: Dict[str, Any] | None) -> Dict[str, Any]:
    cloned: Dict[str, Any] = {}
    for key, value in (context or {}).items():
        try:
            cloned[key] = deepcopy(value)
        except Exception as exc:  # pragma: no cover - defensive
            logger.info(
                "Skipping non-copyable workspace context key during runtime reuse: %s (%s)",
                key,
                exc,
            )
    return cloned


class AgentRegistry:
    """Caches DeepAgents keyed by (agent_name, workspace_id)."""

    def __init__(self, settings: Settings, tool_factory: ToolFactory, memory_store=None):
        self.settings = settings
        self.tool_factory = tool_factory
        self._memory_store = memory_store
        self._models: Dict[str, object] = {}
        self._checkpointer = MemorySaver()
        self._cache: Dict[Tuple[str, str, str], AgentRuntimeState] = {}
        self._default_agent_name = "general-assistant"

    def _resolve_persona(self, agent_name: str) -> str:
        """Which system prompt this run gets.

        Separate from `_resolve_mode`, which picks a model tier and collapses every
        unrecognised name to "fast". Folding the persona into that would have tied the
        Skill Creator to one model for the wrong reason.
        """
        name = (agent_name or "").strip().lower()
        if name == SKILL_BUILDER_PERSONA or name.startswith(f"{SKILL_BUILDER_PERSONA}:"):
            return SKILL_BUILDER_PERSONA
        return "general"

    def _resolve_mode(self, agent_name: str) -> str:
        name = (agent_name or "").strip().lower()
        if name.endswith(":pro") or name.endswith("-pro"):
            return "pro"
        if name.endswith(":lite") or name.endswith("-lite"):
            return "lite"
        if name.endswith(":fast") or name.endswith("-fast"):
            return "fast"
        if name in {"pro", "gemini-pro", "general-assistant-pro"}:
            return "pro"
        if name in {"lite", "gemini-lite", "general-assistant-lite", "flash-lite"}:
            return "lite"
        if name in {"fast", "flash", "general-assistant"}:
            return "fast"
        return "fast"

    def _get_model(
        self,
        model_name: str,
        *,
        thinking_level: str | None = None,
        max_output_tokens: int | None = None,
    ):
        cache_key = json.dumps(
            {
                "model": model_name,
                "thinking_level": thinking_level,
                "max_output_tokens": max_output_tokens,
            },
            sort_keys=True,
        )
        model = self._models.get(cache_key)
        if model is not None:
            return model
        cfg = self.settings.model
        model = create_chat_google_generative_ai(
            cfg,
            model_name,
            thinking_level=thinking_level or None,
            max_output_tokens=max_output_tokens or None,
        )
        self._models[cache_key] = model
        return model

    async def get_or_create(
        self,
        agent_name: str,
        workspace_id: str,
        initial_context: Dict[str, Any] | None = None,
    ) -> AgentRuntimeState:
        mode = self._resolve_mode(agent_name)
        model_name = self.settings.model.resolve_chat_model_name(mode)
        thinking_level = self.settings.model.resolve_thinking_level(mode)
        max_output_tokens = self.settings.model.resolve_max_output_tokens(mode)
        persona = self._resolve_persona(agent_name)
        # Part of the cache key via `resolved_name`: two personas in one workspace would
        # otherwise share a runtime, and the first one created would lend the second its
        # system prompt.
        resolved_name = (
            f"{self._default_agent_name}:{mode}"
            if persona == "general"
            else f"{self._default_agent_name}:{persona}:{mode}"
        )
        context_payload = initial_context or {}
        policy_key = json.dumps(context_payload.get("mcp_policy", {}) or {}, sort_keys=True, default=str)
        mcp_auth_fingerprint = str(context_payload.get("mcp_auth_fingerprint") or "")
        internet_search_key = "search:on" if context_payload.get("internet_search_enabled") else "search:off"
        skill_sandbox_key = (
            "sandbox:on"
            if (
                context_payload.get("allow_skill_sandbox")
                or context_payload.get("allowSkillSandbox")
                or context_payload.get("allow_script_runner")
                or context_payload.get("allowScriptRunner")
            )
            else "sandbox:off"
        )
        user_key = str(context_payload.get("user_id") or "")
        cache_scope_prefix = f"{user_key}:{policy_key}:"
        key = (
            resolved_name,
            workspace_id,
            f"{user_key}:{policy_key}:{mcp_auth_fingerprint}:{internet_search_key}:{skill_sandbox_key}",
        )
        preserved_context: Dict[str, Any] = {}
        if key in self._cache:
            runtime = self._cache[key]
            prospective_context = _clone_preservable_context(runtime.workspace_state.context)
            if context_payload:
                prospective_context.update(context_payload)
            desired_candidates = _normalize_mcp_candidate_servers(
                get_candidate_mcp_servers(
                    prospective_context.get("active_skill_scope"),
                    preferred_server=prospective_context.get("preferred_mcp_server"),
                )
            )
            bound_candidates = _normalize_mcp_candidate_servers(
                runtime.workspace_state.context.get("_bound_mcp_candidates") or []
            )
            if desired_candidates == bound_candidates:
                if context_payload:
                    runtime.workspace_state.context.update(context_payload)
                return runtime
            preserved_context = prospective_context
            self._cache.pop(key, None)

        # Prevent unbounded growth when delegated auth fingerprints rotate over time.
        stale_keys = [
            cache_key
            for cache_key in self._cache.keys()
            if cache_key[0] == resolved_name
            and cache_key[1] == workspace_id
            and str(cache_key[2]).startswith(cache_scope_prefix)
            and cache_key != key
        ]
        for stale_key in stale_keys:
            stale_runtime = self._cache.pop(stale_key, None)
            if stale_runtime is not None and not preserved_context:
                # Preserve in-flight thread/skill state when delegated auth refreshes.
                preserved_context = _clone_preservable_context(stale_runtime.workspace_state.context)

        workspace_base = self.settings.backend.workspace_root
        workspace_base.mkdir(parents=True, exist_ok=True)
        workspace_root = workspace_base / workspace_id
        workspace_root.mkdir(parents=True, exist_ok=True)
        workspace_state = WorkspaceState(workspace_id=workspace_id, root_path=workspace_root)
        if preserved_context:
            workspace_state.context.update(preserved_context)
        if context_payload:
            workspace_state.context.update(context_payload)
        allow_skill_sandbox = bool(
            context_payload.get("allow_skill_sandbox")
            or context_payload.get("allowSkillSandbox")
            or context_payload.get("allow_script_runner")
            or context_payload.get("allowScriptRunner")
        )
        system_prompt = (
            SKILL_BUILDER_SYSTEM_PROMPT if persona == SKILL_BUILDER_PERSONA else GENERAL_SYSTEM_PROMPT
        )
        if persona != SKILL_BUILDER_PERSONA and workspace_skill_proposals_enabled():
            system_prompt += SKILL_PROPOSAL_PROMPT
        if (
            workspace_state.context.get("workspace_mode") == "published_read_only"
            or workspace_state.context.get("can_write_workspace") is False
        ):
            system_prompt += (
                "\n\nThis workspace is read-only for the current role or editing policy. You may inspect and analyze its content, "
                "but you must not create, edit, upload, or generate workspace files. If the user wants "
                "content changes or generated artifacts, explain that an owner must grant edit access "
                "or review the proposed change."
            )
        protected_paths = workspace_state.context.get("protected_file_paths")
        if isinstance(protected_paths, (list, tuple)) and protected_paths:
            listed = ", ".join(str(item) for item in list(protected_paths)[:20])
            more = "" if len(protected_paths) <= 20 else f" (and {len(protected_paths) - 20} more)"
            system_prompt += (
                "\n\nThese workspace files are approved or published and are read-only: "
                f"{listed}{more}. Do not create, edit or overwrite them. If the user asks for a "
                "change to one, explain that it is signed off and an owner or publisher must send "
                "it back to review first, then stop."
            )
        system_prompt += build_bigquery_defaults_prompt()
        skills_root = self.settings.backend.skills_root
        if skills_root is not None:
            # The agent container mounts the skills volume read-only; create the folder
            # only on a fresh local checkout.
            if not skills_root.exists():
                skills_root.mkdir(parents=True, exist_ok=True)
            if self.settings.backend.sync_skills_to_workspace:
                sync_skills_to_workspace(skills_root, workspace_state.root_path)
        skills = load_skills(skills_root) if skills_root is not None else []
        tool_names = collect_tool_names(skills, plugins_root=self.settings.backend.plugins_root)
        if tool_names:
            tool_names = [name for name in tool_names if name in self.settings.tools]
        tool_names = _runtime_tool_names(
            tool_names,
            self.settings.tools,
            persona=persona,
            proposals_enabled=workspace_skill_proposals_enabled(),
        )
        if not allow_skill_sandbox:
            tool_names = [name for name in tool_names if name != "run_skill_python_script"]
        if allow_skill_sandbox and "run_skill_python_script" in self.settings.tools and "run_skill_python_script" not in tool_names:
            tool_names.append("run_skill_python_script")
        if workspace_state.context.get("internet_search_enabled"):
            if "google_search" in self.settings.tools and "google_search" not in tool_names:
                tool_names.append("google_search")
            if "url_context" in self.settings.tools and "url_context" not in tool_names:
                tool_names.append("url_context")

        builtin_tools = [
            GuardedTool.from_tool(tool, workspace_state=workspace_state)
            for tool in self.tool_factory.build_tools(tool_names, workspace_state)
            if tool is not None
        ]

        active_skill = workspace_state.context.get("active_skill_scope")
        preferred_mcp_server = workspace_state.context.get("preferred_mcp_server")
        candidate_mcp_servers = get_candidate_mcp_servers(
            active_skill,
            preferred_server=str(preferred_mcp_server or "").strip() or None,
        )
        mcp_manager = MCPServerManager(self.settings, workspace_state)
        logger.info(
            "MCP bind candidates resolved (workspace=%s active_skill=%s allowed_by_skill=%s preferred=%s)",
            workspace_id,
            (active_skill or {}).get("skill_id") if isinstance(active_skill, dict) else None,
            candidate_mcp_servers,
            preferred_mcp_server,
        )
        await mcp_manager.initialize(
            candidate_server_names=candidate_mcp_servers,
            preflight_gemini=self.settings.model.provider == "gemini",
        )
        preferred_server = workspace_state.context.get("preferred_mcp_server")
        normalized_preferred = str(preferred_server).strip() if isinstance(preferred_server, str) else ""
        bound_servers = list(mcp_manager.get_tools_by_server().keys())
        workspace_state.context["preferred_mcp_server_bound"] = bool(
            normalized_preferred and normalized_preferred in bound_servers
        )
        workspace_state.context["_bound_mcp_candidates"] = list(candidate_mcp_servers)
        mcp_tools = []
        for server_name, server_tools in mcp_manager.get_tools_by_server().items():
            for tool in server_tools:
                mcp_tools.append(
                    GuardedTool.from_tool(
                        tool,
                        workspace_state=workspace_state,
                        tool_mcp_server=server_name,
                    )
                )

        logger.info(
            "MCP bind results (workspace=%s active_skill=%s allowed_by_rbac=%s accepted=%s rejected=%s)",
            workspace_id,
            (active_skill or {}).get("skill_id") if isinstance(active_skill, dict) else None,
            mcp_manager.get_allowed_server_names(),
            list(mcp_manager.get_tools_by_server().keys()),
            mcp_manager.get_rejected_servers(),
        )
        tools = builtin_tools + mcp_tools
        def make_backend(runtime) -> CompositeBackend:
            routes = {
                "/memories/": UserScopedStoreBackend(
                    runtime,
                    store=self._memory_store.store if self._memory_store is not None else None,
                ),
            }
            if skills_root is not None:
                routes["/skills/"] = ScopedSkillsBackend(
                    workspace_state=workspace_state,
                    root_dir=str(skills_root),
                    virtual_mode=True,
                )
            return CompositeBackend(
                default=SkillScopedFilesystemBackend(
                    workspace_state=workspace_state,
                    root_dir=str(workspace_state.root_path),
                    virtual_mode=self.settings.backend.virtual_mode,
                ),
                routes=routes,
            )

        model = self._get_model(
            model_name,
            thinking_level=thinking_level,
            max_output_tokens=max_output_tokens,
        )
        interrupt_on = dict(self.settings.backend.interrupt_on or {})
        # request_plan_approval uses HelpUDoc's explicit interrupt tool so it can
        # coexist with clarification/action resume payloads in the same graph.
        interrupt_on.pop("request_plan_approval", None)
        interrupt_on = {name: config for name, config in interrupt_on.items() if config}

        middleware = [
            TodoListMiddleware(),
            FilesystemMiddleware(backend=make_backend),
            SummarizationMiddleware(
                model=model,
                max_tokens_before_summary=170000,
                messages_to_keep=6,
            ),
            PatchToolCallsMiddleware(),
        ]
        code_interpreter = self.settings.backend.code_interpreter
        if code_interpreter.enabled:
            middleware.append(
                CodeInterpreterMiddleware(
                    tool_name=code_interpreter.tool_name,
                    memory_limit=code_interpreter.memory_limit_bytes,
                    timeout=code_interpreter.timeout_seconds,
                    max_ptc_calls=code_interpreter.max_ptc_calls,
                    max_result_chars=code_interpreter.max_result_chars,
                    ptc=code_interpreter.ptc_tools,
                    snapshot_between_turns=code_interpreter.snapshot_between_turns,
                    max_snapshot_bytes=code_interpreter.max_snapshot_bytes,
                )
            )
            logger.info(
                "Code interpreter enabled (workspace=%s ptc_tools=%s)",
                workspace_id,
                code_interpreter.ptc_tools,
            )
        if interrupt_on:
            middleware.append(HumanInTheLoopMiddleware(interrupt_on=interrupt_on))
        middleware.append(InteractionContractMiddleware(enabled=True))
        if self.settings.backend.implicit_input_guard:
            middleware.append(ImplicitInputGuardMiddleware(enabled=True))

        full_prompt = system_prompt + "\n\n" + BASE_AGENT_PROMPT if system_prompt else BASE_AGENT_PROMPT
        agent = create_agent(
            model=model,
            tools=tools,
            system_prompt=full_prompt,
            middleware=middleware,
            checkpointer=self._checkpointer,
            store=self._memory_store.store if self._memory_store is not None else None,
        ).with_config({"recursion_limit": int(self.settings.backend.recursion_limit)})

        runtime = AgentRuntimeState(agent_name=resolved_name, workspace_state=workspace_state, agent=agent)
        self._cache[key] = runtime
        return runtime

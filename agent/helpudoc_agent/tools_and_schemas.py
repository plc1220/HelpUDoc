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
from typing import Callable, Dict, List, Optional
from uuid import uuid4

from langchain_core.tools import tool
from langchain_core.tools import Tool

try:
    import vertexai
    from google import genai
    from google.genai.types import GenerateContentConfig, HttpOptions, ImageConfig, Modality
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise RuntimeError("Gemini dependencies are required") from exc

from .configuration import Settings, ToolConfig
from .skills_registry import SkillPolicy, load_skills
from .rag_indexer import RagConfig, WorkspaceRagStore
from .state import WorkspaceState
from .utils import SourceTracker, extract_web_url

logger = logging.getLogger(__name__)


def _get_active_skill_policy(workspace_state: WorkspaceState) -> SkillPolicy:
    raw = workspace_state.context.get("active_skill_policy")
    if isinstance(raw, SkillPolicy):
        return raw
    if isinstance(raw, dict):
        return SkillPolicy(
            requires_hitl_plan=bool(raw.get("requires_hitl_plan")),
            requires_workspace_artifacts=bool(raw.get("requires_workspace_artifacts")),
            required_artifacts_mode=str(raw.get("required_artifacts_mode") or "") or None,
            required_artifacts=list(raw.get("required_artifacts") or []) or None,
        )
    return SkillPolicy()


def _is_plan_approved(workspace_state: WorkspaceState) -> bool:
    return bool(workspace_state.context.get("plan_approved"))


def _plan_gate_message() -> str:
    return (
        "Plan approval required before execution. "
        "Call request_plan_approval with title, summary, and checklist first."
    )


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
            "append_to_report": self._build_append_to_report_tool,
            "get_image_url": self._build_get_image_url_tool,
            "rag_query": self._build_rag_query_tool,
            "list_skills": self._build_list_skills_tool,
            "load_skill": self._build_load_skill_tool,
            "request_plan_approval": self._build_request_plan_approval_tool,
        }

    def build_tools(self, tool_names: List[str], workspace_state: WorkspaceState) -> List[Tool]:
        tools: List[Tool] = []
        for name in tool_names:
            config = self.settings.get_tool(name)
            built = self._build_tool(config, workspace_state)
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
        module = import_module(module_path)
        factory = getattr(module, attr)
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

    def _build_list_skills_tool(self, workspace_state: WorkspaceState) -> Tool:
        """List available skills from the shared skills registry."""
        skills_root = self.settings.backend.skills_root

        @tool
        def list_skills() -> str:
            """List available skills and their descriptions."""
            if workspace_state.context.get("tagged_files_only"):
                return "Tool disabled: tagged files were provided, use rag_query only."
            if skills_root is None or not skills_root.exists():
                return "No skills directory configured."
            skills = load_skills(skills_root)
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
            if workspace_state.context.get("tagged_files_only"):
                return "Tool disabled: tagged files were provided, use rag_query only."
            if skills_root is None or not skills_root.exists():
                return "No skills directory configured."
            skills = load_skills(skills_root)
            if not skills:
                return "No skills found."
            normalized = skill_id.strip()
            for skill in skills:
                if normalized in {skill.skill_id, skill.name}:
                    try:
                        content = skill.path.read_text(encoding="utf-8")
                    except Exception as exc:  # pragma: no cover - filesystem guard
                        return f"Failed to read skill '{skill.skill_id}': {exc}"
                    workspace_state.context["active_skill"] = skill.skill_id
                    workspace_state.context["active_skill_policy"] = {
                        "requires_hitl_plan": skill.policy.requires_hitl_plan,
                        "requires_workspace_artifacts": skill.policy.requires_workspace_artifacts,
                        "required_artifacts_mode": skill.policy.required_artifacts_mode,
                        "required_artifacts": skill.policy.required_artifacts or [],
                    }
                    # Reset plan approval each time a new skill is loaded.
                    workspace_state.context["plan_approved"] = False
                    return f"Loaded skill: {skill.skill_id}\n\n{content}"
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
            plan_summary: str,
            execution_checklist: str,
            risky_actions: str = "None",
        ) -> str:
            """Request human approval/edit/rejection for a proposed execution plan."""
            if workspace_state.context.get("tagged_files_only"):
                return "Tool disabled: tagged files were provided, use rag_query only."

            title = (plan_title or "").strip()
            summary = (plan_summary or "").strip()
            checklist = (execution_checklist or "").strip()
            risks = (risky_actions or "").strip()

            if not title:
                return "Plan approval blocked: plan_title is required."
            if not summary:
                return "Plan approval blocked: plan_summary is required."
            if not checklist:
                return "Plan approval blocked: execution_checklist is required."

            workspace_state.context["plan_approved"] = True

            return (
                "PLAN_APPROVAL_RECORDED\n"
                f"Title: {title}\n"
                f"Summary: {summary}\n"
                f"Execution checklist: {checklist}\n"
                f"Risky actions: {risks}\n"
                "Plan decision has been applied. Continue executing the approved plan."
            )

        request_plan_approval.name = "request_plan_approval"
        request_plan_approval.description = (
            "Ask human to approve, edit, or reject a proposed plan before execution."
        )
        return request_plan_approval

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
            if workspace_state.context.get("tagged_files_only"):
                return "Tool disabled: tagged files were provided, use rag_query only."
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
            if workspace_state.context.get("tagged_files_only"):
                return "Tool disabled: tagged files were provided, use rag_query only."
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
            if cached_context and workspace_state.context.get("tagged_files_only"):
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
                normalized_basenames = {Path(item).name for item in normalized if item}
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
        if workspace_state.context.get("tagged_files_only"):
            return "Tool disabled: tagged files were provided, use rag_query only."
        policy = _get_active_skill_policy(workspace_state)
        if policy.requires_hitl_plan and not _is_plan_approved(workspace_state):
            return _plan_gate_message()

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

        if workspace_state.context.get("tagged_files_only"):
            return "Tool disabled: tagged files were provided, use rag_query only."

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

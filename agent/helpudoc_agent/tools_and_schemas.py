"""Tool creation helpers and MCP integration stubs."""
from __future__ import annotations

import json
import os
import re
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
    from google.genai.types import GenerateContentConfig, ImageConfig, Modality
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise RuntimeError("Gemini dependencies are required") from exc

from .configuration import Settings, ToolConfig
from .rag_indexer import RagConfig, WorkspaceRagStore
from .state import WorkspaceState
from .utils import SourceTracker, resolve_urls, extract_web_url


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

        self.client = genai.Client(**client_kwargs)
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
            client=self.gemini_manager.client,
            model_name=self.gemini_manager.model_name,
        )

    def _build_gemini_image_tool(self, workspace_state: WorkspaceState) -> Tool:
        return build_gemini_image_tool(
            workspace_state=workspace_state,
            client=self.gemini_manager.client,
            model_name=self.gemini_manager.image_model_name,
        )

    def _build_google_grounded_search_tool(self, workspace_state: WorkspaceState) -> Tool:
        """Grounded search that also records sources for final reporting."""
        client = self.gemini_manager.client
        model_name = self.gemini_manager.model_name
        tracker = self.source_tracker

        @tool
        def google_grounded_search(query: str) -> str:
            """Run a Gemini search with citations and store sources."""
            if workspace_state.context.get("tagged_files_only"):
                return "Tool disabled: tagged files were provided, use rag_query only."
            search_prompt = (
                f"Search the web for information about: {query}\n\n"
                "Return a comprehensive summary of the search results."
            )
            response = client.models.generate_content(
                model=model_name,
                contents=search_prompt,
                config={
                    "tools": [{"google_search": {}}],
                    "temperature": 0,
                },
            )

            summary = response.text or "No results found."
            sources: List[Dict[str, str]] = []
            sources_str = "\n\n--- SOURCES ---"

            if response.candidates and response.candidates[0].grounding_metadata:
                grounding_chunks = response.candidates[0].grounding_metadata.grounding_chunks or []
                web_chunks = [
                    chunk for chunk in grounding_chunks
                    if hasattr(chunk, "web") and chunk.web
                ]
                resolved_map = resolve_urls(
                    web_chunks,
                    id_seed=abs(hash(query)) % 1_000_000,
                ) if web_chunks else {}

                seen_urls = set()
                for chunk in web_chunks:
                    actual_url = extract_web_url(chunk.web)
                    if not actual_url or actual_url in seen_urls:
                        continue
                    sources.append({
                        "title": getattr(chunk.web, "title", None) or "Untitled",
                        "url": actual_url,
                        "short_url": resolved_map.get(getattr(chunk.web, "uri", ""), ""),
                    })
                    seen_urls.add(actual_url)

            if sources:
                tracker.record(workspace_state, sources)
                for src in sources:
                    display_url = src.get("short_url") or src["url"]
                    sources_str += f"\nTitle: {src['title']}\nURL: {display_url}\n"
            else:
                sources_str += "\nNo sources were found for this query."

            return summary + sources_str

        google_grounded_search.name = "google_grounded_search"
        google_grounded_search.description = "Use Gemini's grounded search with citations."
        return google_grounded_search

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


def build_google_search_tool(
    workspace_state: WorkspaceState,
    source_tracker: SourceTracker,
    client=None,
    model_name: str | None = None,
) -> Tool:
    """Public builder so YAML entrypoints stay accurate."""
    if client is None or model_name is None:
        raise ValueError("Gemini client and model name are required")
    tracker = source_tracker

    @tool
    def internet_search(query: str, max_results: int = 5) -> str:
        """Run a Gemini native Google search for the given query."""
        if workspace_state.context.get("tagged_files_only"):
            return "Tool disabled: tagged files were provided, use rag_query only."
        search_prompt = (
            f"Search the web for information about: {query}\n\n"
            "Return a comprehensive summary of the search results."
        )
        response = client.models.generate_content(
            model=model_name,
            contents=search_prompt,
            config={
                "tools": [{"google_search": {}}],
                "temperature": 0,
            },
        )

        summary = response.text
        sources_str = "\n\n--- SOURCES ---"
        sources_found = False

        if response.candidates and response.candidates[0].grounding_metadata:
            sources: List[Dict[str, str]] = []
            seen_urls = set()
            grounding_chunks = response.candidates[0].grounding_metadata.grounding_chunks or []
            web_chunks = [
                chunk for chunk in grounding_chunks
                if hasattr(chunk, "web") and chunk.web
            ]
            resolved_map = resolve_urls(
                web_chunks,
                id_seed=abs(hash(query)) % 1_000_000,
            ) if web_chunks else {}

            for chunk in web_chunks:
                actual_url = extract_web_url(chunk.web)
                if not actual_url or actual_url in seen_urls:
                    continue
                sources.append({
                    "title": getattr(chunk.web, "title", None) or "Untitled",
                    "url": actual_url,
                    "short_url": resolved_map.get(getattr(chunk.web, "uri", ""), ""),
                })
                seen_urls.add(actual_url)

            if sources:
                sources_found = True
                tracker.record(workspace_state, sources)
                for src in sources:
                    sources_str += f"\nTitle: {src['title']}\nURL: {src['url']}\n"

        if not sources_found:
            sources_str += "\nNo sources were found for this query."

        return summary + sources_str

    internet_search.name = "internet_search"
    internet_search.description = "Use Gemini's built-in search to gather fresh information."
    return internet_search


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


class MCPServerRegistry:
    """Placeholder registry for MCP server configs."""

    def __init__(self, settings: Settings):
        self._servers = settings.mcp_servers

    def describe(self) -> List[Dict[str, Optional[str]]]:
        return [
            {
                "name": cfg.name,
                "transport": cfg.transport,
                "endpoint": cfg.endpoint,
                "description": cfg.description,
            }
            for cfg in self._servers.values()
        ]

"""Tool creation helpers and MCP integration stubs."""
from __future__ import annotations

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
    from google.genai.types import GenerateContentConfig, Modality
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise RuntimeError("Gemini dependencies are required") from exc

from .configuration import Settings, ToolConfig
from .state import WorkspaceState
from .utils import SourceTracker, resolve_urls, extract_web_url


class GeminiClientManager:
    """Initializes and caches a Gemini client per service."""

    def __init__(self, settings: Settings):
        model_cfg = settings.model
        if model_cfg.provider != "gemini":
            raise ValueError(f"Unsupported model provider {model_cfg.provider}")
        vertexai.init(project=model_cfg.project, location=model_cfg.location)
        self.client = genai.Client(
            vertexai=True,
            project=model_cfg.project,
            location=model_cfg.location,
        )
        self.model_name = model_cfg.name
        self.image_model_name = getattr(model_cfg, "image_name", None) or model_cfg.name


class ToolFactory:
    """Builds tool instances for a given workspace state."""

    def __init__(self, settings: Settings, source_tracker: SourceTracker, gemini_manager: GeminiClientManager):
        self.settings = settings
        self.source_tracker = source_tracker
        self.gemini_manager = gemini_manager
        self._builtin_map: Dict[str, Callable[[WorkspaceState], Tool]] = {
            "google_search": self._build_google_search_tool,
            "gemini_image": self._build_gemini_image_tool,
        }

    def build_tools(self, tool_names: List[str], workspace_state: WorkspaceState) -> List[Tool]:
        tools: List[Tool] = []
        for name in tool_names:
            config = self.settings.get_tool(name)
            tools.append(self._build_tool(config, workspace_state))
        return tools

    def _build_tool(self, config: ToolConfig, workspace_state: WorkspaceState) -> Tool:
        if config.name in self._builtin_map:
            return self._builtin_map[config.name](workspace_state)
        if config.entrypoint:
            return self._load_entrypoint(config.entrypoint, workspace_state)
        raise ValueError(f"Tool '{config.name}' has no builder")

    def _load_entrypoint(self, entrypoint: str, workspace_state: WorkspaceState) -> Tool:
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

    output_dir = workspace_state.root_path / "generated_images"
    output_dir.mkdir(parents=True, exist_ok=True)

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

    def _save_inline_image(inline_data, prefix: str, index: int) -> str:
        filename = f"{prefix}-{index + 1}.png"
        destination = output_dir / filename
        with BytesIO(inline_data.data) as stream:
            with Image.open(stream) as image:
                image.save(destination)
        return str(destination.relative_to(workspace_state.root_path))

    @tool
    def gemini_image(
        prompt: str,
        source_image_path: str | None = None,
        output_name_prefix: str | None = None,
    ) -> str:
        """Generate or edit an image with Gemini.

        Args:
            prompt: Description of the image or edit instructions.
            source_image_path: Optional path (relative to workspace root) to edit an existing image.
            output_name_prefix: Optional file name prefix for the saved image(s).

        Returns:
            Summary text describing Gemini's response and the saved image paths.
        """

        if not prompt.strip():
            raise ValueError("Prompt is required for image generation")

        if source_image_path:
            source_image = _resolve_source_image(source_image_path)
            contents: List[object] = [source_image, prompt]
        else:
            contents = [prompt]

        prefix = _sanitize_prefix(output_name_prefix)
        response = client.models.generate_content(
            model=model_name,
            contents=contents,
            config=GenerateContentConfig(
                response_modalities=[Modality.TEXT, Modality.IMAGE],
                candidate_count=1,
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

        if not saved_images:
            raise RuntimeError("Gemini did not return an image in the response")

        summary_lines = []
        if text_parts:
            summary_lines.append("\n".join(text_parts).strip())
        summary_lines.append("Saved images:")
        summary_lines.extend(saved_images)
        return "\n".join(summary_lines)

    gemini_image.name = "gemini_image"
    gemini_image.description = (
        "Generate brand-new images or edit workspace images using Gemini models."
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

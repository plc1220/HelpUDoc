import base64
import os
from typing import Iterable, List, Optional, Sequence, Tuple

from google import genai
from google.genai import types


def create_client(
    api_key: Optional[str] = None,
    vertexai: Optional[bool] = None,
    project: Optional[str] = None,
    location: Optional[str] = None,
):
    """
    Create a Google GenAI client using either API key (Gemini Developer API)
    or Vertex AI configuration if GOOGLE_GENAI_USE_VERTEXAI=true.
    """
    use_vertex = (
        vertexai
        if vertexai is not None
        else os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "false").lower() == "true"
    )

    if use_vertex:
        return genai.Client(
            vertexai=True,
            project=project or os.getenv("GOOGLE_CLOUD_PROJECT"),
            location=location or os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1"),
        )

    key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or os.getenv("RAG_LLM_API_KEY")
    return genai.Client(api_key=key)


def _parts_from_content_item(item) -> List[types.Part]:
    """Convert OpenAI-style content items into GenAI parts."""
    parts: List[types.Part] = []

    if isinstance(item, str):
        return [types.Part.from_text(item)]

    if not isinstance(item, dict):
        return parts

    if item.get("type") == "text":
        return [types.Part.from_text(item.get("text", ""))]

    if item.get("type") == "image_url":
        url = item.get("image_url", {}).get("url", "")
        if url.startswith("data:") and ";base64," in url:
            header, data = url.split(",", 1)
            mime = header.split(":")[1].split(";")[0]
            try:
                parts.append(types.Part.from_bytes(data=base64.b64decode(data), mime_type=mime))
            except Exception:
                return []
    return parts


def _parts_from_message_content(content) -> List[types.Part]:
    """Handle string or list content from chat messages."""
    if isinstance(content, list):
        parts: List[types.Part] = []
        for item in content:
            parts.extend(_parts_from_content_item(item))
        return parts
    return [types.Part.from_text(content if content is not None else "")]


def _normalize_messages(messages: Sequence[dict], system_prompt: Optional[str] = None):
    """Convert OpenAI-style messages into GenAI Content + system instruction."""
    contents: List[types.Content] = []
    system_instructions: List[str] = []

    if system_prompt:
        system_instructions.append(system_prompt)

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if role == "system":
            text = content if isinstance(content, str) else ""
            if isinstance(content, list):
                text_parts = [item.get("text", "") for item in content if isinstance(item, dict) and item.get("type") == "text"]
                text = "\n".join(filter(None, text_parts))
            if text:
                system_instructions.append(text)
            continue

        parts = _parts_from_message_content(content)
        contents.append(types.Content(role=role, parts=parts))

    system_instruction = "\n\n".join(system_instructions) if system_instructions else None
    return contents, system_instruction


def generate_text(
    client,
    model: str,
    messages: Sequence[dict],
    max_output_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
    response_format: Optional[dict] = None,
    system_prompt: Optional[str] = None,
):
    """Call Gemini text generation using OpenAI-style messages."""
    contents, system_instruction = _normalize_messages(messages, system_prompt)

    config_kwargs = {}
    if max_output_tokens:
        config_kwargs["max_output_tokens"] = max_output_tokens
    if temperature is not None:
        config_kwargs["temperature"] = temperature
    if system_instruction:
        config_kwargs["system_instruction"] = system_instruction
    if response_format and response_format.get("type") == "json_object":
        config_kwargs["response_mime_type"] = "application/json"

    config = types.GenerateContentConfig(**config_kwargs) if config_kwargs else None
    return client.models.generate_content(model=model, contents=contents, config=config)


def extract_text(response) -> str:
    """Extract text from a GenAI response."""
    if hasattr(response, "text") and response.text:
        return response.text

    if getattr(response, "candidates", None):
        for cand in response.candidates:
            if getattr(cand, "content", None) and getattr(cand.content, "parts", None):
                texts = [p.text for p in cand.content.parts if getattr(p, "text", None)]
                if texts:
                    return "\n".join(texts)
    if getattr(response, "parts", None):
        texts = [p.text for p in response.parts if getattr(p, "text", None)]
        if texts:
            return "\n".join(texts)
    return ""


def generate_image(
    client,
    model: str,
    prompt: str,
    reference_images: Optional[Iterable[dict]] = None,
    aspect_ratio: Optional[str] = None,
) -> List[Tuple[bytes, str]]:
    """
    Generate images with optional reference images (inline data).

    Returns a list of (image_bytes, mime_type).
    """
    parts: List[types.Part] = [types.Part.from_text(prompt)]

    for img in reference_images or []:
        label = ""
        if isinstance(img, dict):
            if img.get("figure_id") or img.get("caption"):
                figure_id = img.get("figure_id", "Figure")
                caption = img.get("caption") or ""
                label = f"[{figure_id}]: {caption}" if caption else f"[{figure_id}]"
        if label:
            parts.append(types.Part.from_text(label))
        if isinstance(img, dict) and img.get("base64"):
            mime_type = img.get("mime_type", "image/png")
            try:
                parts.append(types.Part.from_bytes(data=base64.b64decode(img["base64"]), mime_type=mime_type))
            except Exception:
                continue

    config_kwargs = {"response_modalities": ["IMAGE"]}
    if aspect_ratio:
        config_kwargs["image_config"] = types.ImageConfig(aspect_ratio=aspect_ratio)
    config = types.GenerateContentConfig(**config_kwargs)

    response = client.models.generate_content(
        model=model,
        contents=[types.Content(role="user", parts=parts)],
        config=config,
    )

    part_lists = []
    if getattr(response, "parts", None):
        part_lists.append(response.parts)
    if getattr(response, "candidates", None):
        for cand in response.candidates:
            if getattr(cand, "content", None) and getattr(cand.content, "parts", None):
                part_lists.append(cand.content.parts)

    images: List[Tuple[bytes, str]] = []
    for part_list in part_lists:
        for part in part_list:
            if getattr(part, "inline_data", None):
                mime_type = part.inline_data.mime_type or "image/png"
                images.append((part.inline_data.data, mime_type))

    return images


def embed_texts(client, model: str, texts: Sequence[str], output_dimensionality: Optional[int] = None) -> List[List[float]]:
    """Embed a batch of texts and return list of embeddings."""
    config = None
    if output_dimensionality:
        config = types.EmbedContentConfig(output_dimensionality=output_dimensionality)

    response = client.models.embed_content(
        model=model,
        contents=list(texts),
        config=config,
    )

    embeddings = []
    if getattr(response, "embeddings", None):
        for emb in response.embeddings:
            embeddings.append(list(emb.values))
    return embeddings

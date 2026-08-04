"""Versioned Gemini Embedding 2 adapter for optional Knowledge retrieval."""
from __future__ import annotations

import asyncio
import math
import os
from typing import Any

from google.genai import types
from pydantic import BaseModel, Field


class EmbeddingInput(BaseModel):
    id: str
    text: str = Field(min_length=1, max_length=30000)
    title: str | None = None


class EmbeddingOutput(BaseModel):
    id: str
    values: list[float]
    tokenCount: int = 0
    contentHash: str | None = None
    page: int | None = None


def embedding_model_name() -> str:
    return os.environ.get("KNOWLEDGE_EMBEDDING_MODEL", "gemini-embedding-2").strip()


def _normalized(values: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in values))
    return [value / norm for value in values] if norm else values


async def embed_knowledge_inputs(
    client: Any,
    *,
    inputs: list[EmbeddingInput],
    dimensions: int = 768,
    task_type: str = "RETRIEVAL_DOCUMENT",
    concurrency: int = 4,
) -> list[EmbeddingOutput]:
    if client is None:
        raise RuntimeError("Gemini embeddings require a configured Google/Vertex client")
    if dimensions not in {128, 256, 512, 768, 1536, 3072}:
        raise ValueError("Unsupported Knowledge embedding dimensionality")
    semaphore = asyncio.Semaphore(max(1, min(8, concurrency)))
    outputs: list[EmbeddingOutput | None] = [None] * len(inputs)

    async def embed_one(index: int, item: EmbeddingInput) -> None:
        async with semaphore:
            response = await client.aio.models.embed_content(
                model=embedding_model_name(),
                contents=item.text,
                config=types.EmbedContentConfig(
                    task_type=task_type,
                    output_dimensionality=dimensions,
                    title=item.title,
                ),
            )
            embeddings = list(getattr(response, "embeddings", None) or [])
            if not embeddings:
                raise ValueError(f"Embedding response omitted input {item.id}")
            embedding = embeddings[0]
            values = [float(value) for value in (getattr(embedding, "values", None) or [])]
            statistics = getattr(embedding, "statistics", None)
            outputs[index] = EmbeddingOutput(
                id=item.id,
                values=_normalized(values),
                tokenCount=int(getattr(statistics, "token_count", 0) or 0),
            )

    await asyncio.gather(*(embed_one(index, item) for index, item in enumerate(inputs)))
    return [output for output in outputs if output is not None]


async def embed_pdf_pages(
    client: Any,
    *,
    pdf_path: Any,
    pages: list[int],
    dimensions: int = 768,
    concurrency: int = 4,
) -> list[EmbeddingOutput]:
    """Embed one-page PDF artifacts so every visual hit retains a page locator."""
    import hashlib
    import fitz  # type: ignore

    document = fitz.open(str(pdf_path))
    semaphore = asyncio.Semaphore(max(1, min(8, concurrency)))
    outputs: list[EmbeddingOutput | None] = [None] * len(pages)

    async def embed_page(index: int, page_number: int) -> None:
        if page_number < 1 or page_number > document.page_count:
            raise ValueError(f"PDF page {page_number} is out of range")
        page_document = fitz.open()
        page_document.insert_pdf(document, from_page=page_number - 1, to_page=page_number - 1)
        page_bytes = page_document.tobytes(garbage=4, deflate=True)
        page_document.close()
        digest = hashlib.sha256(page_bytes).hexdigest()
        async with semaphore:
            response = await client.aio.models.embed_content(
                model=embedding_model_name(),
                contents=types.Part.from_bytes(data=page_bytes, mime_type="application/pdf"),
                config=types.EmbedContentConfig(
                    task_type="RETRIEVAL_DOCUMENT",
                    output_dimensionality=dimensions,
                    title=f"PDF page {page_number}",
                ),
            )
        embeddings = list(getattr(response, "embeddings", None) or [])
        if not embeddings:
            raise ValueError(f"Embedding response omitted PDF page {page_number}")
        embedding = embeddings[0]
        statistics = getattr(embedding, "statistics", None)
        outputs[index] = EmbeddingOutput(
            id=f"page:{page_number}",
            page=page_number,
            contentHash=f"sha256:{digest}",
            values=_normalized([float(value) for value in (getattr(embedding, "values", None) or [])]),
            tokenCount=int(getattr(statistics, "token_count", 0) or 0),
        )

    try:
        await asyncio.gather(*(embed_page(index, page) for index, page in enumerate(pages)))
    finally:
        document.close()
    return [output for output in outputs if output is not None]

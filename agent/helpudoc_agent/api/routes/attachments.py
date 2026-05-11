"""Attachment understanding route."""
from __future__ import annotations

import asyncio
import base64
import logging
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from langchain_core.messages import HumanMessage

from helpudoc_agent.configuration import Settings
from helpudoc_agent.rag_indexer import _safe_join_workspace
from helpudoc_agent.tools_and_schemas import GeminiClientManager

from ..attachment_processing import (
    _attachment_understanding_prompt,
    _build_partial_attachment_payload,
    _docling_markdown_to_payload,
    _extract_docling_payload,
    _extract_text_from_docx,
    _extract_text_from_pdf,
    _extract_text_from_pptx,
    _guess_attachment_strategy,
    _lc_ai_message_text,
    _parse_attachment_payload,
)
from ..schemas import (
    AttachmentUnderstandingAsset,
    AttachmentUnderstandingRequest,
    AttachmentUnderstandingResponse,
    AttachmentUnderstandingSection,
)

logger = logging.getLogger(__name__)


def register_attachments_routes(app: FastAPI, *, settings: Settings, gemini_manager: GeminiClientManager) -> None:
    @app.post("/attachments/understand", response_model=AttachmentUnderstandingResponse)
    async def understand_attachment(req: AttachmentUnderstandingRequest = Body(...)):
        if not req.fileName.strip():
            raise HTTPException(status_code=400, detail="fileName is required")
        buffer: bytes
        ws_id = (req.workspaceId or "").strip()
        rel = (req.relativePath or "").strip()
        if ws_id and rel:
            try:
                abs_path = _safe_join_workspace(
                    Path(settings.backend.workspace_root),
                    ws_id,
                    rel,
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            if not abs_path.is_file():
                raise HTTPException(
                    status_code=404,
                    detail=f"Workspace file not found for workspaceId={ws_id!r} relativePath={rel!r}",
                )
            buffer = await asyncio.to_thread(abs_path.read_bytes)
        else:
            if not req.contentB64.strip():
                raise HTTPException(status_code=400, detail="contentB64 is required")
            try:
                buffer = base64.b64decode(req.contentB64)
            except Exception as exc:
                raise HTTPException(status_code=400, detail="contentB64 must be valid base64") from exc

        kind, fallback_mode = _guess_attachment_strategy(req.fileName, req.mimeType)
        extracted_text: str | None = None
        try:
            understand_model = gemini_manager.get_attachment_chat_model()
            message: HumanMessage
            if kind in {"docx", "pptx", "pdf"}:
                try:
                    markdown, extracted_assets = await asyncio.to_thread(
                        _extract_docling_payload,
                        req.fileName,
                        req.mimeType,
                        buffer,
                    )
                    payload = _docling_markdown_to_payload(req.fileName, markdown, effective_mode="parser")
                    return AttachmentUnderstandingResponse(
                        title=str(payload.get("title") or req.fileName),
                        summary=str(payload.get("summary") or ""),
                        outline=[str(item) for item in (payload.get("outline") or [])],
                        markdown=str(payload.get("markdown") or ""),
                        sections=[
                            AttachmentUnderstandingSection(
                                heading=str(item.get("heading") or "Section"),
                                body=str(item.get("body") or ""),
                            )
                            for item in (payload.get("sections") or [])
                            if isinstance(item, dict) and str(item.get("body") or "").strip()
                        ],
                        extractedAssets=[
                            AttachmentUnderstandingAsset(
                                name=str(item.get("name") or "image.png"),
                                mimeType=str(item.get("mimeType") or "image/png"),
                                contentB64=str(item.get("contentB64") or ""),
                                sourcePath=str(item.get("sourcePath") or "") or None,
                                caption=str(item.get("caption") or "") or None,
                                footnote=str(item.get("footnote") or "") or None,
                            )
                            for item in extracted_assets
                            if str(item.get("contentB64") or "").strip()
                        ],
                        effectiveMode="parser",
                        status="ready",
                    )
                except Exception:
                    logger.exception("Docling extraction failed for %s; falling back to legacy extraction", req.fileName)
                    if kind == "docx":
                        extracted_text = _extract_text_from_docx(buffer)
                    elif kind == "pptx":
                        extracted_text = _extract_text_from_pptx(buffer)
                    else:
                        extracted_text = _extract_text_from_pdf(buffer)
                    message = HumanMessage(
                        content=_attachment_understanding_prompt(req.fileName, extracted_text, kind)
                    )
            elif kind == "image":
                image_b64 = base64.b64encode(buffer).decode("utf-8")
                mime = (req.mimeType or "").strip() or "image/jpeg"
                message = HumanMessage(
                    content=[
                        {"type": "text", "text": _attachment_understanding_prompt(req.fileName, None, kind)},
                        {"type": "image", "base64": image_b64, "mime_type": mime},
                    ]
                )
            else:
                try:
                    extracted_text = buffer.decode("utf-8", errors="replace")
                except Exception:
                    extracted_text = ""
                message = HumanMessage(
                    content=_attachment_understanding_prompt(req.fileName, extracted_text, kind)
                )

            fallback_text = extracted_text or f"Unable to extract textual content from {req.fileName}."
            raw_response_text = ""
            for attempt in range(2):
                lc_response = await asyncio.to_thread(
                    lambda m=message: understand_model.invoke([m], temperature=0.1)
                )
                raw_response_text = _lc_ai_message_text(lc_response)
                payload = _parse_attachment_payload(
                    raw_response_text,
                    req.fileName,
                    fallback_text=fallback_text,
                    fallback_mode=fallback_mode,
                )
                if payload.get("status") != "partial" or attempt == 1:
                    return AttachmentUnderstandingResponse(
                        title=str(payload.get("title") or req.fileName),
                        summary=str(payload.get("summary") or ""),
                        outline=[str(item) for item in (payload.get("outline") or [])],
                        markdown=str(payload.get("markdown") or ""),
                        sections=[
                            AttachmentUnderstandingSection(
                                heading=str(item.get("heading") or "Section"),
                                body=str(item.get("body") or ""),
                            )
                            for item in (payload.get("sections") or [])
                            if isinstance(item, dict) and str(item.get("body") or "").strip()
                        ],
                        effectiveMode=str(payload.get("effectiveMode") or fallback_mode),
                        status=str(payload.get("status") or "partial"),
                    )
                message = HumanMessage(
                    content=(
                        "Repair the previous response into strict JSON only using the required schema.\n\n"
                        + raw_response_text
                    )
                )
        except Exception:
            logger.exception("Attachment understanding failed for %s", req.fileName)

        partial = _build_partial_attachment_payload(
            req.fileName,
            extracted_text or f"Unable to understand {req.fileName}.",
            effective_mode=fallback_mode,
        )
        return AttachmentUnderstandingResponse(
            title=str(partial.get("title") or req.fileName),
            summary=str(partial.get("summary") or ""),
            outline=[str(item) for item in (partial.get("outline") or [])],
            markdown=str(partial.get("markdown") or ""),
            sections=[
                AttachmentUnderstandingSection(
                    heading=str(item.get("heading") or "Section"),
                    body=str(item.get("body") or ""),
                )
                for item in (partial.get("sections") or [])
                if isinstance(item, dict) and str(item.get("body") or "").strip()
            ],
            effectiveMode=str(partial.get("effectiveMode") or fallback_mode),
            status="partial",
        )

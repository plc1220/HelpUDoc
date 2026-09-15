"""Signed internal API for faithful document previews and DOCX quick edits."""
from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from helpudoc_agent.office_preview import MAX_BASE64_LENGTH, OfficePreviewError, OfficePreviewService, decode_content
from ..auth_context import require_internal_user_context


class OfficePreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    workspaceId: str = Field(min_length=1, max_length=255)
    filename: str = Field(min_length=1, max_length=4096)
    content: str = Field(min_length=1, max_length=MAX_BASE64_LENGTH)


class OfficeEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    paragraphId: str = Field(min_length=1, max_length=128)
    start: int = Field(ge=0, le=10_000_000, strict=True)
    end: int = Field(ge=0, le=10_000_000, strict=True)
    quote: str = Field(min_length=1, max_length=100_000)
    action: Literal["bold", "italic", "fontSize", "style", "replaceText"]
    value: Any


class OfficeEditRequest(OfficePreviewRequest):
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    edit: OfficeEdit


def register_office_preview_routes(app: FastAPI, *, agent_jwt_secret: str,
                                   service: OfficePreviewService | None = None) -> None:
    renderer = service or OfficePreviewService()

    def authorize(request: Request, workspace_id: str) -> None:
        context = require_internal_user_context(request, agent_jwt_secret=agent_jwt_secret)
        if str(context.get("workspace_id") or "") != workspace_id:
            raise HTTPException(status_code=403, detail="Agent context does not allow this workspace")

    @app.post("/documents/office-preview")
    async def office_preview(request: Request, req: OfficePreviewRequest):
        authorize(request, req.workspaceId)
        try:
            content = await asyncio.to_thread(decode_content, req.content)
            return await renderer.preview(req.filename, content)
        except OfficePreviewError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/documents/office-edit")
    async def office_edit(request: Request, req: OfficeEditRequest):
        authorize(request, req.workspaceId)
        try:
            content = await asyncio.to_thread(decode_content, req.content)
            return await renderer.edit(req.filename, content, req.revision, req.edit.model_dump())
        except OfficePreviewError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

"""Paper2Slides run and export routes."""
from __future__ import annotations

import asyncio

from fastapi import Body, FastAPI, HTTPException

from helpudoc_agent.presentation_runner import export_pptx_from_pdf, run_paper2slides

from ..schemas import (
    Paper2SlidesExportRequest,
    Paper2SlidesExportResponse,
    Paper2SlidesRunRequest,
    Paper2SlidesRunResponse,
)


def register_paper2slides_routes(app: FastAPI) -> None:
    @app.post("/paper2slides/run", response_model=Paper2SlidesRunResponse)
    async def paper2slides_run(req: Paper2SlidesRunRequest = Body(...)):
        if not req.files:
            raise HTTPException(status_code=400, detail="files is required")
        try:
            payload_files = [file.model_dump() for file in req.files]
            options = req.options.model_dump()
            result = await asyncio.to_thread(run_paper2slides, payload_files, options)
            return Paper2SlidesRunResponse(**result)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.post("/paper2slides/export-pptx", response_model=Paper2SlidesExportResponse)
    async def paper2slides_export(req: Paper2SlidesExportRequest = Body(...)):
        if not req.contentB64:
            raise HTTPException(status_code=400, detail="contentB64 is required")
        try:
            result = await asyncio.to_thread(export_pptx_from_pdf, req.fileName, req.contentB64)
            return Paper2SlidesExportResponse(**result)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

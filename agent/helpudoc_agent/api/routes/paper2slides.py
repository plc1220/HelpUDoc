"""Paper2Slides run routes."""
from __future__ import annotations

import asyncio

from fastapi import Body, FastAPI, HTTPException

from helpudoc_agent.presentation_runner import run_paper2slides

from ..schemas import (
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

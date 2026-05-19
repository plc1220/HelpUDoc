"""Pydantic schemas for workspace agent tools."""
from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field, field_validator


class StructuredWebSource(BaseModel):
    title: str = ""
    url: str


class StructuredWebAnswer(BaseModel):
    summary: str
    sources: list[StructuredWebSource] = Field(default_factory=list)


class RequestClarificationInput(BaseModel):
    title: str
    description: str = ""
    options_json: str = "[]"
    questions_json: str = "[]"
    allow_freeform: bool = True
    multi_select: bool = False
    placeholder: str = ""
    submit_label: str = "Continue"
    step_index: int = 0
    step_count: int = 1
    context_json: str = "{}"

    @field_validator("options_json", "questions_json", mode="before")
    @classmethod
    def _coerce_json_list_string(cls, value: Any) -> str:
        if value is None:
            return "[]"
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    @field_validator("context_json", mode="before")
    @classmethod
    def _coerce_json_dict_string(cls, value: Any) -> str:
        if value is None:
            return "{}"
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            return json.dumps(value, ensure_ascii=False)
        return str(value)

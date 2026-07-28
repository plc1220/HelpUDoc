"""Pydantic models for the agent HTTP API."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str
    history: List[Dict[str, Any]] | None = None
    forceReset: bool = False
    messageContent: List[Dict[str, Any]] | None = None
    internetSearchEnabled: bool = False
    langfuseTraceContext: Dict[str, Any] | None = None


class ChatResponse(BaseModel):
    reply: Any


class InternalAnalyzeRequest(BaseModel):
    systemPrompt: str
    userPrompt: str


class InternalMemoryRequest(BaseModel):
    path: str


class InternalMemoryWriteRequest(InternalMemoryRequest):
    content: str


class Action(BaseModel):
    name: str
    args: Dict[str, Any] = Field(default_factory=dict)


class Decision(BaseModel):
    type: str
    edited_action: Optional[Action] = None
    message: Optional[str] = None


class ResumeChatRequest(BaseModel):
    decisions: List[Decision]
    langfuseTraceContext: Dict[str, Any] | None = None


class InterruptResponseRequest(BaseModel):
    message: Optional[str] = None
    selectedChoiceIds: List[str] = Field(default_factory=list)
    selectedValues: List[str] = Field(default_factory=list)
    answersByQuestionId: Dict[str, str | List[str]] = Field(default_factory=dict)
    langfuseTraceContext: Dict[str, Any] | None = None


class InterruptAction(BaseModel):
    id: str
    value: Optional[str] = None
    payload: Dict[str, Any] = Field(default_factory=dict)
    text: Optional[str] = None


class InterruptActionRequest(BaseModel):
    action: InterruptAction
    langfuseTraceContext: Dict[str, Any] | None = None


class DocumentExtractionRequest(BaseModel):
    workspaceId: str
    relativePath: str


class DocumentExtractionResponse(BaseModel):
    title: str
    summary: str
    markdown: str


class EmbeddedDirective(BaseModel):
    kind: str
    skillId: Optional[str] = None
    serverId: Optional[str] = None

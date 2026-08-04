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
    interruptId: Optional[str] = None
    originalPrompt: Optional[str] = None
    langfuseTraceContext: Dict[str, Any] | None = None


class InterruptResponseRequest(BaseModel):
    message: Optional[str] = None
    selectedChoiceIds: List[str] = Field(default_factory=list)
    selectedValues: List[str] = Field(default_factory=list)
    answersByQuestionId: Dict[str, str | List[str]] = Field(default_factory=dict)
    interruptId: Optional[str] = None
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


class DocumentPreflightRequest(DocumentExtractionRequest):
    pass


class DocumentExtractionResponse(BaseModel):
    title: str
    summary: str
    markdown: str
    manifest: Dict[str, Any] | None = None
    blocks: List[Dict[str, Any]] = Field(default_factory=list)
    structure: List[Dict[str, Any]] = Field(default_factory=list)
    windows: List[Dict[str, Any]] = Field(default_factory=list)
    languageDistribution: Dict[str, float] = Field(default_factory=dict)


class KnowledgeMapRequest(BaseModel):
    workspaceId: str
    window: Dict[str, Any]
    blocks: List[Dict[str, Any]]
    sourceType: str
    languageDistribution: Dict[str, float] = Field(default_factory=dict)
    structuralPath: List[str] = Field(default_factory=list)


class KnowledgeMapResponse(BaseModel):
    result: Dict[str, Any]
    provider: str = "gemini"
    model: str
    modelProfile: str = "lite"
    promptVersion: str
    schemaVersion: str
    usage: Dict[str, Any] = Field(default_factory=dict)
    validationWarnings: List[str] = Field(default_factory=list)


class KnowledgeReduceRequest(BaseModel):
    workspaceId: str
    mapResults: List[Dict[str, Any]]
    blocks: List[Dict[str, Any]]
    fanIn: int = Field(default=6, ge=2, le=8)


class KnowledgeEmbeddingRequest(BaseModel):
    workspaceId: str
    inputs: List[Dict[str, Any]]
    dimensions: int = Field(default=768, ge=128, le=3072)
    taskType: str = "RETRIEVAL_DOCUMENT"


class KnowledgeEmbeddingResponse(BaseModel):
    provider: str = "google"
    model: str
    dimensions: int
    embeddings: List[Dict[str, Any]]


class KnowledgeMediaEmbeddingRequest(BaseModel):
    workspaceId: str
    relativePath: str
    pages: List[int] = Field(min_length=1, max_length=500)
    dimensions: int = Field(default=768, ge=128, le=3072)


class KnowledgeGraphAnalysisRequest(BaseModel):
    workspaceId: str
    concepts: List[Dict[str, Any]]


class EmbeddedDirective(BaseModel):
    kind: str
    skillId: Optional[str] = None
    serverId: Optional[str] = None

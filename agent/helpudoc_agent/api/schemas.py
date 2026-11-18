"""Pydantic models for the agent HTTP API."""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class ChatRequest(BaseModel):
    message: str
    history: List[Dict[str, Any]] | None = None
    forceReset: bool = False
    messageContent: List[Dict[str, Any]] | None = None
    internetSearchEnabled: bool = False
    knowledgeRefs: List[Dict[str, Any]] = Field(default_factory=list)
    langfuseTraceContext: Dict[str, Any] | None = None


class ChatResponse(BaseModel):
    reply: Any


class InternalAnalyzeRequest(BaseModel):
    systemPrompt: str
    userPrompt: str


class PromptSuggestionMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class PromptSuggestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: List[PromptSuggestionMessage] = Field(min_length=2, max_length=6)


class WorkspaceStarterFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=300)
    mimeType: str = Field(default="", max_length=100)


class WorkspaceStarterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)
    readOnly: bool
    files: List[WorkspaceStarterFile] = Field(max_length=24)
    recentTopics: List[str] = Field(max_length=5)


class StarterPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    label: str = Field(min_length=1, max_length=48)
    prompt: str = Field(min_length=1, max_length=600)


class WorkspaceStarterResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompts: List[StarterPrompt] = Field(min_length=2, max_length=4)


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
    guidance: Optional[str] = Field(default=None, max_length=2000)


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
    guidance: Optional[str] = Field(default=None, max_length=2000)


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

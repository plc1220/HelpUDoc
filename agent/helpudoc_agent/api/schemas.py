"""Pydantic models for the agent HTTP API."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, model_validator


class ChatRequest(BaseModel):
    message: str
    history: List[Dict[str, Any]] | None = None
    forceReset: bool = False
    fileContextRefs: List[Dict[str, Any]] | None = None
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


class AttachmentUnderstandingRequest(BaseModel):
    fileName: str
    mimeType: str
    contentB64: str = ""
    workspaceId: Optional[str] = None
    relativePath: Optional[str] = None

    @model_validator(mode="after")
    def validate_attachment_source(self) -> "AttachmentUnderstandingRequest":
        has_b64 = bool((self.contentB64 or "").strip())
        has_path = bool((self.workspaceId or "").strip() and (self.relativePath or "").strip())
        if not has_b64 and not has_path:
            raise ValueError("Either contentB64 or workspaceId+relativePath is required")
        return self


class AttachmentUnderstandingSection(BaseModel):
    heading: str
    body: str


class AttachmentUnderstandingAsset(BaseModel):
    name: str
    mimeType: str
    contentB64: str
    sourcePath: Optional[str] = None
    caption: Optional[str] = None
    footnote: Optional[str] = None


class AttachmentUnderstandingResponse(BaseModel):
    title: str
    summary: str
    outline: List[str] = Field(default_factory=list)
    markdown: str
    sections: List[AttachmentUnderstandingSection] = Field(default_factory=list)
    extractedAssets: List[AttachmentUnderstandingAsset] = Field(default_factory=list)
    effectiveMode: str = "part"
    status: str = "ready"


class RagQueryRequest(BaseModel):
    query: str
    mode: str = "local"
    onlyNeedContext: bool = True
    includeReferences: bool = False


class RagQueryResponse(BaseModel):
    response: str


class RagStatusRequest(BaseModel):
    files: List[str]


class RagStatusResponse(BaseModel):
    statuses: Dict[str, Any]


class Paper2SlidesFile(BaseModel):
    name: str
    contentB64: str


class Paper2SlidesOptions(BaseModel):
    output: str | None = None
    content: str | None = None
    style: str | None = None
    length: str | None = None
    mode: str | None = None
    parallel: int | bool | None = None
    fromStage: str | None = None


class Paper2SlidesImage(BaseModel):
    name: str
    contentB64: str


class Paper2SlidesRunRequest(BaseModel):
    files: List[Paper2SlidesFile]
    options: Paper2SlidesOptions = Field(default_factory=Paper2SlidesOptions)


class Paper2SlidesRunResponse(BaseModel):
    pdfB64: str | None = None
    images: List[Paper2SlidesImage] = []


class EmbeddedDirective(BaseModel):
    kind: str
    skillId: Optional[str] = None
    serverId: Optional[str] = None

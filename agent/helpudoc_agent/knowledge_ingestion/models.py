"""Shared source, structure, and processing-window contracts."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class SourceBlock(BaseModel):
    id: str
    ordinal: int
    text: str
    blockType: Literal["heading", "paragraph", "list", "table", "caption", "image_ocr"]
    page: int | None = None
    paragraph: int | None = None
    table: int | None = None
    row: int | None = None
    cell: int | None = None
    unit: int | None = None
    unitType: str | None = None
    headingLevel: int | None = None
    headingPath: list[str] | None = None
    bbox: tuple[float, float, float, float] | None = None
    extractionMethod: Literal["native", "ocr", "fallback"] = "native"
    extractionConfidence: float = Field(default=1.0, ge=0.0, le=1.0)
    contentHash: str
    mediaArtifactId: str | None = None


class ExtractionWarning(BaseModel):
    sourceUnit: str
    code: str
    message: str


class ModelUsageRecord(BaseModel):
    stage: str
    provider: str = "google"
    model: str
    sourceUnits: list[str] = Field(default_factory=list)
    inputTokens: int = 0
    cachedInputTokens: int = 0
    outputTokens: int = 0
    retries: int = 0
    latencyMs: int = 0
    outcome: Literal["completed", "failed", "cached"] = "completed"
    error: str | None = None


class ExtractionManifest(BaseModel):
    extractorVersion: str
    sourceType: str
    discoveredSourceUnits: int
    processedSourceUnits: int
    failedSourceUnits: int
    needsOcrSourceUnits: int = 0
    converter: str = "helpudoc-native"
    markdownConverter: str | None = None
    locatorStrategy: str = "native"
    mediaType: str | None = None
    ocrMode: Literal["off", "auto", "always"] = "auto"
    ocrProvider: str | None = None
    ocrModel: str | None = None
    ocrTextThreshold: int = 40
    modelUsage: list[ModelUsageRecord] = Field(default_factory=list)
    mediaArtifacts: list[dict[str, object]] = Field(default_factory=list)
    warnings: list[ExtractionWarning] = Field(default_factory=list)


class StructureNode(BaseModel):
    id: str
    title: str
    level: int
    parentId: str | None = None
    childIds: list[str] = Field(default_factory=list)
    blockIds: list[str] = Field(default_factory=list)
    signals: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    sourceStart: str | None = None
    sourceEnd: str | None = None


class ProcessingWindow(BaseModel):
    id: str
    structureNodeId: str
    coreBlockIds: list[str]
    contextBeforeBlockIds: list[str] = Field(default_factory=list)
    contextAfterBlockIds: list[str] = Field(default_factory=list)
    tokenCount: int
    contentHash: str
    strategy: Literal["structural", "semantic", "forced"]


class DocumentPlan(BaseModel):
    title: str
    summary: str
    markdown: str
    manifest: ExtractionManifest
    blocks: list[SourceBlock]
    structure: list[StructureNode]
    windows: list[ProcessingWindow]
    languageDistribution: dict[str, float] = Field(default_factory=dict)

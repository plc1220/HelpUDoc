import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { Knex } from 'knex';
import { parse as parseYaml } from 'yaml';
import { DatabaseService } from './databaseService';
import { WorkspaceService } from './workspaceService';
import { FileService } from './fileService';
import { ConflictError, NotFoundError } from '../errors';
import { KnowledgeType } from '../types/knowledge';
import {
  enrichKnowledgeWindow,
  embedKnowledgeInputs,
  embedKnowledgeMedia,
  analyzeKnowledgeGraph,
  extractWorkspaceDocument,
  KnowledgeMapResponse,
  preflightWorkspaceDocument,
  reduceKnowledgeMapResults,
} from './agentService';
import { KnowledgeIngestionService } from './knowledgeIngestionService';
import { signAgentContextToken } from './agentToken';

export interface KnowledgeInput {
  title: string;
  type: KnowledgeType;
  description?: string;
  content?: string | null;
  fileId?: number | null;
  sourceUrl?: string | null;
  tags?: any;
  metadata?: Record<string, any> | null;
}

type KnowledgeOperationOptions = {
  isGlobal?: boolean;
  allowSystemAdmin?: boolean;
};

const SUPPORTED_TYPES: KnowledgeType[] = ['text', 'table', 'image', 'presentation', 'infographic'];
const OKF_VERSION = '0.2';
const OKF_GENERATOR = 'helpudoc-okf/3';
const OKF_SYSTEM_ROOT = '.system/knowledge';
const KNOWLEDGE_UPLOAD_EXTENSIONS = new Set([
  '.pdf', '.docx', '.xlsx', '.xlsm', '.csv', '.tsv', '.txt', '.md',
]);
const DEFAULT_KNOWLEDGE_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_KNOWLEDGE_UPLOAD_TTL_SECONDS = 30 * 60;

type KnowledgeIngestionStatus =
  | 'queued'
  | 'processing'
  | 'extracting'
  | 'structuring'
  | 'chunking'
  | 'enriching'
  | 'reducing'
  | 'validating'
  | 'indexing'
  | 'publishing'
  | 'published'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'superseded';

type KnowledgeIngestionMetadata = {
  status: KnowledgeIngestionStatus;
  queuedAt?: string;
  startedAt?: string;
  publishedAt?: string;
  failedAt?: string;
  error?: string | null;
  sourceFingerprint?: string | null;
  bundlePath?: string | null;
  runId?: string | null;
  snapshotHash?: string | null;
  enrichmentMode?: 'deterministic' | 'gemini-lite';
  stage?: string | null;
  conceptCount?: number;
  relationshipCount?: number;
  structureNodeCount?: number;
  processingWindowCount?: number;
  discoveredSourceUnits?: number;
  processedSourceUnits?: number;
  failedSourceUnits?: number;
  coveragePercent?: number;
  warnings?: Array<{ sourceUnit: string; code: string; message: string }>;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  okfVersion?: string;
};

export type KnowledgeBundleFile = {
  id: number;
  path: string;
  name: string;
  kind: 'index' | 'source' | 'concept' | 'log' | 'other';
  mimeType: string | null;
  updatedAt: string | null;
};

export type KnowledgeBundleManifest = {
  knowledgeId: number;
  title: string;
  okfVersion: string;
  bundlePath: string;
  snapshotHash?: string | null;
  enrichmentMode?: string | null;
  coverage?: {
    discoveredSourceUnits: number;
    processedSourceUnits: number;
    failedSourceUnits: number;
    coveragePercent: number;
  };
  statistics?: {
    conceptCount: number;
    relationshipCount: number;
    structureNodeCount: number;
    processingWindowCount: number;
  };
  warnings?: Array<{ sourceUnit: string; code: string; message: string }>;
  files: KnowledgeBundleFile[];
};

const quoteYaml = (value: unknown): string => JSON.stringify(String(value ?? ''));

const slugify = (value: string, fallback = 'concept'): string => {
  const normalized = String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
};

export const splitMarkdownSections = (markdown: string): Array<{ title: string; body: string }> => {
  const sections: Array<{ title: string; body: string }> = [];
  let currentTitle = '';
  let currentLines: string[] = [];
  const flush = () => {
    const body = currentLines.join('\n').trim();
    if (currentTitle && body) {
      sections.push({ title: currentTitle, body });
    }
    currentLines = [];
  };
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line.trim());
    if (heading) {
      flush();
      currentTitle = heading[1].trim();
      continue;
    }
    if (currentTitle) {
      currentLines.push(line);
    }
  }
  flush();
  return sections;
};

const semanticSectionsFromPlan = (
  markdown: string,
  blocks: Array<Record<string, unknown>>,
  structure: Array<Record<string, unknown>>,
): Array<{ title: string; body: string }> => {
  const blockById = new Map(blocks.map((block) => [String(block.id || ''), block]));
  const planned = structure
    .filter((node) => String(node.id || '') !== 'structure:root')
    .map((node) => {
      const title = String(node.title || '').trim();
      const body = (Array.isArray(node.blockIds) ? node.blockIds : [])
        .map((blockId) => blockById.get(String(blockId)))
        .filter((block): block is Record<string, unknown> => Boolean(block))
        .filter((block) => String(block.blockType || '') !== 'heading')
        .map((block) => String(block.text || '').trim())
        .filter(Boolean)
        .join('\n\n');
      return { title, body };
    })
    .filter((section) => section.title && section.body && !/^page\s+\d+$/i.test(section.title));
  if (planned.length) return planned;
  return splitMarkdownSections(markdown).filter((section) => !/^page\s+\d+$/i.test(section.title.trim()));
};

export type CanonicalAssertion = {
  text: string;
  confidence: number;
  blockIds: string[];
  pageStart?: number | null;
  pageEnd?: number | null;
};

export type CanonicalRelationship = {
  targetId: string;
  type: string;
  confidence: number;
  confidenceClass: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
  blockIds: string[];
};

export type CanonicalConcept = {
  id: string;
  kind: string;
  name: string;
  description: string;
  aliases: string[];
  tags: string[];
  assertions: CanonicalAssertion[];
  relationships: CanonicalRelationship[];
  path: string;
};

export type KnowledgeGraphPlan = {
  schemaVersion: 'helpudoc-wiki-plan/1';
  concepts: Array<{
    id: string;
    kind: string;
    name: string;
    path: string;
    assertionCount: number;
    incomingRelationshipCount: number;
    outgoingRelationshipCount: number;
  }>;
  relationships: Array<{
    sourceId: string;
    targetId: string;
    type: string;
    confidence: number;
    confidenceClass: CanonicalRelationship['confidenceClass'];
  }>;
  quality: {
    componentCount: number;
    orphanConceptIds: string[];
    thinConceptIds: string[];
    brokenRelationshipCount: number;
  };
};

const normalizedConceptKey = (kind: string, name: string): string => (
  `${slugify(kind, 'concepts')}:${name.normalize('NFKC').trim().toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim()}`
);

const normalizedConceptName = (name: string): string => (
  name.normalize('NFKC').trim().toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim()
);

export const canonicalizeMapResults = (responses: KnowledgeMapResponse[]): CanonicalConcept[] => {
  const concepts = new Map<string, CanonicalConcept>();
  const aliases = new Map<string, string>();
  const pendingRelationships: Array<{
    sourceKey: string;
    targetKey: string;
    relationship: KnowledgeMapResponse['result']['concepts'][number]['relationships'][number];
  }> = [];
  const ensureConcept = (kind: string, name: string, description = ''): CanonicalConcept => {
    const key = normalizedConceptKey(kind, name);
    const existingKey = aliases.get(key) || key;
    const existing = concepts.get(existingKey);
    if (existing) return existing;
    const fallback = `concept-${sha256(key).slice(0, 12)}`;
    const kindSlug = slugify(kind, 'concepts');
    const nameSlug = slugify(name, fallback);
    const concept: CanonicalConcept = {
      id: `${kindSlug}:${nameSlug}`,
      kind: kind.trim() || 'Concept',
      name: name.trim(),
      description: description.trim(),
      aliases: [],
      tags: [],
      assertions: [],
      relationships: [],
      path: `concepts/${kindSlug}/${nameSlug}.md`,
    };
    concepts.set(key, concept);
    aliases.set(key, key);
    return concept;
  };
  for (const response of responses) {
    for (const candidate of response.result.concepts) {
      const key = normalizedConceptKey(candidate.kind, candidate.name);
      const canonicalKey = aliases.get(key) || key;
      let concept = concepts.get(canonicalKey);
      if (!concept) concept = ensureConcept(candidate.kind, candidate.name, candidate.description);
      if (!concept.description && candidate.description) concept.description = candidate.description.trim();
      for (const alias of candidate.aliases || []) {
        const normalizedAlias = normalizedConceptKey(candidate.kind, alias);
        aliases.set(normalizedAlias, canonicalKey);
        if (alias.trim() && !concept.aliases.includes(alias.trim())) concept.aliases.push(alias.trim());
      }
      concept.tags = Array.from(new Set([...concept.tags, ...(candidate.tags || []).map((tag) => tag.trim()).filter(Boolean)])).sort();
      for (const assertion of candidate.assertions || []) {
        const blockIds = Array.from(new Set(assertion.evidence.flatMap((evidence) => evidence.blockIds))).sort();
        const assertionKey = assertion.text.normalize('NFC').trim().toLocaleLowerCase();
        const existing = concept.assertions.find((item) => item.text.normalize('NFC').trim().toLocaleLowerCase() === assertionKey);
        if (existing) {
          existing.confidence = Math.max(existing.confidence, assertion.confidence);
          existing.blockIds = Array.from(new Set([...existing.blockIds, ...blockIds])).sort();
          continue;
        }
        const pages = assertion.evidence.flatMap((evidence) => [evidence.pageStart, evidence.pageEnd])
          .filter((page): page is number => typeof page === 'number');
        concept.assertions.push({
          text: assertion.text.trim(),
          confidence: assertion.confidence,
          blockIds,
          pageStart: pages.length ? Math.min(...pages) : null,
          pageEnd: pages.length ? Math.max(...pages) : null,
        });
      }
      for (const relationship of candidate.relationships || []) {
        pendingRelationships.push({
          sourceKey: canonicalKey,
          targetKey: normalizedConceptKey(relationship.targetKind, relationship.targetName),
          relationship,
        });
      }
    }
  }
  const conceptsByName = new Map<string, CanonicalConcept[]>();
  for (const concept of concepts.values()) {
    const names = [concept.name, ...concept.aliases];
    for (const name of names) {
      const key = normalizedConceptName(name);
      if (!key) continue;
      const matches = conceptsByName.get(key) || [];
      if (!matches.some((match) => match.id === concept.id)) matches.push(concept);
      conceptsByName.set(key, matches);
    }
  }
  for (const item of pendingRelationships) {
    const source = concepts.get(aliases.get(item.sourceKey) || item.sourceKey);
    const targetKey = aliases.get(item.targetKey) || item.targetKey;
    let target = concepts.get(targetKey);
    if (!target) {
      const nameMatches = conceptsByName.get(normalizedConceptName(item.relationship.targetName)) || [];
      if (nameMatches.length === 1) target = nameMatches[0];
    }
    // A relationship mention alone is not enough to create a canonical page.
    // The map stage must also emit the target as a substantive candidate in at
    // least one window. This avoids hundreds of target-only placeholder nodes.
    if (!target) continue;
    if (!source || !target || source.id === target.id) continue;
    const duplicate = source.relationships.find((relationship) => (
      relationship.targetId === target!.id && relationship.type === item.relationship.type
    ));
    if (duplicate) {
      duplicate.confidence = Math.max(duplicate.confidence, item.relationship.confidence);
      duplicate.blockIds = Array.from(new Set([
        ...duplicate.blockIds,
        ...item.relationship.evidenceBlockIds,
      ])).sort();
      const classes = new Set([duplicate.confidenceClass, item.relationship.confidenceClass]);
      duplicate.confidenceClass = classes.has('AMBIGUOUS')
        ? 'AMBIGUOUS'
        : classes.has('INFERRED') ? 'INFERRED' : 'EXTRACTED';
    } else {
      source.relationships.push({
        targetId: target.id,
        type: item.relationship.type,
        confidence: item.relationship.confidence,
        confidenceClass: item.relationship.confidenceClass,
        blockIds: Array.from(new Set(item.relationship.evidenceBlockIds)).sort(),
      });
    }
  }
  return Array.from(concepts.values())
    .map((concept) => ({
      ...concept,
      aliases: concept.aliases.sort(),
      assertions: concept.assertions.sort((left, right) => left.text.localeCompare(right.text)),
      relationships: concept.relationships.sort((left, right) => (
        left.type.localeCompare(right.type) || left.targetId.localeCompare(right.targetId)
      )),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
};

export const pruneThinOrphanConcepts = (concepts: CanonicalConcept[]): CanonicalConcept[] => {
  const incoming = new Map(concepts.map((concept) => [concept.id, 0]));
  for (const concept of concepts) {
    for (const relationship of concept.relationships) {
      if (incoming.has(relationship.targetId)) {
        incoming.set(relationship.targetId, (incoming.get(relationship.targetId) || 0) + 1);
      }
    }
  }
  return concepts.filter((concept) => !(
    concept.assertions.length === 0
    && concept.relationships.length === 0
    && (incoming.get(concept.id) || 0) === 0
    && concept.description.trim().length < 80
  ));
};

export const buildKnowledgeGraphPlan = (concepts: CanonicalConcept[]): KnowledgeGraphPlan => {
  const byId = new Map(concepts.map((concept) => [concept.id, concept]));
  const incoming = new Map(concepts.map((concept) => [concept.id, 0]));
  const adjacency = new Map(concepts.map((concept) => [concept.id, new Set<string>()]));
  const relationships: KnowledgeGraphPlan['relationships'] = [];
  let brokenRelationshipCount = 0;
  for (const concept of concepts) {
    for (const relationship of concept.relationships) {
      if (!byId.has(relationship.targetId)) {
        brokenRelationshipCount += 1;
        continue;
      }
      incoming.set(relationship.targetId, (incoming.get(relationship.targetId) || 0) + 1);
      adjacency.get(concept.id)?.add(relationship.targetId);
      adjacency.get(relationship.targetId)?.add(concept.id);
      relationships.push({
        sourceId: concept.id,
        targetId: relationship.targetId,
        type: relationship.type,
        confidence: relationship.confidence,
        confidenceClass: relationship.confidenceClass,
      });
    }
  }

  let componentCount = 0;
  const visited = new Set<string>();
  for (const concept of concepts) {
    if (visited.has(concept.id)) continue;
    componentCount += 1;
    const queue = [concept.id];
    visited.add(concept.id);
    while (queue.length) {
      const current = queue.shift()!;
      for (const neighbor of adjacency.get(current) || []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  const orphanConceptIds = concepts
    .filter((concept) => (incoming.get(concept.id) || 0) === 0 && concept.relationships.length === 0)
    .map((concept) => concept.id)
    .sort();
  const thinConceptIds = concepts
    .filter((concept) => (
      concept.assertions.length === 0
      && concept.relationships.length === 0
      && (incoming.get(concept.id) || 0) === 0
      && concept.description.trim().length < 80
    ))
    .map((concept) => concept.id)
    .sort();

  return {
    schemaVersion: 'helpudoc-wiki-plan/1',
    concepts: concepts.map((concept) => ({
      id: concept.id,
      kind: concept.kind,
      name: concept.name,
      path: concept.path,
      assertionCount: concept.assertions.length,
      incomingRelationshipCount: incoming.get(concept.id) || 0,
      outgoingRelationshipCount: concept.relationships.length,
    })),
    relationships: relationships.sort((left, right) => (
      left.sourceId.localeCompare(right.sourceId)
      || left.type.localeCompare(right.type)
      || left.targetId.localeCompare(right.targetId)
    )),
    quality: { componentCount, orphanConceptIds, thinConceptIds, brokenRelationshipCount },
  };
};

const stableJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value), null, 2);
};

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const knowledgeRateCard = () => ({
  version: process.env.KNOWLEDGE_RATE_CARD_VERSION || 'gemini-flash-lite-2026-08',
  inputUsdPerMillion: Number(process.env.KNOWLEDGE_GEMINI_INPUT_USD_PER_MILLION || 0.25),
  cachedInputUsdPerMillion: Number(process.env.KNOWLEDGE_GEMINI_CACHED_INPUT_USD_PER_MILLION || 0.025),
  outputUsdPerMillion: Number(process.env.KNOWLEDGE_GEMINI_OUTPUT_USD_PER_MILLION || 1.50),
});

const estimateKnowledgeUsageCost = (usage: {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}): number => {
  const card = knowledgeRateCard();
  const cached = Number(usage.cachedInputTokens || 0);
  const uncached = Math.max(0, Number(usage.inputTokens || 0) - cached);
  return (
    uncached * card.inputUsdPerMillion
    + cached * card.cachedInputUsdPerMillion
    + Number(usage.outputTokens || 0) * card.outputUsdPerMillion
  ) / 1_000_000;
};

const normalizedSearchFeatures = (value: string): Set<string> => {
  const normalized = String(value || '').normalize('NFC').toLocaleLowerCase();
  const features = new Set(normalized.match(/[\p{L}\p{N}_.-]{2,}/gu) || []);
  for (const run of normalized.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) || []) {
    if (run.length === 1) features.add(run);
    for (let index = 0; index < run.length - 1; index += 1) features.add(run.slice(index, index + 2));
  }
  return features;
};

export const scoreKnowledgeLexically = (query: string, fields: string[]): number => {
  const needle = String(query || '').normalize('NFC').toLocaleLowerCase().trim();
  if (!needle) return 0;
  const haystack = fields.join('\n').normalize('NFC').toLocaleLowerCase();
  const queryFeatures = normalizedSearchFeatures(needle);
  const textFeatures = normalizedSearchFeatures(haystack);
  const overlap = Array.from(queryFeatures).filter((feature) => textFeatures.has(feature)).length;
  const coverage = overlap / Math.max(1, queryFeatures.size);
  return (haystack.includes(needle) ? 8 : 0) + coverage * 4;
};

export const reciprocalRankFusion = (
  rankings: string[][],
  constant = 60,
): Array<{ id: string; score: number }> => {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => scores.set(id, (scores.get(id) || 0) + 1 / (constant + index + 1)));
  }
  return Array.from(scores, ([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
};

const parseJsonArray = <T = unknown>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
};

const parseEmbedding = (value: unknown): number[] => {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
    } catch {
      return trimmed.replace(/^\[|\]$/g, '').split(',').map(Number).filter(Number.isFinite);
    }
  }
  return [];
};

const cosineSimilarity = (left: number[], right: number[]): number => {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
};

export const buildOkfBundleManifest = (input: {
  snapshotHash: string;
  sourceFingerprint: string;
  enrichmentMode: 'deterministic' | 'gemini-lite';
  coverage: {
    discoveredSourceUnits: number;
    processedSourceUnits: number;
    failedSourceUnits: number;
  };
  bundlePath: string;
  documents: Map<string, string>;
  validation?: Record<string, unknown>;
}) => ({
  okfVersion: OKF_VERSION,
  generatorVersion: OKF_GENERATOR,
  snapshotHash: input.snapshotHash,
  sourceFingerprint: input.sourceFingerprint,
  enrichmentMode: input.enrichmentMode,
  coverage: input.coverage,
  ...(input.validation ? { validation: input.validation } : {}),
  files: Array.from(input.documents.entries())
    .map(([fileName, content]) => ({
      path: fileName.slice(input.bundlePath.length + 1),
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, 'utf8'),
    }))
    .sort((left, right) => left.path.localeCompare(right.path)),
});

const normalizedUploadName = (value: unknown): string => {
  const name = String(value || 'Knowledge source');
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
};

const markdownAnchors = (content: string): Set<string> => {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '');
  for (const match of body.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const base = String(match[1] || '')
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_~]/g, '')
      .trim()
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-');
    if (!base) continue;
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  return anchors;
};

const validateConceptFrontmatter = (relative: string, content: string): void => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) throw new ConflictError(`OKF document is missing required frontmatter: ${relative}`);
  let fields: unknown;
  try {
    fields = parseYaml(match[1], { maxAliasCount: 100, uniqueKeys: true });
  } catch (error) {
    throw new ConflictError(`OKF document has invalid YAML frontmatter: ${relative}: ${error instanceof Error ? error.message : error}`);
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new ConflictError(`OKF frontmatter must be a mapping: ${relative}`);
  }
  const record = fields as Record<string, unknown>;
  if (typeof record.type !== 'string' || !record.type.trim()) {
    throw new ConflictError(`OKF document is missing a non-empty type: ${relative}`);
  }
  for (const key of ['title', 'description', 'resource', 'timestamp']) {
    if (record[key] !== undefined && (typeof record[key] !== 'string' || !String(record[key]).trim())) {
      throw new ConflictError(`OKF frontmatter field ${key} must be a non-empty string: ${relative}`);
    }
  }
  if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== 'string' || !tag.trim()))) {
    throw new ConflictError(`OKF frontmatter tags must be non-empty strings: ${relative}`);
  }
};

const mermaidProblem = (body: string): string | null => {
  const first = body.trim().split(/\s+/u)[0]?.toLocaleLowerCase() || '';
  const supported = /^(?:flowchart|graph|sequencediagram|classdiagram|statediagram(?:-v2)?|erdiagram|journey|gantt|pie|mindmap|timeline|quadrantchart|requirementdiagram|gitgraph|c4\w*|sankey-beta|xychart-beta|block-beta|packet-beta|architecture-beta|kanban)$/u;
  if (!supported.test(first)) return `unsupported or missing Mermaid diagram type ${first || '[empty]'}`;
  if (/[[({][^)\]}]*;[^)\]}]*[)\]}]/u.test(body)) return 'semicolon inside a Mermaid label';
  if (/[[({][^)\]}]*[<>][^)\]}]*[)\]}]/u.test(body)) return 'unescaped angle bracket inside a Mermaid label';
  return null;
};

export const repairInvalidMermaidFences = (documents: Map<string, string>): {
  fencesChecked: number;
  fencesDegraded: number;
  repairedFiles: string[];
} => {
  let fencesChecked = 0;
  let fencesDegraded = 0;
  const repairedFiles: string[] = [];
  const fence = /^(\s*)(`{3,}|~{3,})\s*mermaid\s*\r?\n([\s\S]*?)^\1\2\s*$/gimu;
  for (const [fileName, original] of documents) {
    if (!fileName.endsWith('.md')) continue;
    let repaired = false;
    const content = original.replace(fence, (whole, indent: string, marker: string, body: string) => {
      fencesChecked += 1;
      const problem = mermaidProblem(body);
      if (!problem) return whole;
      repaired = true;
      fencesDegraded += 1;
      const safeProblem = problem.replace(/--/g, '-').slice(0, 300);
      return `${indent}<!-- helpudoc: invalid Mermaid degraded to text: ${safeProblem} -->\n${indent}${marker}text\n${body}${indent}${marker}`;
    });
    if (repaired) {
      documents.set(fileName, content);
      repairedFiles.push(fileName);
    }
  }
  return { fencesChecked, fencesDegraded, repairedFiles: repairedFiles.sort() };
};

export const validateOkfDocuments = (bundlePath: string, documents: Map<string, string>): void => {
  const paths = new Set(documents.keys());
  for (const [fileName, content] of documents) {
    const relative = fileName.slice(bundlePath.length + 1);
    if (fileName.endsWith('.md') && !['index.md', 'log.md'].includes(relative)) validateConceptFrontmatter(relative, content);
    if (!fileName.endsWith('.md')) continue;
    // source.md preserves uploaded Markdown verbatim. Its relative links belong to the
    // original source location, not to the generated immutable OKF tree.
    if (relative === 'source.md') continue;
    const linkBearingContent = content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/~~~[\s\S]*?~~~/g, '');
    for (const match of linkBearingContent.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = String(match[1] || '').trim();
      const [targetWithQuery, fragment = ''] = href.split('#', 2);
      const target = targetWithQuery.split('?', 1)[0];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      let decodedTarget: string;
      try {
        decodedTarget = target ? decodeURIComponent(target) : '';
      } catch {
        throw new ConflictError(`OKF link target is not valid URI encoding: ${relative} -> ${target}`);
      }
      const resolved = decodedTarget
        ? path.posix.normalize(path.posix.join(path.posix.dirname(fileName), decodedTarget))
        : fileName;
      if (!paths.has(resolved)) {
        throw new ConflictError(`OKF link target does not exist: ${relative} -> ${target}`);
      }
      if (fragment && resolved.endsWith('.md')) {
        let decodedFragment: string;
        try {
          decodedFragment = decodeURIComponent(fragment).toLocaleLowerCase();
        } catch {
          throw new ConflictError(`OKF link heading is not valid URI encoding: ${relative} -> ${href}`);
        }
        const targetContent = documents.get(resolved) || '';
        if (!markdownAnchors(targetContent).has(decodedFragment)) {
          throw new ConflictError(`OKF link heading does not exist: ${relative} -> ${href}`);
        }
      }
    }
  }
};

export class KnowledgeService {
  private db: Knex;
  private workspaceService: WorkspaceService;
  private fileService?: FileService;
  private ingestionService: KnowledgeIngestionService;
  private inFlightIngestions = new Map<number, Promise<void>>();

  constructor(
    databaseService: DatabaseService,
    workspaceService: WorkspaceService,
    fileService?: FileService,
  ) {
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
    this.fileService = fileService;
    this.ingestionService = new KnowledgeIngestionService(databaseService);
  }

  async listGlobal() {
    const rows = await this.baseQuery()
      .where('knowledge_sources.isGlobal', true)
      .orderBy('knowledge_sources.updatedAt', 'desc');
    if (this.fileService) {
      for (const row of rows) {
        const status = this.getIngestionMetadata(row.metadata)?.status;
        const userId = String(row.updatedBy || row.createdBy || '');
        if (row.fileId && userId && (!status || [
          'queued', 'processing', 'extracting', 'structuring', 'chunking', 'enriching',
          'reducing', 'validating', 'indexing', 'publishing',
        ].includes(status))) {
          this.scheduleIngestion(String(row.workspaceId), Number(row.id), userId, true);
        }
      }
    }
    return rows.map((row) => this.mapRow(row));
  }

  async listGlobalIngestionJobs(limit = 100) {
    const rows = await this.db('knowledge_ingestion_jobs as job')
      .join('knowledge_sources as source', 'source.id', 'job.knowledgeId')
      .leftJoin('files', 'files.id', 'job.sourceFileId')
      .where('source.isGlobal', true)
      .select(
        'job.*',
        'source.title as sourceTitle',
        'source.type as sourceType',
        'files.name as sourceFileName',
      )
      .orderBy('job.createdAt', 'desc')
      .limit(Math.max(1, Math.min(250, limit)));
    return rows.map((row) => ({
      ...this.ingestionService.mapJob(row),
      sourceTitle: row.sourceTitle,
      sourceType: row.sourceType,
      sourceFileName: row.sourceFileName || null,
    }));
  }

  async getGlobalById(id: number) {
    const row = await this.baseQuery()
      .where('knowledge_sources.id', id)
      .andWhere('knowledge_sources.isGlobal', true)
      .first();
    if (!row) {
      throw new NotFoundError('Knowledge source not found');
    }
    return this.mapRow(row);
  }

  async getGlobalBundle(id: number, userId: string): Promise<KnowledgeBundleManifest> {
    const knowledge = await this.getKnowledgeRow(id);
    if (!knowledge.isGlobal) {
      throw new NotFoundError('Knowledge source not found');
    }
    return this.getBundleManifest(knowledge, userId, true);
  }

  async readGlobalBundleFile(id: number, userId: string, relativePath: string) {
    const knowledge = await this.getKnowledgeRow(id);
    if (!knowledge.isGlobal) {
      throw new NotFoundError('Knowledge source not found');
    }
    return this.readBundleFile(knowledge, userId, relativePath, true);
  }

  async getBundle(workspaceId: string, id: number, userId: string): Promise<KnowledgeBundleManifest> {
    await this.getById(workspaceId, id, userId);
    const knowledge = await this.db('knowledge_sources').where({ id, workspaceId }).first();
    if (!knowledge) throw new NotFoundError('Knowledge source not found');
    return this.getBundleManifest(knowledge, userId);
  }

  async readWorkspaceBundleFile(workspaceId: string, id: number, userId: string, relativePath: string) {
    await this.getById(workspaceId, id, userId);
    const knowledge = await this.db('knowledge_sources').where({ id, workspaceId }).first();
    if (!knowledge) throw new NotFoundError('Knowledge source not found');
    return this.readBundleFile(knowledge, userId, relativePath);
  }

  async searchGlobalKnowledge(id: number, userId: string, query: string, options: {
    limit?: number; graphHops?: number; includeAmbiguous?: boolean; vector?: boolean;
  } = {}) {
    const knowledge = await this.getKnowledgeRow(id);
    if (!knowledge.isGlobal) throw new NotFoundError('Knowledge source not found');
    await this.getGlobalBundle(id, userId);
    return this.searchPublishedSnapshot(knowledge, userId, query, options, true);
  }

  async searchKnowledge(workspaceId: string, id: number, userId: string, query: string, options: {
    limit?: number; graphHops?: number; includeAmbiguous?: boolean; vector?: boolean;
  } = {}) {
    await this.getById(workspaceId, id, userId);
    const knowledge = await this.db('knowledge_sources').where({ id, workspaceId }).first();
    if (!knowledge) throw new NotFoundError('Knowledge source not found');
    return this.searchPublishedSnapshot(knowledge, userId, query, options, false);
  }

  async readGlobalEvidence(id: number, userId: string, blockIds: string[]) {
    const knowledge = await this.getKnowledgeRow(id);
    if (!knowledge.isGlobal) throw new NotFoundError('Knowledge source not found');
    await this.getGlobalBundle(id, userId);
    return this.readPublishedEvidence(knowledge, blockIds);
  }

  async readKnowledgeEvidence(workspaceId: string, id: number, userId: string, blockIds: string[]) {
    await this.getById(workspaceId, id, userId);
    const knowledge = await this.db('knowledge_sources').where({ id, workspaceId }).first();
    if (!knowledge) throw new NotFoundError('Knowledge source not found');
    return this.readPublishedEvidence(knowledge, blockIds);
  }

  private async searchPublishedSnapshot(
    knowledge: any,
    userId: string,
    query: string,
    options: { limit?: number; graphHops?: number; includeAmbiguous?: boolean; vector?: boolean },
    allowSystemAdmin: boolean,
  ) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) throw new ConflictError('Knowledge search query is required');
    const limit = Math.max(1, Math.min(30, Number(options.limit || 8)));
    const graphHops = Math.max(0, Math.min(2, Number(options.graphHops ?? 1)));
    const snapshot = await this.db('knowledge_snapshots')
      .where({ knowledgeId: Number(knowledge.id), isPublished: true })
      .orderBy('publishedAt', 'desc')
      .first();
    if (!snapshot) throw new ConflictError('Knowledge source has no published enrichment snapshot');
    const [concepts, assertions, relationships] = await Promise.all([
      this.db('knowledge_concepts').where({ snapshotId: snapshot.id }),
      this.db('knowledge_assertions').where({ snapshotId: snapshot.id }),
      this.db('knowledge_relationships').where({ snapshotId: snapshot.id }),
    ]);
    const assertionsByConcept = new Map<string, any[]>();
    for (const assertion of assertions) {
      const list = assertionsByConcept.get(String(assertion.conceptId)) || [];
      list.push(assertion);
      assertionsByConcept.set(String(assertion.conceptId), list);
    }
    const lexical = concepts.map((concept) => {
      const aliases = parseJsonArray<string>(concept.aliases);
      const tags = parseJsonArray<string>(concept.tags);
      const conceptAssertions = assertionsByConcept.get(String(concept.id)) || [];
      const score = scoreKnowledgeLexically(normalizedQuery, [
        String(concept.name || ''),
        ...aliases,
        String(concept.description || ''),
        ...tags,
        ...conceptAssertions.map((assertion) => String(assertion.text || '')),
      ]);
      return { id: String(concept.id), score };
    }).filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

    let vectorRanking: Array<{ id: string; score: number }> = [];
    let pageVectorRanking: Array<{ id: string; score: number }> = [];
    const vectorEnabled = options.vector === true
      && process.env.KNOWLEDGE_VECTOR_ENABLED === 'true'
      && process.env.KNOWLEDGE_RETRIEVAL_MODE === 'vector-rrf';
    if (vectorEnabled && concepts.length) {
      const token = signAgentContextToken({
        sub: userId,
        userId,
        workspaceId: String(knowledge.workspaceId),
        isAdmin: allowSystemAdmin,
        exp: Math.floor(Date.now() / 1000) + 15 * 60,
      });
      if (!token) throw new ConflictError('Vector Knowledge retrieval requires AGENT_JWT_SECRET');
      const response = await embedKnowledgeInputs({
        workspaceId: String(knowledge.workspaceId),
        inputs: [{ id: 'query', text: normalizedQuery }],
        dimensions: Number(process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS || 768),
        taskType: 'RETRIEVAL_QUERY',
      }, { authToken: token });
      const queryVector = response.embeddings[0]?.values || [];
      const rows = await this.db('knowledge_embeddings').where({
        snapshotId: snapshot.id,
        model: response.model,
      });
      const scoredVectors = rows.map((row) => ({
        id: String(row.ownerId),
        ownerType: String(row.ownerType),
        score: cosineSimilarity(queryVector, parseEmbedding(row.embedding)),
      })).filter((candidate) => Number.isFinite(candidate.score))
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
      vectorRanking = scoredVectors.filter((candidate) => candidate.ownerType === 'concept');
      pageVectorRanking = scoredVectors.filter((candidate) => candidate.ownerType === 'page');
    }

    const fused = vectorRanking.length
      ? reciprocalRankFusion([lexical.map((item) => item.id), vectorRanking.map((item) => item.id)])
      : lexical;
    const selected = new Map<string, { score: number; reasons: Set<string> }>();
    for (const candidate of fused.slice(0, limit)) {
      const reasons = new Set<string>();
      if (lexical.some((item) => item.id === candidate.id)) reasons.add('lexical');
      if (vectorRanking.some((item) => item.id === candidate.id)) reasons.add('vector');
      selected.set(candidate.id, { score: candidate.score, reasons });
    }
    let frontier = Array.from(selected.keys());
    for (let hop = 0; hop < graphHops && frontier.length; hop += 1) {
      const next: string[] = [];
      for (const relationship of relationships) {
        if (!options.includeAmbiguous && String(relationship.confidenceClass) === 'AMBIGUOUS') continue;
        if (Number(relationship.confidence || 0) < 0.6) continue;
        const source = String(relationship.sourceConceptId);
        const target = String(relationship.targetConceptId);
        const neighbor = frontier.includes(source) ? target : frontier.includes(target) ? source : null;
        if (!neighbor || selected.has(neighbor)) continue;
        selected.set(neighbor, {
          score: Math.max(0, ...frontier.map((id) => selected.get(id)?.score || 0)) * 0.75,
          reasons: new Set(['graph']),
        });
        next.push(neighbor);
      }
      frontier = next;
    }
    const conceptById = new Map(concepts.map((concept) => [String(concept.id), concept]));
    const ranked = Array.from(selected, ([id, value]) => ({ id, ...value }))
      .filter((item) => conceptById.has(item.id))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit);
    const evidenceSpanIds = new Set<string>();
    for (const item of ranked) {
      for (const assertion of assertionsByConcept.get(item.id) || []) {
        for (const evidenceId of parseJsonArray<string>(assertion.evidenceSpanIds)) evidenceSpanIds.add(evidenceId);
      }
    }
    const spans = evidenceSpanIds.size
      ? await this.db('knowledge_evidence_spans').whereIn('id', Array.from(evidenceSpanIds))
      : [];
    const conceptEvidence = await this.readPublishedEvidence(
      knowledge,
      spans.flatMap((span) => parseJsonArray<string>(span.blockIds)).slice(0, 80),
    );
    let pageEvidence: any[] = [];
    if (pageVectorRanking.length) {
      const pages = new Set(pageVectorRanking.slice(0, limit).map((item) => Number(item.id.replace(/^page:/, ''))));
      const pageBlocks = await this.db('knowledge_source_blocks')
        .where({ runId: snapshot.runId })
        .orderBy('ordinal', 'asc');
      pageEvidence = pageBlocks.filter((block) => {
        const locator = typeof block.locator === 'string' ? JSON.parse(block.locator) : block.locator || {};
        return pages.has(Number(locator.page || 0));
      }).slice(0, 100).map((row) => ({
        blockId: String(row.blockId),
        text: String(row.text || ''),
        locator: row.locator || {},
        extractionMethod: String(row.extractionMethod || 'native'),
        extractionConfidence: Number(row.extractionConfidence || 0),
        sourceFileId: Number(knowledge.fileId || 0) || null,
        retrievalReason: 'vector-page',
      }));
    }
    return {
      query: normalizedQuery,
      snapshotId: String(snapshot.id),
      snapshotHash: String(snapshot.contentHash),
      mode: vectorRanking.length ? 'vector-rrf-graph' : 'lexical-graph',
      concepts: ranked.map((item) => {
        const concept = conceptById.get(item.id);
        return {
          id: item.id,
          name: String(concept.name),
          kind: String(concept.kind),
          description: String(concept.description || ''),
          path: String(concept.path),
          score: item.score,
          reasons: Array.from(item.reasons).sort(),
        };
      }),
      relationships: relationships.filter((relationship) => (
        selected.has(String(relationship.sourceConceptId)) && selected.has(String(relationship.targetConceptId))
      )),
      pageCandidates: pageVectorRanking.slice(0, limit).map((item) => ({
        page: Number(item.id.replace(/^page:/, '')),
        score: item.score,
        reason: 'vector-page',
      })),
      evidence: [...conceptEvidence, ...pageEvidence].filter((item, index, all) => (
        all.findIndex((candidate) => candidate.blockId === item.blockId) === index
      )),
    };
  }

  private async readPublishedEvidence(knowledge: any, requestedBlockIds: string[]) {
    const blockIds = Array.from(new Set(requestedBlockIds.map(String).filter(Boolean))).slice(0, 100);
    if (!blockIds.length) return [];
    const snapshot = await this.db('knowledge_snapshots')
      .where({ knowledgeId: Number(knowledge.id), isPublished: true })
      .orderBy('publishedAt', 'desc')
      .first();
    if (!snapshot) throw new ConflictError('Knowledge source has no published enrichment snapshot');
    const rows = await this.db('knowledge_source_blocks')
      .where({ runId: snapshot.runId })
      .whereIn('blockId', blockIds)
      .orderBy('ordinal', 'asc');
    return rows.map((row) => ({
      blockId: String(row.blockId),
      text: String(row.text || ''),
      locator: row.locator || {},
      extractionMethod: String(row.extractionMethod || 'native'),
      extractionConfidence: Number(row.extractionConfidence || 0),
      sourceFileId: Number(knowledge.fileId || 0) || null,
    }));
  }

  async getGlobalIngestionCurrent(id: number) {
    await this.getGlobalById(id);
    return this.ingestionService.current(id);
  }

  async getIngestionCurrent(workspaceId: string, id: number, userId: string) {
    await this.getById(workspaceId, id, userId);
    return this.ingestionService.current(id);
  }

  async getGlobalIngestionReport(id: number, runId: string) {
    await this.getGlobalById(id);
    return this.ingestionService.report(id, runId);
  }

  async getIngestionReport(workspaceId: string, id: number, runId: string, userId: string) {
    await this.getById(workspaceId, id, userId);
    return this.ingestionService.report(id, runId);
  }

  async previewGlobalIngestion(id: number, userId: string) {
    const knowledge = await this.getKnowledgeRow(id);
    if (!knowledge.isGlobal) throw new NotFoundError('Knowledge source not found');
    return this.previewIngestion(knowledge, userId, true);
  }

  async previewIngestionCost(workspaceId: string, id: number, userId: string) {
    await this.getById(workspaceId, id, userId);
    const knowledge = await this.db('knowledge_sources').where({ id, workspaceId }).first();
    if (!knowledge) throw new NotFoundError('Knowledge source not found');
    return this.previewIngestion(knowledge, userId, false);
  }

  private async previewIngestion(knowledge: any, userId: string, allowSystemAdmin: boolean) {
    if (!this.fileService || !knowledge.fileId) throw new ConflictError('Knowledge source is not file-backed');
    const sourceFile = await this.fileService.getFileRecord(Number(knowledge.fileId), userId, { allowSystemAdmin });
    const token = signAgentContextToken({
      sub: userId,
      userId,
      workspaceId: String(knowledge.workspaceId),
      isAdmin: allowSystemAdmin,
      exp: Math.floor(Date.now() / 1000) + 15 * 60,
    });
    if (!token) throw new ConflictError('Knowledge preflight requires AGENT_JWT_SECRET');
    const preflight = await preflightWorkspaceDocument(
      String(knowledge.workspaceId), String(sourceFile.name), { authToken: token },
    );
    const nativeInputTokens = Math.ceil(Number(preflight.nativeCharacters || 0) / 4);
    const ocrInputTokens = Number(preflight.ocrSourceUnits || 0) * 1500;
    const mapInputTokens = Math.max(nativeInputTokens, Number(preflight.sourceUnits || 1) * 500);
    const outputTokens = Math.max(512, Math.ceil(mapInputTokens * 0.3));
    const estimated = {
      inputTokens: nativeInputTokens + ocrInputTokens + mapInputTokens,
      cachedInputTokens: 0,
      outputTokens,
    };
    return {
      ...preflight,
      modelProfile: 'gemini-flash-lite',
      estimateAssumptions: {
        ocrInputTokensPerPage: 1500,
        semanticOutputRatio: 0.3,
        excludesRetries: true,
      },
      estimatedUsage: estimated,
      rateCard: knowledgeRateCard(),
      estimatedCost: estimateKnowledgeUsageCost(estimated),
    };
  }

  async cancelGlobalIngestion(id: number, runId: string) {
    const knowledge = await this.getKnowledgeRow(id);
    if (!knowledge.isGlobal) throw new NotFoundError('Knowledge source not found');
    const job = await this.ingestionService.cancel(id, runId);
    await this.updateIngestionMetadata(String(knowledge.workspaceId), id, {
      status: 'cancelled', stage: 'cancelled', runId, error: null, okfVersion: OKF_VERSION,
    });
    return job;
  }

  async cancelIngestion(workspaceId: string, id: number, runId: string, userId: string) {
    await this.getById(workspaceId, id, userId);
    const job = await this.ingestionService.cancel(id, runId);
    await this.updateIngestionMetadata(workspaceId, id, {
      status: 'cancelled', stage: 'cancelled', runId, error: null, okfVersion: OKF_VERSION,
    });
    return job;
  }

  async listGlobalSnapshots(id: number) {
    await this.getGlobalById(id);
    return this.listSnapshots(id);
  }

  async listKnowledgeSnapshots(workspaceId: string, id: number, userId: string) {
    await this.getById(workspaceId, id, userId);
    return this.listSnapshots(id);
  }

  async publishGlobalSnapshot(id: number, snapshotId: string, userId: string) {
    const knowledge = await this.getKnowledgeRow(id);
    if (!knowledge.isGlobal) throw new NotFoundError('Knowledge source not found');
    return this.publishSnapshot(knowledge, snapshotId, userId, true);
  }

  async publishKnowledgeSnapshot(workspaceId: string, id: number, snapshotId: string, userId: string) {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const knowledge = await this.db('knowledge_sources').where({ id, workspaceId }).first();
    if (!knowledge) throw new NotFoundError('Knowledge source not found');
    return this.publishSnapshot(knowledge, snapshotId, userId, false);
  }

  private async listSnapshots(knowledgeId: number) {
    return this.db('knowledge_snapshots as snapshot')
      .leftJoin('knowledge_ingestion_jobs as job', 'job.id', 'snapshot.runId')
      .where('snapshot.knowledgeId', knowledgeId)
      .select(
        'snapshot.id', 'snapshot.runId', 'snapshot.contentHash', 'snapshot.artifactPath',
        'snapshot.generatorVersion', 'snapshot.isPublished', 'snapshot.publishedAt', 'snapshot.createdAt',
        'job.bundlePath', 'job.status', 'job.discoveredSourceUnits', 'job.processedSourceUnits',
        'job.failedSourceUnits',
      )
      .orderBy('snapshot.createdAt', 'desc');
  }

  private async publishSnapshot(knowledge: any, snapshotId: string, userId: string, allowSystemAdmin: boolean) {
    if (!this.fileService) throw new ConflictError('Knowledge file storage is not configured');
    const snapshot = await this.db('knowledge_snapshots as snapshot')
      .leftJoin('knowledge_ingestion_jobs as job', 'job.id', 'snapshot.runId')
      .where({ 'snapshot.id': snapshotId, 'snapshot.knowledgeId': Number(knowledge.id) })
      .select('snapshot.*', 'job.bundlePath')
      .first();
    if (!snapshot) throw new NotFoundError('Knowledge snapshot not found');
    const digest = String(snapshot.contentHash || '').replace(/^sha256:/, '');
    const bundlePath = String(snapshot.bundlePath || path.posix.join(
      OKF_SYSTEM_ROOT, String(knowledge.id), 'bundles', digest,
    ));
    const indexFile = await this.db('files').where({
      workspaceId: String(knowledge.workspaceId),
      name: path.posix.join(bundlePath, 'index.md'),
    }).first();
    if (!indexFile) throw new ConflictError('Snapshot bundle is unavailable and cannot be published');
    const publishedAt = new Date().toISOString();
    await this.fileService.upsertInternalTextFile(
      String(knowledge.workspaceId),
      path.posix.join(OKF_SYSTEM_ROOT, String(knowledge.id), 'current.json'),
      `${stableJson({
        snapshotHash: String(snapshot.contentHash),
        bundlePath,
        runId: String(snapshot.runId),
        publishedAt,
      })}\n`,
      userId,
      'application/json',
      { allowSystemAdmin },
    );
    await this.db.transaction(async (trx) => {
      await trx('knowledge_snapshots').where({ knowledgeId: Number(knowledge.id) }).update({ isPublished: false });
      await trx('knowledge_snapshots').where({ id: snapshotId }).update({ isPublished: true, publishedAt: trx.fn.now() });
    });
    await this.updateIngestionMetadata(String(knowledge.workspaceId), Number(knowledge.id), {
      status: 'published',
      stage: 'published',
      runId: String(snapshot.runId),
      snapshotHash: String(snapshot.contentHash),
      bundlePath,
      publishedAt,
      error: null,
      okfVersion: OKF_VERSION,
    });
    return { snapshotId, snapshotHash: String(snapshot.contentHash), bundlePath, publishedAt };
  }

  async getGlobalGraph(id: number) {
    await this.getGlobalById(id);
    return this.getGraphSummary(id);
  }

  async getGraph(workspaceId: string, id: number, userId: string) {
    await this.getById(workspaceId, id, userId);
    return this.getGraphSummary(id);
  }

  async createGlobal(userId: string, payload: KnowledgeInput) {
    const workspaceId = await this.resolveStorageWorkspace(userId);
    return this.create(workspaceId, userId, payload, { isGlobal: true });
  }

  async createGlobalUpload(
    userId: string,
    file: { originalname: string; mimetype: string; buffer: Buffer },
    payload: Pick<KnowledgeInput, 'title' | 'type' | 'description' | 'metadata'>,
  ) {
    if (!this.fileService) {
      throw new ConflictError('Knowledge file storage is not configured');
    }
    const workspaceId = await this.resolveStorageWorkspace(userId);
    const fileName = await this.fileService.resolveUniqueRelativePath(
      workspaceId,
      file.originalname,
      userId,
    );
    const storedFile = await this.fileService.createFile(
      workspaceId,
      fileName,
      file.buffer,
      file.mimetype || 'application/octet-stream',
      userId,
    );
    return this.create(workspaceId, userId, {
      ...payload,
      fileId: Number(storedFile.id),
    }, { isGlobal: true });
  }

  async createGlobalUploadSession(userId: string, input: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    title: string;
    type: KnowledgeType;
    description?: string;
    metadata?: Record<string, unknown>;
  }) {
    if (!this.fileService) {
      throw new ConflictError('Knowledge file storage is not configured');
    }
    this.assertType(input.type);
    const extension = path.extname(String(input.fileName || '')).toLowerCase();
    if (!KNOWLEDGE_UPLOAD_EXTENSIONS.has(extension)) {
      throw new ConflictError(`Unsupported knowledge upload type: ${extension || 'unknown'}`);
    }
    const configuredMaxBytes = Number(process.env.KNOWLEDGE_UPLOAD_MAX_BYTES);
    const maxBytes = Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
      ? Math.max(1024 * 1024, Math.floor(configuredMaxBytes))
      : DEFAULT_KNOWLEDGE_UPLOAD_MAX_BYTES;
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > maxBytes) {
      throw new ConflictError(`Knowledge uploads must be between 1 byte and ${maxBytes} bytes`);
    }
    const configuredTtl = Number(process.env.KNOWLEDGE_UPLOAD_TTL_SECONDS);
    const expiresInSeconds = Number.isFinite(configuredTtl) && configuredTtl > 0
      ? Math.max(5 * 60, Math.min(60 * 60, Math.floor(configuredTtl)))
      : DEFAULT_KNOWLEDGE_UPLOAD_TTL_SECONDS;
    const id = randomUUID();
    const workspaceId = await this.resolveStorageWorkspace(userId);
    const mimeType = String(input.mimeType || 'application/octet-stream').trim() || 'application/octet-stream';
    const directUpload = await this.fileService.createDirectUploadUrl(
      workspaceId,
      id,
      input.fileName,
      mimeType,
      userId,
      expiresInSeconds,
    );
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    await this.db('knowledge_upload_sessions').insert({
      id,
      workspaceId,
      userId,
      status: 'pending',
      objectKey: directUpload.objectKey,
      requestedFileName: directUpload.requestedFileName,
      mimeType,
      sizeBytes: input.sizeBytes,
      payload: {
        title: input.title,
        type: input.type,
        description: input.description,
        metadata: input.metadata || {},
      },
      expiresAt,
    });
    void this.cleanupExpiredUploadSessions().catch((error) => {
      console.error('Failed to clean up expired knowledge uploads', error);
    });
    return {
      id,
      status: 'pending',
      uploadUrl: directUpload.uploadUrl,
      expiresAt: expiresAt.toISOString(),
      headers: { 'Content-Type': mimeType },
      fileName: directUpload.requestedFileName,
      sizeBytes: input.sizeBytes,
    };
  }

  async completeGlobalUploadSession(userId: string, uploadId: string) {
    if (!this.fileService) {
      throw new ConflictError('Knowledge file storage is not configured');
    }
    const session = await this.db('knowledge_upload_sessions').where({ id: uploadId }).first();
    if (!session || String(session.userId || '') !== userId) {
      throw new NotFoundError('Knowledge upload session not found');
    }
    if (session.status === 'completed' && session.knowledgeId) {
      const knowledge = await this.getGlobalById(Number(session.knowledgeId));
      return {
        upload: this.mapUploadSession(session),
        knowledge,
        job: await this.ingestionService.current(Number(session.knowledgeId)),
      };
    }
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      await this.fileService.deleteStoredObject(String(session.objectKey)).catch(() => undefined);
      await this.db('knowledge_upload_sessions').where({ id: uploadId }).update({
        status: 'expired',
        error: 'Upload session expired before finalization',
        updatedAt: this.db.fn.now(),
      });
      throw new ConflictError('Knowledge upload session has expired');
    }
    const claimed = await this.db('knowledge_upload_sessions')
      .where({ id: uploadId, status: 'pending' })
      .update({ status: 'finalizing', error: null, updatedAt: this.db.fn.now() });
    if (!claimed) {
      throw new ConflictError('Knowledge upload session is already being finalized');
    }

    let storedFile: any | null = null;
    try {
      const object = await this.fileService.inspectStoredObject(String(session.objectKey));
      const expectedSize = Number(session.sizeBytes);
      if (object.sizeBytes !== expectedSize) {
        throw new ConflictError(
          `Uploaded object size mismatch: expected ${expectedSize} bytes, received ${object.sizeBytes}`,
        );
      }
      if (object.mimeType && String(object.mimeType).toLowerCase() !== String(session.mimeType).toLowerCase()) {
        throw new ConflictError(
          `Uploaded object content type mismatch: expected ${session.mimeType}, received ${object.mimeType}`,
        );
      }
      storedFile = await this.fileService.finalizeDirectUpload({
        workspaceId: String(session.workspaceId),
        objectKey: String(session.objectKey),
        requestedFileName: String(session.requestedFileName),
        mimeType: String(session.mimeType),
      }, userId);
      await this.db('knowledge_upload_sessions').where({ id: uploadId }).update({
        fileId: Number(storedFile.id),
        etag: object.etag,
        updatedAt: this.db.fn.now(),
      });
      const payload = this.normalizeMetadata(session.payload);
      const sourceMetadata = this.normalizeMetadata(payload.metadata);
      const requestedProfile = String(
        sourceMetadata.enrichmentProfile || process.env.KNOWLEDGE_ENRICHMENT_MODE || 'gemini-lite',
      ).trim().toLowerCase();
      const enrichmentMode: 'deterministic' | 'gemini-lite' = requestedProfile === 'deterministic'
        ? 'deterministic'
        : 'gemini-lite';
      const queuedAt = new Date().toISOString();
      const created = await this.db.transaction(async (trx) => {
        const [record] = await trx('knowledge_sources').insert({
          workspaceId: String(session.workspaceId),
          isGlobal: true,
          title: String(payload.title || session.requestedFileName),
          type: payload.type as KnowledgeType,
          description: payload.description ? String(payload.description) : null,
          content: null,
          fileId: Number(storedFile.id),
          sourceUrl: null,
          tags: null,
          metadata: sourceMetadata,
          createdBy: userId,
          updatedBy: userId,
        }).returning('*');
        const job = await this.ingestionService.queue({
          knowledgeId: Number(record.id),
          workspaceId: String(session.workspaceId),
          sourceFileId: Number(storedFile.id),
          configuration: {
            enrichmentMode,
            okfVersion: OKF_VERSION,
            requestedBy: userId,
            allowSystemAdmin: true,
          },
        }, trx);
        await trx('knowledge_sources').where({ id: Number(record.id) }).update({
          metadata: this.withIngestionMetadata(sourceMetadata, {
            status: 'queued',
            stage: 'queued',
            runId: String(job.id),
            queuedAt,
            error: null,
            enrichmentMode,
            okfVersion: OKF_VERSION,
          }),
          updatedAt: trx.fn.now(),
        });
        return { knowledgeId: Number(record.id), job };
      });
      await this.ingestionService.publishQueued({
        workspaceId: String(session.workspaceId),
        knowledgeId: created.knowledgeId,
      }, created.job);
      await this.workspaceService.touchWorkspace(String(session.workspaceId), userId);
      this.scheduleIngestion(String(session.workspaceId), created.knowledgeId, userId, true);
      const knowledge = await this.getGlobalById(created.knowledgeId);
      await this.db('knowledge_upload_sessions').where({ id: uploadId }).update({
        status: 'completed',
        knowledgeId: Number(knowledge.id),
        completedAt: this.db.fn.now(),
        updatedAt: this.db.fn.now(),
      });
      const completed = await this.db('knowledge_upload_sessions').where({ id: uploadId }).first();
      return {
        upload: this.mapUploadSession(completed),
        knowledge,
        job: created.job,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (storedFile) {
        await this.db('knowledge_sources').where({ fileId: Number(storedFile.id) }).del().catch(() => undefined);
        await this.fileService.deleteFile(Number(storedFile.id), userId).catch(() => undefined);
      }
      await this.db('knowledge_upload_sessions').where({ id: uploadId }).update({
        status: 'failed',
        fileId: null,
        error: message,
        updatedAt: this.db.fn.now(),
      });
      throw error;
    }
  }

  async cancelGlobalUploadSession(userId: string, uploadId: string) {
    if (!this.fileService) {
      throw new ConflictError('Knowledge file storage is not configured');
    }
    const session = await this.db('knowledge_upload_sessions').where({ id: uploadId }).first();
    if (!session || String(session.userId || '') !== userId) {
      throw new NotFoundError('Knowledge upload session not found');
    }
    if (session.status === 'completed' || session.status === 'finalizing') {
      throw new ConflictError('Knowledge upload can no longer be cancelled');
    }
    await this.fileService.deleteStoredObject(String(session.objectKey)).catch(() => undefined);
    await this.db('knowledge_upload_sessions').where({ id: uploadId }).update({
      status: 'cancelled',
      updatedAt: this.db.fn.now(),
    });
    return { ...this.mapUploadSession(session), status: 'cancelled' };
  }

  async cleanupExpiredUploadSessions(limit = 50): Promise<number> {
    if (!this.fileService) return 0;
    const rows = await this.db('knowledge_upload_sessions')
      .whereIn('status', ['pending', 'failed', 'finalizing'])
      .andWhere('expiresAt', '<', new Date())
      .orderBy('expiresAt', 'asc')
      .limit(Math.max(1, Math.min(250, limit)));
    for (const row of rows) {
      const storedFile = row.fileId
        ? await this.db('files').where({ id: Number(row.fileId) }).first()
        : await this.db('files').where({
            workspaceId: row.workspaceId,
            path: row.objectKey,
          }).first();
      const knowledge = storedFile
        ? await this.db('knowledge_sources').where({ fileId: Number(storedFile.id), isGlobal: true }).first()
        : null;
      if (knowledge) {
        if (!await this.ingestionService.current(Number(knowledge.id)) && row.userId) {
          await this.queueIngestion(
            String(knowledge.workspaceId),
            Number(knowledge.id),
            Number(storedFile.id),
            String(row.userId),
            true,
          );
        }
        await this.db('knowledge_upload_sessions').where({ id: row.id }).update({
          status: 'completed',
          fileId: Number(storedFile.id),
          knowledgeId: Number(knowledge.id),
          completedAt: row.completedAt || this.db.fn.now(),
          error: null,
          updatedAt: this.db.fn.now(),
        });
        continue;
      }
      if (storedFile && row.userId) {
        await this.fileService.deleteFile(Number(storedFile.id), String(row.userId), {
          allowSystemAdmin: true,
        }).catch(() => undefined);
      } else {
        await this.fileService.deleteStoredObject(String(row.objectKey)).catch(() => undefined);
      }
      await this.db('knowledge_upload_sessions').where({ id: row.id }).update({
        status: 'expired',
        error: row.error || 'Upload session expired',
        updatedAt: this.db.fn.now(),
      });
    }
    return rows.length;
  }

  private mapUploadSession(row: any) {
    return {
      id: String(row.id),
      status: String(row.status),
      fileName: String(row.requestedFileName),
      sizeBytes: Number(row.sizeBytes),
      fileId: row.fileId ? Number(row.fileId) : null,
      knowledgeId: row.knowledgeId ? Number(row.knowledgeId) : null,
      expiresAt: row.expiresAt,
      completedAt: row.completedAt || null,
      error: row.error || null,
    };
  }

  async updateGlobal(id: number, userId: string, payload: Partial<KnowledgeInput>) {
    const row = await this.getKnowledgeRow(id);
    return this.update(String(row.workspaceId), id, userId, payload, { allowSystemAdmin: true });
  }

  async rebuildGlobal(id: number, userId: string) {
    const row = await this.getKnowledgeRow(id);
    return this.rebuild(String(row.workspaceId), id, userId, { allowSystemAdmin: true });
  }

  async deleteGlobal(id: number, userId: string) {
    const row = await this.getKnowledgeRow(id);
    return this.delete(String(row.workspaceId), id, userId, { allowSystemAdmin: true });
  }

  async list(workspaceId: string, userId: string) {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const globalKnowledgeIds = await this.resolveGlobalKnowledgeAccess(userId);
    const rows = await this.applyKnowledgeAccess(this.baseQuery(), workspaceId, globalKnowledgeIds)
      .orderBy('knowledge_sources.updatedAt', 'desc');

    if (this.fileService) {
      for (const row of rows) {
        if (row.isGlobal && row.workspaceId !== workspaceId) {
          continue;
        }
        const status = this.getIngestionMetadata(row.metadata)?.status;
        if (!row.fileId) {
          continue;
        }
        if (!status) {
          const ingestion: KnowledgeIngestionMetadata = {
            status: 'queued',
            queuedAt: new Date().toISOString(),
            error: null,
            okfVersion: OKF_VERSION,
          };
          await this.updateIngestionMetadata(workspaceId, Number(row.id), ingestion);
          row.metadata = this.withIngestionMetadata(row.metadata, ingestion);
        }
        if (!status || [
          'queued', 'processing', 'extracting', 'structuring', 'chunking', 'enriching',
          'reducing', 'validating', 'indexing', 'publishing',
        ].includes(status)) {
          this.scheduleIngestion(workspaceId, Number(row.id), userId);
        }
      }
    }
    return rows.map((row) => this.mapRow(row));
  }

  async getById(workspaceId: string, id: number, userId: string, options: KnowledgeOperationOptions = {}) {
    await this.workspaceService.ensureMembership(workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options.allowSystemAdmin,
    });
    const globalKnowledgeIds = await this.resolveGlobalKnowledgeAccess(userId);
    const row = await this.applyKnowledgeAccess(this.baseQuery(), workspaceId, globalKnowledgeIds)
      .andWhere('knowledge_sources.id', id)
      .first();
    if (!row) {
      throw new NotFoundError('Knowledge source not found');
    }
    return this.mapRow(row);
  }

  async create(workspaceId: string, userId: string, payload: KnowledgeInput, options: KnowledgeOperationOptions = {}) {
    this.assertType(payload.type);
    await this.workspaceService.ensureMembership(workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options.allowSystemAdmin,
    });

    if (payload.fileId) {
      await this.assertFileInWorkspace(payload.fileId, workspaceId);
    }
    this.assertMinimalFields(payload.type, payload);

    const initialMetadata = payload.fileId
      ? this.withIngestionMetadata(payload.metadata, {
          status: 'queued',
          queuedAt: new Date().toISOString(),
          error: null,
          okfVersion: OKF_VERSION,
        })
      : payload.metadata ?? null;
    const [record] = await this.db('knowledge_sources')
      .insert({
        workspaceId,
        isGlobal: Boolean(options.isGlobal),
        title: payload.title,
        type: payload.type,
        description: payload.description,
        content: payload.content,
        fileId: payload.fileId ?? null,
        sourceUrl: payload.sourceUrl,
        tags: payload.tags ?? null,
        metadata: initialMetadata,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning('*');

    await this.workspaceService.touchWorkspace(workspaceId, userId);
    if (payload.fileId && this.fileService) {
      await this.queueIngestion(workspaceId, Number(record.id), Number(payload.fileId), userId, options.allowSystemAdmin);
    }
    return this.getById(workspaceId, record.id, userId, options);
  }

  async update(workspaceId: string, id: number, userId: string, payload: Partial<KnowledgeInput>, options: KnowledgeOperationOptions = {}) {
    await this.workspaceService.ensureMembership(workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options.allowSystemAdmin,
    });
    const existing = await this.db('knowledge_sources').where({ id, workspaceId }).first();
    if (!existing) {
      throw new NotFoundError('Knowledge source not found');
    }

    if (payload.type) {
      this.assertType(payload.type);
    }
    if (payload.fileId) {
      await this.assertFileInWorkspace(payload.fileId, workspaceId);
    }

    const effectiveType = payload.type ?? (existing.type as KnowledgeType);
    this.assertMinimalFields(effectiveType, payload, existing);

    const updates: Record<string, any> = {
      updatedAt: this.db.fn.now(),
      updatedBy: userId,
    };

    if (payload.title !== undefined) updates.title = payload.title;
    if (payload.type !== undefined) updates.type = payload.type;
    if (payload.description !== undefined) updates.description = payload.description;
    if (payload.content !== undefined) updates.content = payload.content;
    if (payload.fileId !== undefined) updates.fileId = payload.fileId ?? null;
    if (payload.sourceUrl !== undefined) updates.sourceUrl = payload.sourceUrl;
    if (payload.tags !== undefined) updates.tags = payload.tags;
    if (payload.metadata !== undefined) updates.metadata = payload.metadata;

    await this.db('knowledge_sources').where({ id, workspaceId }).update(updates);
    await this.workspaceService.touchWorkspace(workspaceId, userId);

    if (payload.fileId && this.fileService) {
      await this.queueIngestion(workspaceId, id, Number(payload.fileId), userId, options.allowSystemAdmin);
    }

    return this.getById(workspaceId, id, userId, options);
  }

  async rebuild(workspaceId: string, id: number, userId: string, options: KnowledgeOperationOptions = {}) {
    await this.workspaceService.ensureMembership(workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options.allowSystemAdmin,
    });
    const existing = await this.db('knowledge_sources').where({ id, workspaceId }).first();
    if (!existing) {
      throw new NotFoundError('Knowledge source not found');
    }
    if (!existing.fileId) {
      throw new ConflictError('Only file-backed knowledge sources can be rebuilt');
    }
    if (!this.fileService) {
      throw new ConflictError('OKF ingestion is not configured');
    }
    await this.queueIngestion(workspaceId, id, Number(existing.fileId), userId, options.allowSystemAdmin);
    return this.getById(workspaceId, id, userId, options);
  }

  async delete(workspaceId: string, id: number, userId: string, options: KnowledgeOperationOptions = {}) {
    await this.workspaceService.ensureMembership(workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options.allowSystemAdmin,
    });
    const existing = await this.db('knowledge_sources').where({ id, workspaceId }).first();
    if (!existing) {
      throw new NotFoundError('Knowledge source not found');
    }
    const sourceFileId = existing.fileId ? Number(existing.fileId) : null;
    const sourceMetadata = this.normalizeMetadata(existing.metadata);
    const deleteManagedUpload = Boolean(existing.isGlobal && sourceMetadata.source === 'upload');
    const deleted = await this.db('knowledge_sources').where({ id, workspaceId }).del();
    if (!deleted) {
      throw new NotFoundError('Knowledge source not found');
    }
    if (this.fileService) {
      const knowledgeRoot = path.posix.join(OKF_SYSTEM_ROOT, String(id));
      await this.removeStaleBundleFiles(workspaceId, userId, knowledgeRoot, new Set(), options.allowSystemAdmin);
      if (deleteManagedUpload && sourceFileId) {
        const remainingReferences = await this.db('knowledge_sources')
          .where({ fileId: sourceFileId })
          .count<{ count: string }[]>('* as count')
          .first();
        if (Number(remainingReferences?.count || 0) === 0) {
          await this.fileService.deleteFile(sourceFileId, userId, {
            allowSystemAdmin: options.allowSystemAdmin,
          });
        }
      }
    }
    await this.workspaceService.touchWorkspace(workspaceId, userId);
  }

  private normalizeMetadata(metadata: unknown): Record<string, unknown> {
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      return { ...(metadata as Record<string, unknown>) };
    }
    if (typeof metadata === 'string' && metadata.trim()) {
      try {
        const parsed = JSON.parse(metadata);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return {};
      }
    }
    return {};
  }

  private getIngestionMetadata(metadata: unknown): KnowledgeIngestionMetadata | null {
    const normalized = this.normalizeMetadata(metadata);
    const ingestion = normalized.ingestion;
    return ingestion && typeof ingestion === 'object' && !Array.isArray(ingestion)
      ? ingestion as KnowledgeIngestionMetadata
      : null;
  }

  private withIngestionMetadata(
    metadata: unknown,
    ingestion: KnowledgeIngestionMetadata,
  ): Record<string, unknown> {
    const base = this.normalizeMetadata(metadata);
    const previous = base.ingestion && typeof base.ingestion === 'object' && !Array.isArray(base.ingestion)
      ? base.ingestion as Record<string, unknown>
      : {};
    return {
      ...base,
      ingestion: {
        ...previous,
        ...ingestion,
      },
    };
  }

  private async updateIngestionMetadata(
    workspaceId: string,
    id: number,
    ingestion: KnowledgeIngestionMetadata,
  ): Promise<void> {
    const row = await this.db('knowledge_sources').where({ id, workspaceId }).first();
    if (!row) {
      return;
    }
    await this.db('knowledge_sources')
      .where({ id, workspaceId })
      .update({
        metadata: this.withIngestionMetadata(row.metadata, ingestion),
        updatedAt: this.db.fn.now(),
      });
    const runId = ingestion.runId || this.getIngestionMetadata(row.metadata)?.runId;
    if (runId) {
      const jobPatch: Record<string, unknown> = {};
      for (const key of [
        'status', 'stage', 'sourceFingerprint', 'discoveredSourceUnits', 'processedSourceUnits',
        'failedSourceUnits', 'warnings', 'error', 'snapshotHash', 'bundlePath',
      ]) {
        if ((ingestion as any)[key] !== undefined) jobPatch[key] = (ingestion as any)[key];
      }
      await this.ingestionService.transition(runId, jobPatch);
    }
  }

  private async queueIngestion(
    workspaceId: string,
    id: number,
    sourceFileId: number,
    userId: string,
    allowSystemAdmin = false,
  ): Promise<void> {
    const source = await this.db('knowledge_sources').select('metadata').where({ id, workspaceId }).first();
    const metadata = this.normalizeMetadata(source?.metadata);
    const requestedProfile = String(
      metadata.enrichmentProfile || process.env.KNOWLEDGE_ENRICHMENT_MODE || 'gemini-lite',
    ).trim().toLowerCase();
    const enrichmentMode: 'deterministic' | 'gemini-lite' = requestedProfile === 'deterministic'
      ? 'deterministic'
      : 'gemini-lite';
    const job = await this.ingestionService.queue({
      knowledgeId: id,
      workspaceId,
      sourceFileId,
      configuration: {
        enrichmentMode,
        okfVersion: OKF_VERSION,
        requestedBy: userId,
        allowSystemAdmin,
      },
    });
    await this.updateIngestionMetadata(workspaceId, id, {
      status: 'queued',
      stage: 'queued',
      runId: String(job.id),
      queuedAt: new Date().toISOString(),
      error: null,
      enrichmentMode,
      okfVersion: OKF_VERSION,
    });
    this.scheduleIngestion(workspaceId, id, userId, allowSystemAdmin);
  }

  private scheduleIngestion(workspaceId: string, id: number, userId: string, allowSystemAdmin = false): void {
    if (process.env.KNOWLEDGE_DEDICATED_WORKER === 'true') {
      return;
    }
    if (!this.fileService || this.inFlightIngestions.has(id)) {
      return;
    }
    const promise = this.runIngestion(workspaceId, id, userId, allowSystemAdmin)
      .catch((error) => {
        console.error('OKF knowledge ingestion failed', { workspaceId, knowledgeId: id, error });
      })
      .finally(() => {
        this.inFlightIngestions.delete(id);
        void this.ingestionService.current(id).then((job) => {
          if (job?.status === 'queued') {
            this.scheduleIngestion(workspaceId, id, userId, allowSystemAdmin);
          }
        }).catch(() => undefined);
      });
    this.inFlightIngestions.set(id, promise);
  }

  async processPendingIngestions(limit = 2): Promise<number> {
    const jobs = await this.db('knowledge_ingestion_jobs as job')
      .join('knowledge_ingestion_tasks as task', 'task.runId', 'job.id')
      .where('task.taskType', 'orchestrate')
      .whereIn('job.status', [
        'queued', 'extracting', 'structuring', 'chunking', 'enriching',
        'reducing', 'validating', 'indexing', 'publishing',
      ])
      .andWhere((builder) => {
        builder.where('task.status', 'queued').orWhere((expired) => {
          expired.where('task.status', 'processing').andWhere('task.leaseExpiresAt', '<', new Date());
        });
      })
      .select('job.*')
      .orderBy('job.createdAt', 'asc')
      .limit(Math.max(1, Math.min(8, limit)));
    await Promise.all(jobs.map(async (job) => {
      const configuration = this.normalizeMetadata(job.configuration);
      const userId = String(configuration.requestedBy || '');
      if (!userId) {
        await this.ingestionService.transition(String(job.id), {
          status: 'failed',
          stage: 'failed',
          error: 'Knowledge worker cannot resume a run without requestedBy',
        });
        return;
      }
      await this.runIngestion(
        String(job.workspaceId),
        Number(job.knowledgeId),
        userId,
        configuration.allowSystemAdmin === true,
      );
    }));
    return jobs.length;
  }

  private async runIngestion(workspaceId: string, id: number, userId: string, allowSystemAdmin = false): Promise<void> {
    if (!this.fileService) {
      return;
    }
    let heartbeat: NodeJS.Timeout | null = null;
    try {
      const knowledge = await this.db('knowledge_sources').where({ id, workspaceId }).first();
      if (!knowledge) {
        return;
      }
      if (!knowledge.fileId) {
        throw new ConflictError('Knowledge source is not backed by a file');
      }
      const queuedMode = this.getIngestionMetadata(knowledge.metadata)?.enrichmentMode || 'gemini-lite';
      await this.updateIngestionMetadata(workspaceId, id, {
        status: 'extracting',
        stage: 'extracting',
        startedAt: new Date().toISOString(),
        error: null,
        enrichmentMode: queuedMode,
        okfVersion: OKF_VERSION,
      });
      const sourceFile = await this.fileService.getFileRecord(Number(knowledge.fileId), userId, { allowSystemAdmin });
      const agentAuthToken = signAgentContextToken({
        sub: userId,
        userId,
        workspaceId,
        isAdmin: allowSystemAdmin,
        exp: Math.floor(Date.now() / 1000) + 6 * 60 * 60,
      });
      if (!agentAuthToken) {
        throw new ConflictError('Knowledge ingestion requires AGENT_JWT_SECRET');
      }
      await this.fileService.ensureLocalMirror(sourceFile);
      const sourceFingerprint = `sha256:${await this.fileService.hashFile(sourceFile)}`;
      const runId = this.getIngestionMetadata(knowledge.metadata)?.runId || randomUUID();
      const runRoot = path.posix.join(OKF_SYSTEM_ROOT, String(id), 'runs', runId);
      const hasDurableJob = Boolean(await this.db('knowledge_ingestion_jobs').where({ id: runId }).first());
      if (hasDurableJob) {
        const leaseOwner = `knowledge-worker:${process.pid}`;
        const claimed = await this.ingestionService.claimTask(
          runId,
          'orchestrate',
          leaseOwner,
          120,
        );
        if (!claimed) {
          const exhausted = await this.db('knowledge_ingestion_tasks')
            .where({ runId, taskType: 'orchestrate' })
            .whereRaw('"attempts" >= "maxAttempts"')
            .andWhere((builder) => builder.whereNull('leaseExpiresAt').orWhere('leaseExpiresAt', '<', new Date()))
            .first();
          if (exhausted) {
            await this.updateIngestionMetadata(workspaceId, id, {
              status: 'failed',
              stage: 'failed',
              runId,
              failedAt: new Date().toISOString(),
              error: 'Knowledge ingestion exhausted its retry limit',
              okfVersion: OKF_VERSION,
            });
          }
          return;
        }
        heartbeat = setInterval(() => {
          void this.ingestionService.renewTaskLease(String(claimed.id), leaseOwner, 120)
            .catch((error) => console.error('Knowledge task heartbeat failed', { runId, error }));
        }, 30_000);
        heartbeat.unref();
      }
      const extracted = await this.extractKnowledgeSource(
        workspaceId,
        sourceFile,
        agentAuthToken,
      );
      const discoveredSourceUnits = Number(extracted.manifest?.discoveredSourceUnits ?? extracted.sections.length);
      const processedSourceUnits = Number(extracted.manifest?.processedSourceUnits ?? discoveredSourceUnits);
      const failedSourceUnits = Number(extracted.manifest?.failedSourceUnits ?? 0);
      if (processedSourceUnits + failedSourceUnits !== discoveredSourceUnits) {
        throw new ConflictError('Extraction source-unit accounting is inconsistent');
      }
      const warnings = Array.isArray(extracted.manifest?.warnings) ? extracted.manifest.warnings : [];
      const extractionUsage = Array.isArray(extracted.manifest?.modelUsage)
        ? extracted.manifest.modelUsage
        : [];
      if (extractionUsage.length) {
        await this.db.batchInsert('knowledge_usage_events', extractionUsage.map((event) => ({
          id: randomUUID(),
          runId,
          stage: String(event.stage || 'ocr'),
          provider: String(event.provider || 'google'),
          model: String(event.model || ''),
          promptVersion: 'helpudoc-gemini-ocr/1',
          schemaVersion: 'helpudoc-gemini-ocr-schema/1',
          inputTokens: Number(event.inputTokens || 0),
          cachedInputTokens: Number(event.cachedInputTokens || 0),
          outputTokens: Number(event.outputTokens || 0),
          retries: Number(event.retries || 0),
          latencyMs: Number(event.latencyMs || 0),
          rateCardVersion: knowledgeRateCard().version,
          estimatedCost: estimateKnowledgeUsageCost(event),
        })), 100);
      }
      if (await this.isRunCancelled(runId)) return;
      const sourceMetadata = this.normalizeMetadata(knowledge.metadata);
      const requestedProfile = String(
        sourceMetadata.enrichmentProfile || process.env.KNOWLEDGE_ENRICHMENT_MODE || 'gemini-lite',
      ).trim().toLowerCase();
      const enrichmentMode: 'deterministic' | 'gemini-lite' = requestedProfile === 'deterministic'
        ? 'deterministic'
        : 'gemini-lite';
      await this.updateIngestionMetadata(workspaceId, id, {
        status: 'structuring',
        stage: 'structuring',
        runId,
        sourceFingerprint,
        enrichmentMode,
        discoveredSourceUnits,
        processedSourceUnits,
        failedSourceUnits,
        coveragePercent: discoveredSourceUnits ? Math.round((processedSourceUnits / discoveredSourceUnits) * 10000) / 100 : 100,
        warnings,
        okfVersion: OKF_VERSION,
      });

      await this.updateIngestionMetadata(workspaceId, id, {
        status: 'chunking',
        stage: 'chunking',
        runId,
        sourceFingerprint,
        enrichmentMode,
        discoveredSourceUnits,
        processedSourceUnits,
        failedSourceUnits,
        coveragePercent: discoveredSourceUnits ? Math.round((processedSourceUnits / discoveredSourceUnits) * 10000) / 100 : 100,
        warnings,
        structureNodeCount: extracted.structure.length,
        processingWindowCount: extracted.windows.length,
        okfVersion: OKF_VERSION,
      });

      let mapResults: KnowledgeMapResponse[] = [];
      let reductionResult: KnowledgeMapResponse | null = null;
      let canonicalConcepts: CanonicalConcept[] = [];
      let graphAnalysis: Record<string, any> | null = null;
      if (enrichmentMode === 'gemini-lite') {
        if (!extracted.blocks.length || !extracted.windows.length) {
          throw new ConflictError('Gemini Lite enrichment requires extracted blocks and processing windows');
        }
        await this.updateIngestionMetadata(workspaceId, id, {
          status: 'enriching', stage: 'enriching', runId, sourceFingerprint, enrichmentMode, okfVersion: OKF_VERSION,
        });
        const blockById = new Map(extracted.blocks.map((block) => [String(block.id), block]));
        const structureById = new Map(extracted.structure.map((node) => [String(node.id), node]));
        const parsedConcurrency = Number(process.env.KNOWLEDGE_MAP_CONCURRENCY || 4);
        const concurrency = Number.isFinite(parsedConcurrency) ? Math.max(1, Math.min(8, parsedConcurrency)) : 4;
        for (let offset = 0; offset < extracted.windows.length; offset += concurrency) {
          if (await this.isRunCancelled(runId)) return;
          const batch = extracted.windows.slice(offset, offset + concurrency);
          const responses = await Promise.all(batch.map((window) => {
            const blockIds = Array.from(new Set([
              ...(Array.isArray(window.contextBeforeBlockIds) ? window.contextBeforeBlockIds : []),
              ...(Array.isArray(window.coreBlockIds) ? window.coreBlockIds : []),
              ...(Array.isArray(window.contextAfterBlockIds) ? window.contextAfterBlockIds : []),
            ].map(String)));
            const blocks = blockIds
              .map((blockId) => blockById.get(blockId))
              .filter((block): block is Record<string, unknown> => Boolean(block));
            const structureNode = structureById.get(String(window.structureNodeId || ''));
            const cacheHash = `sha256:${sha256(stableJson({
              windowHash: window.contentHash,
              modelProfile: 'lite',
              promptVersion: 'helpudoc-knowledge-map/2',
              schemaVersion: 'helpudoc-knowledge-map-schema/1',
            }))}`;
            const startedAt = Date.now();
            return this.db('knowledge_ingestion_tasks as task')
              .join('knowledge_ingestion_jobs as job', 'task.runId', 'job.id')
              .where({
                'task.taskType': 'map',
                'task.contentHash': cacheHash,
                'task.status': 'completed',
                'job.workspaceId': workspaceId,
              })
              .whereNotNull('task.result')
              .select('task.result')
              .orderBy('task.updatedAt', 'desc')
              .first()
              .then(async (cachedTask) => {
                if (cachedTask?.result) return cachedTask.result as KnowledgeMapResponse;
                const taskId = randomUUID();
                await this.db('knowledge_ingestion_tasks').insert({
                  id: taskId,
                  runId,
                  taskType: 'map',
                  contentHash: cacheHash,
                  status: 'processing',
                  attempts: 1,
                  input: { windowId: window.id, windowHash: window.contentHash },
                });
                try {
                  const response = await enrichKnowledgeWindow({
                    workspaceId,
                    window,
                    blocks,
                    sourceType: String(extracted.manifest?.sourceType || path.extname(String(sourceFile.name || '')).slice(1) || 'document'),
                    languageDistribution: extracted.languageDistribution,
                    structuralPath: structureNode?.title ? [String(structureNode.title)] : [],
                  }, { authToken: agentAuthToken });
                  await Promise.all([
                    this.db('knowledge_ingestion_tasks').where({ id: taskId }).update({
                      status: 'completed', result: response, updatedAt: this.db.fn.now(),
                    }),
                    this.db('knowledge_usage_events').insert({
                      id: randomUUID(),
                      runId,
                      stage: 'map',
                      provider: response.provider,
                      model: response.model,
                      promptVersion: response.promptVersion,
                      schemaVersion: response.schemaVersion,
                      inputTokens: Number(response.usage?.inputTokens || 0),
                      cachedInputTokens: Number(response.usage?.cachedInputTokens || 0),
                      outputTokens: Number(response.usage?.outputTokens || 0),
                      retries: Math.max(0, Number(response.usage?.attempts || 1) - 1),
                      latencyMs: Date.now() - startedAt,
                      rateCardVersion: knowledgeRateCard().version,
                      estimatedCost: estimateKnowledgeUsageCost(response.usage || {}),
                    }),
                  ]);
                  return response;
                } catch (error) {
                  await this.db('knowledge_ingestion_tasks').where({ id: taskId }).update({
                    status: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                    updatedAt: this.db.fn.now(),
                  });
                  throw error;
                }
              });
          }));
          mapResults.push(...responses);
        }
        await this.updateIngestionMetadata(workspaceId, id, {
          status: 'reducing', stage: 'reducing', runId, sourceFingerprint, enrichmentMode, okfVersion: OKF_VERSION,
        });
        const reduceStartedAt = Date.now();
        reductionResult = await reduceKnowledgeMapResults({
          workspaceId,
          mapResults,
          blocks: extracted.blocks,
          fanIn: Math.max(2, Math.min(8, Number(process.env.KNOWLEDGE_REDUCE_FAN_IN || 6))),
        }, { authToken: agentAuthToken });
        await this.db('knowledge_usage_events').insert({
          id: randomUUID(),
          runId,
          stage: 'reduce',
          provider: reductionResult.provider,
          model: reductionResult.model,
          promptVersion: reductionResult.promptVersion,
          schemaVersion: reductionResult.schemaVersion,
          inputTokens: Number(reductionResult.usage?.inputTokens || 0),
          cachedInputTokens: Number(reductionResult.usage?.cachedInputTokens || 0),
          outputTokens: Number(reductionResult.usage?.outputTokens || 0),
          retries: Math.max(0, Number(reductionResult.usage?.attempts || 1) - 1),
          latencyMs: Date.now() - reduceStartedAt,
          rateCardVersion: knowledgeRateCard().version,
          estimatedCost: estimateKnowledgeUsageCost(reductionResult.usage || {}),
        });
        // Reduction contributes cross-window aliases and relationships, while
        // raw map results remain the lossless evidence-bearing source. Keeping
        // both prevents a model reducer from silently pruning an entire topic.
        canonicalConcepts = pruneThinOrphanConcepts(canonicalizeMapResults([
          ...mapResults,
          reductionResult,
        ]));
        if (!canonicalConcepts.length && processedSourceUnits > 0) {
          throw new ConflictError('Gemini Lite enrichment produced no publishable concepts');
        }
        const candidates = mapResults.flatMap((response, windowIndex) => response.result.concepts.map((candidate, candidateIndex) => ({
          id: randomUUID(),
          runId,
          windowId: null,
          candidateId: `${extracted.windows[windowIndex]?.id || `window-${windowIndex + 1}`}:${candidate.candidateId || candidateIndex + 1}`,
          kind: candidate.kind,
          name: candidate.name,
          payload: candidate,
          confidence: candidate.assertions.length
            ? Math.min(...candidate.assertions.map((assertion) => assertion.confidence))
            : null,
          contentHash: `sha256:${sha256(stableJson(candidate))}`,
        })));
        if (candidates.length) {
          await this.db('knowledge_candidate_concepts').where({ runId }).del();
          await this.db.batchInsert('knowledge_candidate_concepts', candidates, 250);
        }
        await this.updateIngestionMetadata(workspaceId, id, {
          status: 'validating', stage: 'validating', runId, sourceFingerprint, enrichmentMode, okfVersion: OKF_VERSION,
        });
      }

      const wikiPlan = buildKnowledgeGraphPlan(canonicalConcepts);
      if (canonicalConcepts.length) {
        graphAnalysis = await analyzeKnowledgeGraph({
          workspaceId,
          concepts: canonicalConcepts,
        }, { authToken: agentAuthToken });
      }

      const sourceName = normalizedUploadName(sourceFile.name);
      const stableDate = new Date(sourceFile.updatedAt || sourceFile.createdAt || 0);
      const generatedAt = Number.isNaN(stableDate.getTime())
        ? '1970-01-01T00:00:00.000Z'
        : stableDate.toISOString();
      const encodedName = sourceName.split('/').map((part) => encodeURIComponent(part)).join('/');
      const sourceResource = `workspace-file://${workspaceId}/${encodedName}?${sourceFingerprint.replace(':', '=')}`;
      const tags = Array.isArray(knowledge.tags)
        ? knowledge.tags.map((item: unknown) => String(item).trim()).filter(Boolean)
        : [];
      const description = String(knowledge.description || extracted.summary || '').trim();
      const snapshot = {
        schemaVersion: 'helpudoc-enrichment-snapshot/1',
        knowledgeId: id,
        workspaceId,
        sourceFileId: Number(knowledge.fileId),
        sourceFingerprint,
        extractorVersion: extracted.manifest?.extractorVersion || 'helpudoc-extractor/legacy',
        enrichmentVersion: enrichmentMode === 'gemini-lite'
          ? 'helpudoc-enrichment/gemini-lite-2'
          : 'helpudoc-enrichment/deterministic-1',
        okfGeneratorVersion: OKF_GENERATOR,
        enrichmentMode,
        title: String(knowledge.title || extracted.title || sourceName),
        description,
        tags,
        sourceResource,
        extraction: {
          discoveredSourceUnits,
          processedSourceUnits,
          failedSourceUnits,
          warnings,
          blocks: extracted.blocks,
        },
        structure: extracted.structure,
        windows: extracted.windows,
        sections: extracted.sections,
        mapResults,
        reductions: reductionResult ? [reductionResult] : [],
        wikiPlan,
        graphAnalysis,
        canonicalGraph: { concepts: canonicalConcepts },
        markdown: extracted.markdown,
      };
      const snapshotJson = stableJson(snapshot);
      const snapshotDigest = sha256(snapshotJson);
      const snapshotHash = `sha256:${snapshotDigest}`;
      const bundlePath = path.posix.join(OKF_SYSTEM_ROOT, String(id), 'bundles', snapshotDigest);
      const usageAtSnapshot = await this.db('knowledge_usage_events').where({ runId }).orderBy('createdAt', 'asc');
      const costReport = {
        schemaVersion: 'helpudoc-knowledge-cost/1',
        rateCard: knowledgeRateCard(),
        totals: usageAtSnapshot.reduce((totals, event) => ({
          inputTokens: totals.inputTokens + Number(event.inputTokens || 0),
          cachedInputTokens: totals.cachedInputTokens + Number(event.cachedInputTokens || 0),
          outputTokens: totals.outputTokens + Number(event.outputTokens || 0),
          estimatedCost: totals.estimatedCost + Number(event.estimatedCost || 0),
        }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCost: 0 }),
        events: usageAtSnapshot,
      };

      const artifactFiles = new Map<string, { content: string; mimeType: string }>([
        [path.posix.join(runRoot, 'manifest.json'), {
          content: stableJson({
            knowledgeId: id,
            runId,
            sourceFingerprint,
            extractorVersion: snapshot.extractorVersion,
            enrichmentVersion: snapshot.enrichmentVersion,
            okfGeneratorVersion: OKF_GENERATOR,
            modelProfile: enrichmentMode === 'gemini-lite' ? 'lite' : null,
            enrichmentMode,
            status: failedSourceUnits ? 'partial' : 'published',
          }),
          mimeType: 'application/json',
        }],
        [path.posix.join(runRoot, 'extraction', 'document.json'), {
          content: stableJson({ title: extracted.title, summary: extracted.summary, manifest: extracted.manifest }),
          mimeType: 'application/json',
        }],
        [path.posix.join(runRoot, 'extraction', 'blocks.jsonl'), {
          content: extracted.blocks.map((block) => JSON.stringify(block)).join('\n'),
          mimeType: 'application/x-ndjson',
        }],
        [path.posix.join(runRoot, 'extraction', 'warnings.json'), {
          content: stableJson(warnings),
          mimeType: 'application/json',
        }],
        [path.posix.join(runRoot, 'structure', 'hierarchy.json'), {
          content: stableJson(extracted.structure),
          mimeType: 'application/json',
        }],
        [path.posix.join(runRoot, 'structure', 'windows.jsonl'), {
          content: extracted.windows.map((window) => JSON.stringify(window)).join('\n'),
          mimeType: 'application/x-ndjson',
        }],
        [path.posix.join(runRoot, 'enrichment', 'map-results.jsonl'), {
          content: mapResults.map((result) => JSON.stringify(result)).join('\n'),
          mimeType: 'application/x-ndjson',
        }],
        [path.posix.join(runRoot, 'enrichment', 'reductions.jsonl'), {
          content: reductionResult ? JSON.stringify(reductionResult) : '',
          mimeType: 'application/x-ndjson',
        }],
        [path.posix.join(runRoot, 'enrichment', 'canonical-graph.json'), {
          content: stableJson({ concepts: canonicalConcepts }),
          mimeType: 'application/json',
        }],
        [path.posix.join(runRoot, 'enrichment', 'wiki-plan.json'), {
          content: stableJson(wikiPlan),
          mimeType: 'application/json',
        }],
        [path.posix.join(runRoot, 'enrichment', 'graph-analysis.json'), {
          content: stableJson(graphAnalysis || {}),
          mimeType: 'application/json',
        }],
        [path.posix.join(runRoot, 'enrichment', 'validation-report.json'), {
          content: stableJson({
            schemaVersion: 'helpudoc-okf-validation/1',
            graph: wikiPlan.quality,
            clustering: graphAnalysis,
          }),
          mimeType: 'application/json',
        }],
        [path.posix.join(runRoot, 'enrichment', 'cost.json'), {
          content: stableJson(costReport),
          mimeType: 'application/json',
        }],
        [path.posix.join(runRoot, 'snapshot.json'), { content: snapshotJson, mimeType: 'application/json' }],
      ]);
      for (const [fileName, artifact] of artifactFiles) {
        await this.fileService.upsertInternalTextFile(
          workspaceId,
          fileName,
          artifact.content,
          userId,
          artifact.mimeType,
          { allowSystemAdmin },
        );
      }

      await this.updateIngestionMetadata(workspaceId, id, {
        status: 'publishing',
        stage: 'publishing',
        runId,
        sourceFingerprint,
        snapshotHash,
        enrichmentMode,
        okfVersion: OKF_VERSION,
      });
      const documents = new Map<string, string>();
      documents.set(
        path.posix.join(bundlePath, 'source.md'),
        this.buildOkfConcept({
          type: 'Reference',
          title: String(knowledge.title || extracted.title || sourceName),
          description,
          resource: sourceResource,
          tags,
          generatedAt,
          sourceTitle: sourceName,
          sourceResource,
          body: extracted.markdown,
        }),
      );

      const sectionEntries: Array<{ title: string; fileName: string; path: string; description: string }> = [];
      if (canonicalConcepts.length) {
        for (const concept of canonicalConcepts) {
          documents.set(
            path.posix.join(bundlePath, concept.path),
            this.buildEnrichedOkfConcept({
              concept,
              concepts: canonicalConcepts,
              generatedAt,
              sourceTitle: sourceName,
              sourceResource,
              blocks: extracted.blocks,
            }),
          );
          sectionEntries.push({
            title: concept.name,
            fileName: concept.path.replace(/^concepts\//, ''),
            path: concept.path,
            description: concept.description,
          });
        }
      } else {
        const usedNames = new Set<string>();
        for (const [sectionIndex, section] of extracted.sections.entries()) {
          const baseName = slugify(section.title, `section-${sectionIndex + 1}`);
          let fileName = `${baseName}.md`;
          let suffix = 2;
          while (usedNames.has(fileName)) {
            fileName = `${baseName}-${suffix}.md`;
            suffix += 1;
          }
          usedNames.add(fileName);
          const sectionDescription = section.body
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 240);
          const conceptPath = `concepts/${fileName}`;
          documents.set(
            path.posix.join(bundlePath, conceptPath),
            this.buildOkfConcept({
              type: 'Knowledge Section',
              title: section.title,
              description: sectionDescription,
              resource: sourceResource,
              tags,
              generatedAt,
              sourceTitle: sourceName,
              sourceResource,
              body: `${section.body}\n\n[Back to the source concept](../source.md)`,
            }),
          );
          sectionEntries.push({ title: section.title, fileName, path: conceptPath, description: sectionDescription });
        }
      }

      const indexLines = [
        '---',
        `okf_version: ${quoteYaml(OKF_VERSION)}`,
        '---',
        '',
        `# ${String(knowledge.title || extracted.title || sourceName).trim()}`,
        '',
        description || `Knowledge generated from ${sourceName}.`,
        '',
        '# Source',
        '',
        `* [${String(knowledge.title || extracted.title || sourceName).trim()}](source.md) - ${description || `Source material from ${sourceName}`}`,
      ];
      if (sectionEntries.length) {
        indexLines.push('', '# Concepts', '');
        for (const entry of sectionEntries) {
          indexLines.push(
            `* [${entry.title}](${entry.path}) - ${entry.description || 'Derived knowledge concept'}`,
          );
        }
      }
      documents.set(path.posix.join(bundlePath, 'index.md'), `${indexLines.join('\n').trim()}\n`);
      documents.set(
        path.posix.join(bundlePath, 'log.md'),
        `# Knowledge Update Log\n\n## ${generatedAt.slice(0, 10)}\n\n* **Update**: Published ${enrichmentMode} OKF bundle from [${sourceName}](source.md).\n* **Snapshot**: ${snapshotHash}\n* **Coverage**: ${processedSourceUnits}/${discoveredSourceUnits} source units processed.\n`,
      );

      const mermaidValidation = repairInvalidMermaidFences(documents);
      validateOkfDocuments(bundlePath, documents);
      const bundleManifest = buildOkfBundleManifest({
        snapshotHash,
        sourceFingerprint,
        enrichmentMode,
        coverage: {
          discoveredSourceUnits,
          processedSourceUnits,
          failedSourceUnits,
        },
        bundlePath,
        documents,
        validation: {
          graph: wikiPlan.quality,
          mermaid: mermaidValidation,
        },
      });
      documents.set(path.posix.join(bundlePath, 'manifest.json'), `${stableJson(bundleManifest)}\n`);
      validateOkfDocuments(bundlePath, documents);

      for (const [fileName, content] of documents) {
        await this.fileService.upsertInternalTextFile(
          workspaceId,
          fileName,
          content,
          userId,
          fileName.endsWith('.json') ? 'application/json' : 'text/markdown',
          { allowSystemAdmin },
        );
      }
      await this.removeStaleBundleFiles(
        workspaceId,
        userId,
        bundlePath,
        new Set(documents.keys()),
        allowSystemAdmin,
      );
      const snapshotId = await this.persistSnapshotState({
        runId,
        knowledgeId: id,
        snapshotHash,
        snapshotPath: path.posix.join(runRoot, 'snapshot.json'),
        blocks: extracted.blocks,
        structure: extracted.structure,
        windows: extracted.windows,
        concepts: sectionEntries,
        canonicalConcepts,
        graphAnalysis,
      });
      if (snapshotId && process.env.KNOWLEDGE_VECTOR_ENABLED === 'true' && canonicalConcepts.length) {
        try {
          await this.persistConceptEmbeddings({
            snapshotId,
            runId,
            workspaceId,
            concepts: canonicalConcepts,
            agentAuthToken,
            sourceRelativePath: String(sourceFile.name || ''),
            mediaPages: (extracted.manifest?.mediaArtifacts || [])
              .map((artifact) => Number(artifact.page || 0))
              .filter((page) => page > 0),
          });
        } catch (error) {
          warnings.push({
            sourceUnit: 'document',
            code: 'vector_index_failed',
            message: `Lexical/graph publication succeeded, but the optional vector index failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      if (await this.isRunCancelled(runId)) return;
      await this.fileService.upsertInternalTextFile(
        workspaceId,
        path.posix.join(OKF_SYSTEM_ROOT, String(id), 'current.json'),
        `${stableJson({ snapshotHash, bundlePath, runId, publishedAt: generatedAt })}\n`,
        userId,
        'application/json',
        { allowSystemAdmin },
      );
      if (snapshotId) {
        await this.db.transaction(async (trx) => {
          await trx('knowledge_snapshots').where({ knowledgeId: id }).update({ isPublished: false });
          await trx('knowledge_snapshots').where({ id: snapshotId }).update({
            isPublished: true,
            publishedAt: trx.fn.now(),
          });
        });
      }
      await this.db('knowledge_ingestion_tasks')
        .where({ runId, taskType: 'orchestrate' })
        .update({
          status: 'completed',
          contentHash: sourceFingerprint,
          result: { snapshotHash, bundlePath },
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: this.db.fn.now(),
        });
      const usageEvents = await this.db('knowledge_usage_events').where({ runId });
      const usageTotals = usageEvents.reduce((totals, event) => ({
        inputTokens: totals.inputTokens + Number(event.inputTokens || 0),
        outputTokens: totals.outputTokens + Number(event.outputTokens || 0),
        estimatedCost: totals.estimatedCost + Number(event.estimatedCost || 0),
      }), { inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
      await this.updateIngestionMetadata(workspaceId, id, {
        status: failedSourceUnits ? 'partial' : 'published',
        stage: failedSourceUnits ? 'partial' : 'published',
        publishedAt: new Date().toISOString(),
        error: null,
        sourceFingerprint,
        runId,
        snapshotHash,
        bundlePath,
        conceptCount: sectionEntries.length,
        relationshipCount: canonicalConcepts.reduce((count, concept) => count + concept.relationships.length, 0),
        structureNodeCount: extracted.structure.length,
        processingWindowCount: extracted.windows.length,
        discoveredSourceUnits,
        processedSourceUnits,
        failedSourceUnits,
        coveragePercent: discoveredSourceUnits ? Math.round((processedSourceUnits / discoveredSourceUnits) * 10000) / 100 : 100,
        warnings,
        modelCalls: usageEvents.length,
        inputTokens: usageTotals.inputTokens,
        outputTokens: usageTotals.outputTokens,
        estimatedCost: Math.round(usageTotals.estimatedCost * 100_000_000) / 100_000_000,
        enrichmentMode,
        okfVersion: OKF_VERSION,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedSource = await this.db('knowledge_sources').select('metadata').where({ id, workspaceId }).first();
      const failedRunId = this.getIngestionMetadata(failedSource?.metadata)?.runId;
      if (failedRunId) {
        await this.db('knowledge_ingestion_tasks')
          .where({ runId: failedRunId, status: 'processing' })
          .update({ status: 'failed', error: message, updatedAt: this.db.fn.now() });
      }
      await this.updateIngestionMetadata(workspaceId, id, {
        status: 'failed',
        stage: 'failed',
        failedAt: new Date().toISOString(),
        error: message,
        okfVersion: OKF_VERSION,
      });
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  private async extractKnowledgeSource(
    workspaceId: string,
    sourceFile: any,
    agentAuthToken: string,
  ): Promise<{
    title: string;
    summary: string;
    markdown: string;
    sections: Array<{ title: string; body: string }>;
    manifest?: {
      extractorVersion: string;
      sourceType: string;
      discoveredSourceUnits: number;
      processedSourceUnits: number;
      failedSourceUnits: number;
      needsOcrSourceUnits?: number;
      converter?: string;
      markdownConverter?: string | null;
      locatorStrategy?: string;
      mediaType?: string | null;
      ocrMode?: 'off' | 'auto' | 'always';
      ocrProvider?: string | null;
      ocrModel?: string | null;
      ocrTextThreshold?: number;
      modelUsage?: Array<{
        stage: string;
        provider: string;
        model: string;
        sourceUnits: string[];
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        retries: number;
        latencyMs: number;
        outcome: 'completed' | 'failed' | 'cached';
        error?: string | null;
      }>;
      mediaArtifacts?: Array<Record<string, unknown>>;
      warnings?: Array<{ sourceUnit: string; code: string; message: string }>;
    };
    blocks: Array<Record<string, unknown>>;
    structure: Array<Record<string, unknown>>;
    windows: Array<Record<string, unknown>>;
    languageDistribution: Record<string, number>;
  }> {
    const extension = path.extname(String(sourceFile.name || '')).toLowerCase();
    const title = path.basename(String(sourceFile.name || 'Knowledge source'));
    const response = await extractWorkspaceDocument(workspaceId, sourceFile.name, { authToken: agentAuthToken });
    const markdown = String(response.markdown || '').trim();
    return {
      title: String(response.title || title),
      summary: String(response.summary || `Knowledge generated from ${title}`),
      markdown,
      sections: semanticSectionsFromPlan(markdown, response.blocks || [], response.structure || []),
      manifest: response.manifest,
      blocks: response.blocks || [],
      structure: response.structure || [],
      windows: response.windows || [],
      languageDistribution: response.languageDistribution || {},
    };
  }

  private buildOkfConcept(input: {
    type: string;
    title: string;
    description: string;
    resource: string;
    tags: string[];
    generatedAt: string;
    sourceTitle: string;
    sourceResource: string;
    body: string;
  }): string {
    const frontmatter = [
      '---',
      `type: ${quoteYaml(input.type)}`,
      `title: ${quoteYaml(input.title)}`,
      `description: ${quoteYaml(input.description)}`,
      `resource: ${quoteYaml(input.resource)}`,
      `tags: [${input.tags.map(quoteYaml).join(', ')}]`,
      'status: active',
      'generated:',
      `  by: ${quoteYaml(OKF_GENERATOR)}`,
      `  at: ${quoteYaml(input.generatedAt)}`,
      'sources:',
      '  - id: source-file',
      `    resource: ${quoteYaml(input.sourceResource)}`,
      `    title: ${quoteYaml(input.sourceTitle)}`,
      '---',
    ];
    return `${frontmatter.join('\n')}\n\n${String(input.body || '').trim()}\n`;
  }

  private buildEnrichedOkfConcept(input: {
    concept: CanonicalConcept;
    concepts: CanonicalConcept[];
    generatedAt: string;
    sourceTitle: string;
    sourceResource: string;
    blocks: Array<Record<string, unknown>>;
  }): string {
    const byId = new Map(input.blocks.map((block) => [String(block.id || ''), block]));
    const evidenceGroups = [
      ...input.concept.assertions.map((assertion) => assertion.blockIds),
      ...input.concept.relationships.map((relationship) => relationship.blockIds),
    ].filter((ids) => ids.length);
    const uniqueGroups = Array.from(new Map(
      evidenceGroups.map((ids) => [Array.from(new Set(ids)).sort().join('|'), Array.from(new Set(ids)).sort()]),
    ).values());
    const frontmatter = [
      '---',
      `type: ${quoteYaml(input.concept.kind)}`,
      `title: ${quoteYaml(input.concept.name)}`,
      `description: ${quoteYaml(input.concept.description)}`,
      `resource: ${quoteYaml(`${input.sourceResource}#concept=${encodeURIComponent(input.concept.id)}`)}`,
      `tags: [${input.concept.tags.map(quoteYaml).join(', ')}]`,
      'status: active',
      'generated:',
      `  by: ${quoteYaml('helpudoc-enrichment/gemini-lite-2')}`,
      `  at: ${quoteYaml(input.generatedAt)}`,
      'sources:',
    ];
    if (!uniqueGroups.length) {
      frontmatter.push(
        '  - id: source-file',
        `    resource: ${quoteYaml(input.sourceResource)}`,
        `    title: ${quoteYaml(input.sourceTitle)}`,
      );
    } else {
      uniqueGroups.forEach((blockIds, index) => {
        const pages = blockIds.map((blockId) => byId.get(blockId)?.page).filter((page): page is number => typeof page === 'number');
        const units = blockIds.map((blockId) => byId.get(blockId)?.unit).filter((unit): unit is number => typeof unit === 'number');
        const unitTypes = Array.from(new Set(
          blockIds.map((blockId) => String(byId.get(blockId)?.unitType || '')).filter(Boolean),
        ));
        const locatorKind = pages.length
          ? 'pdf_page_range'
          : units.length && unitTypes.length === 1 ? `${unitTypes[0]}_range` : 'source_blocks';
        frontmatter.push(
          `  - id: ${quoteYaml(`source-span-${index + 1}`)}`,
          `    resource: ${quoteYaml(input.sourceResource)}`,
          `    title: ${quoteYaml(input.sourceTitle)}`,
          '    locator:',
          `      kind: ${quoteYaml(locatorKind)}`,
          ...(pages.length ? [
            `      start: ${Math.min(...pages)}`,
            `      end: ${Math.max(...pages)}`,
          ] : units.length && unitTypes.length === 1 ? [
            `      unit_type: ${quoteYaml(unitTypes[0])}`,
            `      start: ${Math.min(...units)}`,
            `      end: ${Math.max(...units)}`,
          ] : []),
          `      block_ids: [${blockIds.map(quoteYaml).join(', ')}]`,
        );
      });
    }
    const body = [`# ${input.concept.name}`, '', input.concept.description];
    if (input.concept.aliases.length) {
      body.push('', '## Aliases', '', input.concept.aliases.join(', '));
    }
    if (input.concept.assertions.length) {
      body.push('', '## Evidence-backed assertions', '');
      for (const assertion of input.concept.assertions) {
        const location = assertion.pageStart
          ? `pages ${assertion.pageStart}${assertion.pageEnd && assertion.pageEnd !== assertion.pageStart ? `-${assertion.pageEnd}` : ''}`
          : `blocks ${assertion.blockIds.join(', ')}`;
        body.push(`* ${assertion.text} _(${location}; confidence ${assertion.confidence.toFixed(2)})_`);
      }
    }
    if (input.concept.relationships.length) {
      body.push('', '## Relationships', '');
      for (const relationship of input.concept.relationships) {
        const target = input.concepts.find((concept) => concept.id === relationship.targetId);
        if (!target) continue;
        const link = path.posix.relative(path.posix.dirname(input.concept.path), target.path);
        const relationshipLabel = relationship.type.replace(/_/g, ' ');
        body.push(
          `* ${relationshipLabel} [${target.name}](${link}) _(${relationship.confidenceClass.toLowerCase()}; confidence ${relationship.confidence.toFixed(2)})_`,
        );
      }
    }
    const sourceLink = path.posix.relative(path.posix.dirname(input.concept.path), 'source.md');
    body.push('', `[Read the original source](${sourceLink})`);
    return `${frontmatter.join('\n')}\n---\n\n${body.join('\n').trim()}\n`;
  }

  private resolvePublishedBundle(knowledge: any): { bundlePath: string; okfVersion: string } {
    const ingestion = this.getIngestionMetadata(knowledge.metadata);
    if (!['published', 'partial'].includes(String(ingestion?.status)) || !ingestion?.bundlePath) {
      throw new ConflictError('Knowledge source has not published an OKF bundle');
    }
    return {
      bundlePath: String(ingestion.bundlePath),
      okfVersion: String(ingestion.okfVersion || OKF_VERSION),
    };
  }

  private normalizeBundleRelativePath(relativePath: string): string {
    const raw = String(relativePath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    const normalized = path.posix.normalize(raw);
    if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
      throw new ConflictError('Invalid OKF bundle path');
    }
    if (!['.md', '.json'].includes(path.posix.extname(normalized).toLowerCase())) {
      throw new ConflictError('OKF bundle files must be Markdown');
    }
    return normalized;
  }

  private bundleFileKind(relativePath: string): KnowledgeBundleFile['kind'] {
    if (relativePath === 'index.md') return 'index';
    if (relativePath === 'source.md') return 'source';
    if (relativePath === 'log.md') return 'log';
    if (relativePath.startsWith('concepts/')) return 'concept';
    return 'other';
  }

  private async getBundleManifest(
    knowledge: any,
    userId: string,
    allowSystemAdmin = false,
  ): Promise<KnowledgeBundleManifest> {
    if (!this.fileService) {
      throw new ConflictError('OKF ingestion is not configured');
    }
    const { bundlePath, okfVersion } = this.resolvePublishedBundle(knowledge);
    if (!allowSystemAdmin) {
      await this.workspaceService.ensureMembership(String(knowledge.workspaceId), userId);
    }
    const rows = await this.db('files')
      .where({ workspaceId: knowledge.workspaceId })
      .whereLike('name', `${bundlePath}/%`)
      .orderBy('name', 'asc');
    const prefix = `${bundlePath}/`;
    const rank: Record<KnowledgeBundleFile['kind'], number> = {
      index: 0,
      source: 1,
      concept: 2,
      log: 3,
      other: 4,
    };
    const files = rows.map((row: any) => {
      const relativePath = String(row.name).slice(prefix.length);
      const kind = this.bundleFileKind(relativePath);
      return {
        id: Number(row.id),
        path: relativePath,
        name: path.posix.basename(relativePath),
        kind,
        mimeType: row.mimeType ? String(row.mimeType) : null,
        updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      } satisfies KnowledgeBundleFile;
    }).sort((left: KnowledgeBundleFile, right: KnowledgeBundleFile) => (
      rank[left.kind] - rank[right.kind] || left.path.localeCompare(right.path, undefined, { numeric: true })
    ));
    return {
      knowledgeId: Number(knowledge.id),
      title: String(knowledge.title),
      okfVersion,
      bundlePath,
      snapshotHash: this.getIngestionMetadata(knowledge.metadata)?.snapshotHash || null,
      enrichmentMode: this.getIngestionMetadata(knowledge.metadata)?.enrichmentMode || null,
      coverage: {
        discoveredSourceUnits: Number(this.getIngestionMetadata(knowledge.metadata)?.discoveredSourceUnits || 0),
        processedSourceUnits: Number(this.getIngestionMetadata(knowledge.metadata)?.processedSourceUnits || 0),
        failedSourceUnits: Number(this.getIngestionMetadata(knowledge.metadata)?.failedSourceUnits || 0),
        coveragePercent: Number(this.getIngestionMetadata(knowledge.metadata)?.coveragePercent || 0),
      },
      statistics: {
        conceptCount: Number(this.getIngestionMetadata(knowledge.metadata)?.conceptCount || 0),
        relationshipCount: Number(this.getIngestionMetadata(knowledge.metadata)?.relationshipCount || 0),
        structureNodeCount: Number(this.getIngestionMetadata(knowledge.metadata)?.structureNodeCount || 0),
        processingWindowCount: Number(this.getIngestionMetadata(knowledge.metadata)?.processingWindowCount || 0),
      },
      warnings: this.getIngestionMetadata(knowledge.metadata)?.warnings || [],
      files,
    };
  }

  private async readBundleFile(
    knowledge: any,
    userId: string,
    relativePath: string,
    allowSystemAdmin = false,
  ) {
    if (!this.fileService) {
      throw new ConflictError('OKF ingestion is not configured');
    }
    const { bundlePath } = this.resolvePublishedBundle(knowledge);
    const normalized = this.normalizeBundleRelativePath(relativePath);
    const fullPath = path.posix.join(bundlePath, normalized);
    if (!fullPath.startsWith(`${bundlePath}/`)) {
      throw new ConflictError('Invalid OKF bundle path');
    }
    const row = await this.db('files').where({
      workspaceId: knowledge.workspaceId,
      name: fullPath,
    }).first();
    if (!row) {
      throw new NotFoundError('OKF bundle file not found');
    }
    const file = allowSystemAdmin
      ? row
      : await this.fileService.getFileRecord(Number(row.id), userId);
    const content = (await this.fileService.readFileBuffer(file)).toString('utf-8');
    return {
      id: Number(row.id),
      path: normalized,
      name: path.posix.basename(normalized),
      kind: this.bundleFileKind(normalized),
      mimeType: row.mimeType ? String(row.mimeType) : 'text/markdown',
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      content,
    };
  }

  private async removeStaleBundleFiles(
    workspaceId: string,
    userId: string,
    bundlePath: string,
    retainedPaths: Set<string>,
    allowSystemAdmin = false,
  ): Promise<void> {
    if (!this.fileService) {
      return;
    }
    const rows = await this.db('files')
      .where({ workspaceId })
      .whereLike('name', `${bundlePath}/%`);
    for (const row of rows) {
      if (!retainedPaths.has(String(row.name))) {
        await this.fileService.deleteFile(Number(row.id), userId, { allowSystemAdmin });
      }
    }
  }

  private async persistSnapshotState(input: {
    runId: string;
    knowledgeId: number;
    snapshotHash: string;
    snapshotPath: string;
    blocks: Array<Record<string, unknown>>;
    structure: Array<Record<string, unknown>>;
    windows: Array<Record<string, unknown>>;
    concepts: Array<{ title: string; fileName: string; path: string; description: string }>;
    canonicalConcepts: CanonicalConcept[];
    graphAnalysis?: Record<string, any> | null;
  }): Promise<string | null> {
    const job = await this.db('knowledge_ingestion_jobs').where({ id: input.runId }).first();
    if (!job) return null;
    return this.db.transaction(async (trx) => {
      if (input.blocks.length) {
        await trx('knowledge_source_blocks').where({ runId: input.runId }).del();
        await trx.batchInsert('knowledge_source_blocks', input.blocks.map((block, index) => ({
          runId: input.runId,
          blockId: String(block.id || `block-${index + 1}`),
          ordinal: Number(block.ordinal ?? index),
          blockType: String(block.blockType || 'paragraph'),
          text: String(block.text || ''),
          locator: {
            page: block.page ?? null,
            paragraph: block.paragraph ?? null,
            table: block.table ?? null,
            row: block.row ?? null,
            cell: block.cell ?? null,
            headingPath: block.headingPath ?? null,
            bbox: block.bbox ?? null,
          },
          extractionMethod: String(block.extractionMethod || 'native'),
          extractionConfidence: Number(block.extractionConfidence ?? 1),
          contentHash: String(block.contentHash || `sha256:${sha256(String(block.text || ''))}`),
        })), 250);
      }
      if (input.structure.length) {
        await trx('knowledge_structure_nodes').where({ runId: input.runId }).del();
        await trx.batchInsert('knowledge_structure_nodes', input.structure.map((node, index) => ({
          id: randomUUID(),
          runId: input.runId,
          externalId: String(node.id || `structure:${index}`),
          title: String(node.title || `Section ${index + 1}`),
          level: Number(node.level ?? 0),
          blockIds: node.blockIds || [],
          signals: node.signals || [],
          confidence: Number(node.confidence ?? 0),
          sourceRange: { start: node.sourceStart ?? null, end: node.sourceEnd ?? null },
        })), 250);
      }
      if (input.windows.length) {
        await trx('knowledge_processing_windows').where({ runId: input.runId }).del();
        await trx.batchInsert('knowledge_processing_windows', input.windows.map((window, index) => ({
          id: randomUUID(),
          runId: input.runId,
          externalId: String(window.id || `window-${index + 1}`),
          structureNodeId: String(window.structureNodeId || 'structure:root'),
          coreBlockIds: window.coreBlockIds || [],
          contextBeforeBlockIds: window.contextBeforeBlockIds || [],
          contextAfterBlockIds: window.contextAfterBlockIds || [],
          tokenCount: Number(window.tokenCount ?? 0),
          contentHash: String(window.contentHash || ''),
          strategy: String(window.strategy || 'structural'),
          status: 'completed',
        })), 250);
      }
      let snapshot = await trx('knowledge_snapshots')
        .where({ knowledgeId: input.knowledgeId, contentHash: input.snapshotHash })
        .first();
      if (!snapshot) {
        const snapshotId = randomUUID();
        [snapshot] = await trx('knowledge_snapshots').insert({
          id: snapshotId,
          runId: input.runId,
          knowledgeId: input.knowledgeId,
          contentHash: input.snapshotHash,
          artifactPath: input.snapshotPath,
          generatorVersion: OKF_GENERATOR,
        }).returning('*');
      }
      const snapshotId = String(snapshot.id);
      const existingConcepts = await trx('knowledge_concepts').where({ snapshotId }).count('* as count').first();
      if (Number((existingConcepts as any)?.count || 0) === 0 && input.concepts.length) {
        const concepts = input.canonicalConcepts.length
          ? input.canonicalConcepts.map((concept) => ({
              snapshotId,
              id: concept.id,
              kind: concept.kind,
              name: concept.name,
              description: concept.description,
              aliases: concept.aliases,
              tags: concept.tags,
              path: concept.path,
              confidence: concept.assertions.length
                ? Math.min(...concept.assertions.map((assertion) => assertion.confidence))
                : 1,
            }))
          : input.concepts.map((concept, index) => ({
              snapshotId,
              id: `section:${concept.fileName.replace(/\.md$/i, '') || index + 1}`,
              kind: 'Knowledge Section',
              name: concept.title,
              description: concept.description,
              aliases: [],
              tags: [],
              path: concept.path,
              confidence: 1,
            }));
        await trx.batchInsert('knowledge_concepts', concepts, 250);
        if (input.canonicalConcepts.length) {
          const evidenceIds = new Map<string, string>();
          const allEvidence = input.canonicalConcepts.flatMap((concept) => [
            ...concept.assertions.map((assertion) => assertion.blockIds),
            ...concept.relationships.map((relationship) => relationship.blockIds),
          ]).filter((blockIds) => blockIds.length);
          for (const blockIds of allEvidence) {
            const normalized = Array.from(new Set(blockIds)).sort();
            const key = normalized.join('|');
            if (evidenceIds.has(key)) continue;
            const evidenceId = randomUUID();
            evidenceIds.set(key, evidenceId);
            await trx('knowledge_evidence_spans').insert({
              id: evidenceId,
              snapshotId,
              sourceFileId: job.sourceFileId || null,
              blockIds: normalized,
              locator: { kind: 'source_blocks', blockIds: normalized },
              contentHash: `sha256:${sha256(key)}`,
            });
          }
          const assertions = input.canonicalConcepts.flatMap((concept) => concept.assertions.map((assertion) => {
            const key = Array.from(new Set(assertion.blockIds)).sort().join('|');
            return {
              id: randomUUID(),
              snapshotId,
              conceptId: concept.id,
              text: assertion.text,
              confidence: assertion.confidence,
              evidenceSpanIds: evidenceIds.get(key) ? [evidenceIds.get(key)] : [],
              contentHash: `sha256:${sha256(`${concept.id}\n${assertion.text}`)}`,
            };
          }));
          if (assertions.length) await trx.batchInsert('knowledge_assertions', assertions, 250);
          const relationships = input.canonicalConcepts.flatMap((concept) => concept.relationships.map((relationship) => {
            const key = Array.from(new Set(relationship.blockIds)).sort().join('|');
            return {
              id: randomUUID(),
              snapshotId,
              sourceConceptId: concept.id,
              targetConceptId: relationship.targetId,
              type: relationship.type,
              confidenceClass: relationship.confidenceClass,
              confidence: relationship.confidence,
              evidenceSpanIds: evidenceIds.get(key) ? [evidenceIds.get(key)] : [],
            };
          }));
          if (relationships.length) await trx.batchInsert('knowledge_relationships', relationships, 250);

          const neighbors = new Map(input.canonicalConcepts.map((concept) => [concept.id, new Set<string>()]));
          for (const relationship of relationships) {
            neighbors.get(relationship.sourceConceptId)?.add(relationship.targetConceptId);
            neighbors.get(relationship.targetConceptId)?.add(relationship.sourceConceptId);
          }
          const visited = new Set<string>();
          const communities: string[][] = [];
          for (const concept of input.canonicalConcepts) {
            if (visited.has(concept.id)) continue;
            const queue = [concept.id];
            const community: string[] = [];
            visited.add(concept.id);
            while (queue.length) {
              const current = queue.shift()!;
              community.push(current);
              for (const neighbor of neighbors.get(current) || []) {
                if (!visited.has(neighbor)) {
                  visited.add(neighbor);
                  queue.push(neighbor);
                }
              }
            }
            communities.push(community.sort());
          }
          const analyzedCommunities = Array.isArray(input.graphAnalysis?.communities)
            ? input.graphAnalysis!.communities
            : [];
          if (analyzedCommunities.length || communities.length) {
            const rows = analyzedCommunities.length
              ? analyzedCommunities.map((community: any, index: number) => ({
                  id: randomUUID(),
                  snapshotId,
                  algorithm: String(input.graphAnalysis?.algorithm || 'networkx-louvain'),
                  algorithmVersion: String(input.graphAnalysis?.algorithmVersion || 'networkx/unknown'),
                  label: String(community.label || `Community ${index + 1}`),
                  conceptIds: community.conceptIds || [],
                  metadata: { size: Number(community.size || community.conceptIds?.length || 0) },
                }))
              : communities.map((conceptIds, index) => ({
              id: randomUUID(),
              snapshotId,
              algorithm: 'weakly_connected_components',
              algorithmVersion: 'helpudoc-graph/1',
              label: `Community ${index + 1}`,
              conceptIds,
              metadata: { size: conceptIds.length },
              }));
            await trx.batchInsert('knowledge_communities', rows, 250);
          }
        }
      }
      return snapshotId;
    });
  }

  private async persistConceptEmbeddings(input: {
    snapshotId: string;
    runId: string;
    workspaceId: string;
    concepts: CanonicalConcept[];
    agentAuthToken: string;
    sourceRelativePath: string;
    mediaPages: number[];
  }): Promise<void> {
    const dimensions = Number(process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS || 768);
    const startedAt = Date.now();
    const response = await embedKnowledgeInputs({
      workspaceId: input.workspaceId,
      dimensions,
      taskType: 'RETRIEVAL_DOCUMENT',
      inputs: input.concepts.map((concept) => ({
        id: concept.id,
        title: concept.name,
        text: [
          concept.name,
          ...concept.aliases,
          concept.description,
          ...concept.assertions.map((assertion) => assertion.text),
        ].filter(Boolean).join('\n'),
      })),
    }, { authToken: input.agentAuthToken });
    const column = await this.db('knowledge_embeddings').columnInfo('embedding') as any;
    const usesPgvector = String(column?.type || '').toLowerCase().includes('vector')
      || String(column?.type || '').toLowerCase() === 'user-defined';
    await this.db.transaction(async (trx) => {
      await trx('knowledge_embeddings').where({
        snapshotId: input.snapshotId,
        ownerType: 'concept',
        model: response.model,
      }).del();
      for (const embedding of response.embeddings) {
        const vectorValue = `[${embedding.values.join(',')}]`;
        await trx('knowledge_embeddings').insert({
          id: randomUUID(),
          snapshotId: input.snapshotId,
          ownerType: 'concept',
          ownerId: embedding.id,
          model: response.model,
          dimensions: response.dimensions,
          modality: 'text',
          indexVersion: 'knowledge-vector/1',
          contentHash: `sha256:${sha256(stableJson(embedding.values))}`,
          embedding: usesPgvector ? trx.raw('?::vector', [vectorValue]) : embedding.values,
        });
      }
      const totalTokens = response.embeddings.reduce((sum, embedding) => sum + Number(embedding.tokenCount || 0), 0);
      const price = Number(process.env.KNOWLEDGE_EMBEDDING_USD_PER_MILLION_TOKENS || 0);
      await trx('knowledge_usage_events').insert({
        id: randomUUID(),
        runId: input.runId,
        stage: 'embedding',
        provider: response.provider,
        model: response.model,
        schemaVersion: `gemini-embedding/${dimensions}`,
        inputTokens: totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        retries: 0,
        latencyMs: Date.now() - startedAt,
        rateCardVersion: knowledgeRateCard().version,
        estimatedCost: totalTokens * price / 1_000_000,
      });
    });
    if (
      process.env.KNOWLEDGE_MULTIMODAL_EMBEDDINGS === 'true'
      && input.sourceRelativePath.toLowerCase().endsWith('.pdf')
      && input.mediaPages.length
    ) {
      const mediaStartedAt = Date.now();
      const mediaResponse = await embedKnowledgeMedia({
        workspaceId: input.workspaceId,
        relativePath: input.sourceRelativePath,
        pages: Array.from(new Set(input.mediaPages)).sort((left, right) => left - right),
        dimensions,
      }, { authToken: input.agentAuthToken });
      const column = await this.db('knowledge_embeddings').columnInfo('embedding') as any;
      const usesPgvector = String(column?.type || '').toLowerCase().includes('vector')
        || String(column?.type || '').toLowerCase() === 'user-defined';
      await this.db.transaction(async (trx) => {
        await trx('knowledge_embeddings').where({
          snapshotId: input.snapshotId,
          ownerType: 'page',
          model: mediaResponse.model,
        }).del();
        for (const embedding of mediaResponse.embeddings) {
          await trx('knowledge_embeddings').insert({
            id: randomUUID(),
            snapshotId: input.snapshotId,
            ownerType: 'page',
            ownerId: embedding.id,
            model: mediaResponse.model,
            dimensions: mediaResponse.dimensions,
            modality: 'pdf_page',
            indexVersion: 'knowledge-vector/1',
            contentHash: embedding.contentHash || `sha256:${sha256(stableJson(embedding.values))}`,
            embedding: usesPgvector
              ? trx.raw('?::vector', [`[${embedding.values.join(',')}]`])
              : embedding.values,
          });
        }
        const totalTokens = mediaResponse.embeddings.reduce((sum, embedding) => sum + Number(embedding.tokenCount || 0), 0);
        const price = Number(process.env.KNOWLEDGE_EMBEDDING_USD_PER_MILLION_TOKENS || 0);
        await trx('knowledge_usage_events').insert({
          id: randomUUID(),
          runId: input.runId,
          stage: 'embedding-media',
          provider: mediaResponse.provider,
          model: mediaResponse.model,
          schemaVersion: `gemini-embedding/${dimensions}`,
          inputTokens: totalTokens,
          cachedInputTokens: 0,
          outputTokens: 0,
          retries: 0,
          latencyMs: Date.now() - mediaStartedAt,
          rateCardVersion: knowledgeRateCard().version,
          estimatedCost: totalTokens * price / 1_000_000,
        });
      });
    }
  }

  private async isRunCancelled(runId: string): Promise<boolean> {
    const job = await this.db('knowledge_ingestion_jobs').select('status').where({ id: runId }).first();
    return job?.status === 'cancelled' || job?.status === 'superseded';
  }

  private assertType(type: KnowledgeType) {
    if (!SUPPORTED_TYPES.includes(type)) {
      throw new ConflictError(`Unsupported knowledge type: ${type}`);
    }
  }

  private assertMinimalFields(type: KnowledgeType, payload: Partial<KnowledgeInput>, existing?: any) {
    const content = payload.content !== undefined ? payload.content : existing?.content;
    const fileId = payload.fileId !== undefined ? payload.fileId : existing?.fileId;
    const sourceUrl = payload.sourceUrl !== undefined ? payload.sourceUrl : existing?.sourceUrl;

    const hasTextContent = typeof content === 'string' && content.trim().length > 0;
    const hasBinaryRef = typeof fileId === 'number' || (typeof sourceUrl === 'string' && sourceUrl.trim().length > 0);

    if ((type === 'text' || type === 'table') && !hasTextContent && !hasBinaryRef) {
      throw new ConflictError('Text and table knowledge entries require text content or a referenced file/source URL');
    }

    if ((type === 'image' || type === 'presentation' || type === 'infographic') && !hasBinaryRef) {
      throw new ConflictError('Visual knowledge entries require a fileId or sourceUrl');
    }
  }

  private baseQuery() {
    return this.db('knowledge_sources')
      .leftJoin('files', 'knowledge_sources.fileId', 'files.id')
      .select(
        'knowledge_sources.*',
        'files.name as fileName',
        'files.mimeType as fileMimeType',
        'files.publicUrl as filePublicUrl',
        'files.storageType as fileStorageType',
        'files.path as filePath',
        'files.id as filePrimaryId',
      );
  }

  private mapRow(row: any) {
    const file = row.filePrimaryId
      ? {
          id: row.filePrimaryId as number,
          name: row.fileName as string,
          mimeType: row.fileMimeType as string | null,
          // Workspace objects are private and are never exposed as direct URLs.
          publicUrl: null,
          storageType: row.fileStorageType as string | null,
          path: row.filePath as string | null,
        }
      : null;

    return {
      id: row.id as number,
      workspaceId: row.workspaceId as string,
      isGlobal: Boolean(row.isGlobal),
      title: row.title as string,
      type: row.type as KnowledgeType,
      description: row.description ?? null,
      content: row.content ?? null,
      fileId: row.fileId ?? null,
      sourceUrl: row.sourceUrl ?? null,
      tags: row.tags ?? null,
      metadata: row.metadata ?? null,
      createdBy: row.createdBy ?? null,
      updatedBy: row.updatedBy ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      file,
    };
  }

  private async assertFileInWorkspace(fileId: number, workspaceId: string) {
    const file = await this.db('files').where({ id: fileId, workspaceId }).first();
    if (!file) {
      throw new ConflictError('File does not belong to this workspace');
    }
  }

  private async getKnowledgeRow(id: number) {
    const row = await this.db('knowledge_sources').where({ id }).first();
    if (!row) {
      throw new NotFoundError('Knowledge source not found');
    }
    return row;
  }

  private async getGraphSummary(knowledgeId: number) {
    const snapshot = await this.db('knowledge_snapshots')
      .where({ knowledgeId, isPublished: true })
      .orderBy('publishedAt', 'desc')
      .first();
    if (!snapshot) {
      return { snapshotId: null, conceptCount: 0, relationshipCount: 0, communityCount: 0, orphanCount: 0, communities: [] };
    }
    const [conceptCountRow, relationshipCountRow, communities, connectedRows] = await Promise.all([
      this.db('knowledge_concepts').where({ snapshotId: snapshot.id }).count<{ count: string }[]>('* as count').first(),
      this.db('knowledge_relationships').where({ snapshotId: snapshot.id }).count<{ count: string }[]>('* as count').first(),
      this.db('knowledge_communities').where({ snapshotId: snapshot.id }).orderBy('label', 'asc'),
      this.db('knowledge_relationships')
        .where({ snapshotId: snapshot.id })
        .select('sourceConceptId', 'targetConceptId'),
    ]);
    const connected = new Set<string>();
    for (const row of connectedRows) {
      connected.add(String(row.sourceConceptId));
      connected.add(String(row.targetConceptId));
    }
    const conceptIds = await this.db('knowledge_concepts').where({ snapshotId: snapshot.id }).select('id');
    return {
      snapshotId: snapshot.id,
      snapshotHash: snapshot.contentHash,
      conceptCount: Number((conceptCountRow as any)?.count || 0),
      relationshipCount: Number((relationshipCountRow as any)?.count || 0),
      communityCount: communities.length,
      orphanCount: conceptIds.filter((row: any) => !connected.has(String(row.id))).length,
      communities,
    };
  }

  private async resolveStorageWorkspace(userId: string): Promise<string> {
    const workspaces = await this.workspaceService.listWorkspacesForUser(userId);
    const writable = workspaces.find((workspace) => workspace.canEdit);
    if (!writable) {
      throw new ConflictError('Create a writable workspace before adding knowledge');
    }
    return writable.id;
  }

  private async resolveGlobalKnowledgeAccess(userId: string): Promise<number[] | null> {
    const user = await this.db('users').select('isAdmin').where({ id: userId }).first();
    if (user?.isAdmin) {
      return null;
    }
    const rows = await this.db('knowledge_source_group_grants as kg')
      .join('group_members as gm', 'kg.groupId', 'gm.groupId')
      .where('gm.userId', userId)
      .distinct('kg.knowledgeSourceId');
    return Array.from(new Set(
      rows
        .map((row: { knowledgeSourceId?: number }) => Number(row.knowledgeSourceId))
        .filter((id: number) => Number.isInteger(id) && id > 0),
    ));
  }

  private applyKnowledgeAccess<T extends Knex.QueryBuilder>(
    query: T,
    workspaceId: string,
    globalKnowledgeIds: number[] | null,
  ): T {
    return query.where((builder) => {
      builder.where((workspaceQuery) => {
        workspaceQuery
          .where('knowledge_sources.workspaceId', workspaceId)
          .andWhere('knowledge_sources.isGlobal', false);
      });
      if (globalKnowledgeIds === null) {
        builder.orWhere('knowledge_sources.isGlobal', true);
      } else if (globalKnowledgeIds.length) {
        builder.orWhere((globalQuery) => {
          globalQuery
            .where('knowledge_sources.isGlobal', true)
            .whereIn('knowledge_sources.id', globalKnowledgeIds);
        });
      }
    }) as T;
  }
}

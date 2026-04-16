import { createHash, randomUUID } from 'crypto';
import * as path from 'path';
import type { Knex } from 'knex';
import type { DerivedArtifactMode, DerivedArtifactStatus, FileContextRef } from '../../../packages/shared/src/types';
import { DatabaseService } from './databaseService';
import { FileService } from './fileService';
import { WorkspaceService } from './workspaceService';
import { understandAttachment } from './agentService';

type PipelineStage = 'part-base' | 'parser-enrichment';

type DerivedArtifactRecord = {
  id: string;
  workspaceId: string;
  sourceFileId: number;
  sourceVersionFingerprint: string;
  pipelineStage: PipelineStage;
  artifactVersion: number;
  understandingMode: DerivedArtifactMode;
  status: DerivedArtifactStatus;
  derivedArtifactFileId?: number | null;
  summaryMetadataJson?: {
    summary?: string | null;
    outline?: string[] | null;
    sections?: Array<{ heading: string; body: string }> | null;
    title?: string | null;
    extractedAssets?: Array<{
      path: string;
      name: string;
      mimeType: string;
      caption?: string | null;
      footnote?: string | null;
    }> | null;
  } | null;
  lastError?: string | null;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type SourceFileRecord = {
  id: number;
  name: string;
  workspaceId: string;
  mimeType?: string | null;
  storageType: 'local' | 's3';
  path: string;
  publicUrl?: string | null;
};

type ArtifactBuildResult = {
  markdown: string;
  summary?: string | null;
  outline?: string[] | null;
  sections?: Array<{ heading: string; body: string }> | null;
  title?: string | null;
  extractedAssets?: Array<{
    name: string;
    mimeType: string;
    contentB64: string;
    sourcePath?: string | null;
    caption?: string | null;
    footnote?: string | null;
  }>;
  effectiveMode: DerivedArtifactMode;
  status: Extract<DerivedArtifactStatus, 'ready' | 'partial'>;
};

const PART_BASE_STAGE: PipelineStage = 'part-base';
const SYSTEM_ARTIFACT_ROOT = '.system/derived-artifacts';
const SYSTEM_EXTRACTED_ASSET_ROOT = '.system/extracted-assets';
const DEFAULT_SYNC_MAX_BYTES = 10 * 1024 * 1024;

const normalizeStatus = (value: string): DerivedArtifactStatus =>
  value === 'pending' || value === 'partial' || value === 'ready' || value === 'failed' || value === 'superseded'
    ? value
    : 'failed';

const normalizeMode = (value: string): DerivedArtifactMode =>
  value === 'parser' || value === 'hybrid' ? value : 'part';

const resolveSyncMaxBytes = (): number => {
  const raw = Number(process.env.FILE_UNDERSTANDING_SYNC_MAX_BYTES || DEFAULT_SYNC_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SYNC_MAX_BYTES;
};

const isMarkdownLike = (fileName: string, mimeType?: string | null): boolean => {
  const ext = path.extname(fileName).toLowerCase();
  if (['.md', '.txt', '.csv', '.json', '.html', '.htm'].includes(ext)) {
    return true;
  }
  return typeof mimeType === 'string' && mimeType.startsWith('text/');
};

const buildHiddenArtifactPath = (artifactId: string, version: number): string =>
  path.posix.join(SYSTEM_ARTIFACT_ROOT, artifactId, `v${version}.md`);

const buildHiddenExtractedAssetPath = (artifactId: string, fileName: string): string =>
  path.posix.join(SYSTEM_EXTRACTED_ASSET_ROOT, artifactId, fileName);

const buildFingerprint = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

const slugifyFileStem = (value: string): string => {
  const stem = path.parse(value).name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stem || 'asset';
};

const sanitizeAssetFileName = (index: number, requestedName: string, mimeType: string): string => {
  const extFromName = path.extname(requestedName).toLowerCase();
  const extFromMime = mimeType.toLowerCase() === 'image/jpeg'
    ? '.jpg'
    : mimeType.toLowerCase() === 'image/png'
      ? '.png'
      : mimeType.toLowerCase() === 'image/webp'
        ? '.webp'
        : mimeType.toLowerCase() === 'image/gif'
          ? '.gif'
          : '';
  const ext = extFromName || extFromMime || '.png';
  return `${String(index + 1).padStart(2, '0')}-${slugifyFileStem(requestedName)}${ext}`;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const AUTO_PROCESS_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx']);

const splitMarkdownSections = (markdown: string): Array<{ heading: string; body: string }> => {
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading = 'Overview';
  let currentBody: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (headingMatch) {
      if (currentBody.length) {
        sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
      }
      currentHeading = headingMatch[2].trim() || 'Section';
      currentBody = [];
      continue;
    }
    currentBody.push(line);
  }
  if (currentBody.length) {
    sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
  }
  return sections.filter((section) => section.body);
};

const rewriteMarkdownAssetLinks = (
  markdown: string,
  assets: Array<{
    sourcePath?: string | null;
    workspacePath: string;
    caption?: string | null;
  }>,
): string => {
  let rewritten = markdown;
  for (const asset of assets) {
    const sourcePath = String(asset.sourcePath || '').trim().replace(/\\/g, '/');
    if (!sourcePath) {
      continue;
    }
    rewritten = rewritten.replace(new RegExp(escapeRegExp(sourcePath), 'g'), asset.workspacePath);
  }
  if (!assets.length) {
    return rewritten;
  }
  const appendixLines = ['## Extracted Figures', ''];
  for (const asset of assets) {
    appendixLines.push(`### ${String(asset.caption || '').trim() || path.basename(asset.workspacePath)}`);
    appendixLines.push('');
    appendixLines.push(`![](${asset.workspacePath})`);
    appendixLines.push('');
  }
  return `${rewritten.trim()}\n\n${appendixLines.join('\n').trim()}\n`;
};

export class DerivedArtifactService {
  private db: Knex;
  private fileService: FileService;
  private workspaceService: WorkspaceService;
  private inFlightJobs = new Map<string, Promise<void>>();
  private readonly syncMaxBytes = resolveSyncMaxBytes();

  constructor(databaseService: DatabaseService, fileService: FileService, workspaceService: WorkspaceService) {
    this.db = databaseService.getDb();
    this.fileService = fileService;
    this.workspaceService = workspaceService;
  }

  logDiagnostics() {
    const understandingMode = (process.env.FILE_UNDERSTANDING_MODE || 'part-first').trim() || 'part-first';
    const parserPipeline = (process.env.RAG_PARSER_PIPELINE || 'raganything').trim() || 'raganything';
    const parserMode = (
      process.env.PARSER_ENRICHMENT_MODE
      || process.env.RAGANYTHING_PARSER
      || process.env.PARSER
      || 'docling'
    ).trim() || 'docling';
    console.log(
      `[backend] File understanding: mode=${understandingMode} parserPipeline=${parserPipeline} parserEnrichment=${parserMode} syncMaxBytes=${this.syncMaxBytes}`,
    );
  }

  async ensureFileContextRefs(
    workspaceId: string,
    userId: string,
    sourceFileIds: number[],
    options?: { waitForReady?: boolean; timeoutMs?: number },
  ): Promise<FileContextRef[]> {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const refs: FileContextRef[] = [];
    for (const sourceFileId of sourceFileIds) {
      let ref = await this.ensureFileContextRef(workspaceId, userId, sourceFileId);
      if (options?.waitForReady && ref.status === 'pending') {
        ref = await this.waitForFileContextRef(workspaceId, userId, sourceFileId, ref.artifactId, options.timeoutMs);
      }
      refs.push(ref);
    }
    return refs;
  }

  isAutoProcessEligibleFile(fileName: string, mimeType?: string | null): boolean {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    if (AUTO_PROCESS_EXTENSIONS.has(ext)) {
      return true;
    }
    const normalizedMime = String(mimeType || '').toLowerCase();
    return normalizedMime === 'application/pdf'
      || normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || normalizedMime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }

  async enqueueFileUnderstanding(
    workspaceId: string,
    userId: string,
    sourceFileIds: number[],
  ): Promise<FileContextRef[]> {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const refs: FileContextRef[] = [];
    for (const sourceFileId of sourceFileIds) {
      const sourceFile = await this.fileService.getFileRecord(sourceFileId, userId) as SourceFileRecord;
      if (!this.isAutoProcessEligibleFile(sourceFile.name, sourceFile.mimeType)) {
        continue;
      }
      refs.push(await this.ensureFileContextRef(workspaceId, userId, sourceFileId, { forceAsync: true }));
    }
    return refs;
  }

  async listFileUnderstandingStates(
    workspaceId: string,
    userId: string,
    sourceFileIds: number[],
  ): Promise<Map<number, {
    status: DerivedArtifactStatus;
    mode: DerivedArtifactMode;
    error: string | null;
    derivedArtifactFileId: number | null;
  }>> {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    if (!sourceFileIds.length) {
      return new Map();
    }
    const rows = await this.db<DerivedArtifactRecord>('derived_artifacts')
      .where({ workspaceId, pipelineStage: PART_BASE_STAGE })
      .whereIn('sourceFileId', sourceFileIds)
      .whereNot({ status: 'superseded' })
      .orderBy([{ column: 'updatedAt', order: 'desc' }, { column: 'createdAt', order: 'desc' }]);
    const states = new Map<number, {
      status: DerivedArtifactStatus;
      mode: DerivedArtifactMode;
      error: string | null;
      derivedArtifactFileId: number | null;
    }>();
    for (const row of rows) {
      const sourceFileId = Number(row.sourceFileId);
      if (!Number.isFinite(sourceFileId) || states.has(sourceFileId)) {
        continue;
      }
      states.set(sourceFileId, {
        status: normalizeStatus(row.status),
        mode: normalizeMode(row.understandingMode),
        error: row.lastError ?? null,
        derivedArtifactFileId: row.derivedArtifactFileId ? Number(row.derivedArtifactFileId) : null,
      });
    }
    return states;
  }

  async purgeSourceArtifacts(workspaceId: string, sourceFileId: number, userId: string): Promise<void> {
    const rows = await this.db<DerivedArtifactRecord>('derived_artifacts')
      .where({ workspaceId, sourceFileId });
    const siblingRows = await this.db<DerivedArtifactRecord>('derived_artifacts')
      .where({ workspaceId })
      .whereNot({ sourceFileId });
    const siblingAssetPaths = new Set(
      siblingRows.flatMap((row) =>
        (row.summaryMetadataJson?.extractedAssets || [])
          .map((asset) => String(asset?.path || '').trim())
          .filter(Boolean),
      ),
    );
    for (const row of rows) {
      if (row.derivedArtifactFileId) {
        const sharedArtifactRef = await this.db<DerivedArtifactRecord>('derived_artifacts')
          .where({ workspaceId, derivedArtifactFileId: row.derivedArtifactFileId })
          .whereNot({ id: row.id })
          .first();
        if (!sharedArtifactRef) {
          try {
            await this.fileService.deleteFile(Number(row.derivedArtifactFileId), userId);
          } catch (error) {
            console.error('Failed to delete hidden derived artifact file', { workspaceId, sourceFileId, rowId: row.id, error });
          }
        }
      }
      const assetPaths = (row.summaryMetadataJson?.extractedAssets || [])
        .map((asset) => String(asset?.path || '').trim())
        .filter(Boolean);
      for (const assetPath of assetPaths) {
        if (siblingAssetPaths.has(assetPath)) {
          continue;
        }
        const assetFileId = await this.lookupFileIdByName(workspaceId, assetPath);
        if (!assetFileId) {
          continue;
        }
        try {
          await this.fileService.deleteFile(Number(assetFileId), userId);
        } catch (error) {
          console.error('Failed to delete hidden extracted asset file', {
            workspaceId,
            sourceFileId,
            rowId: row.id,
            fileId: assetFileId,
            error,
          });
        }
      }
    }
    await this.db('derived_artifacts').where({ workspaceId, sourceFileId }).del();
  }

  private async ensureFileContextRef(
    workspaceId: string,
    userId: string,
    sourceFileId: number,
    options?: { forceAsync?: boolean },
  ): Promise<FileContextRef> {
    const sourceFile = await this.fileService.getFileRecord(sourceFileId, userId) as SourceFileRecord;
    const buffer = await this.fileService.readFileBuffer(sourceFile);
    const fingerprint = buildFingerprint(buffer);
    const existing = await this.db<DerivedArtifactRecord>('derived_artifacts')
      .where({
        workspaceId,
        sourceFileId,
        sourceVersionFingerprint: fingerprint,
        pipelineStage: PART_BASE_STAGE,
      })
      .first();

    if (existing) {
      if (existing.status === 'pending') {
        this.scheduleArtifactBuild(existing.id, workspaceId, userId, sourceFile, buffer);
      }
      return this.toFileContextRef(existing, sourceFile);
    }

    const reusable = await this.findReusableArtifact(workspaceId, sourceFileId, fingerprint);
    if (reusable) {
      const cloned = await this.cloneArtifactForSource(workspaceId, userId, sourceFile, reusable);
      return this.toFileContextRef(cloned, sourceFile);
    }

    const artifactId = randomUUID();
    const shouldProcessSync = !options?.forceAsync && buffer.byteLength <= this.syncMaxBytes;
    const initialStatus: DerivedArtifactStatus = 'pending';
    const initialRecord: DerivedArtifactRecord = {
      id: artifactId,
      workspaceId,
      sourceFileId,
      sourceVersionFingerprint: fingerprint,
      pipelineStage: PART_BASE_STAGE,
      artifactVersion: 1,
      understandingMode: 'part',
      status: initialStatus,
      summaryMetadataJson: null,
      lastError: null,
      createdBy: userId,
      updatedBy: userId,
    };

    await this.db('derived_artifacts').insert({
      ...initialRecord,
      createdAt: this.db.fn.now(),
      updatedAt: this.db.fn.now(),
    });
    await this.db('derived_artifacts')
      .where({ workspaceId, sourceFileId, pipelineStage: PART_BASE_STAGE })
      .whereNot({ id: artifactId })
      .whereNot({ status: 'superseded' })
      .update({ status: 'superseded', updatedBy: userId, updatedAt: this.db.fn.now() });

    if (!shouldProcessSync) {
      this.scheduleArtifactBuild(artifactId, workspaceId, userId, sourceFile, buffer);
      return this.toFileContextRef(initialRecord, sourceFile);
    }

    try {
      const built = await this.buildAndPersistArtifact(initialRecord, userId, sourceFile, buffer);
      return this.toFileContextRef(built, sourceFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build derived artifact';
      await this.db('derived_artifacts')
        .where({ id: artifactId })
        .update({
          status: 'failed',
          lastError: message,
          updatedBy: userId,
          updatedAt: this.db.fn.now(),
        });
      const failed = await this.db<DerivedArtifactRecord>('derived_artifacts').where({ id: artifactId }).first();
      return this.toFileContextRef(
        failed || { ...initialRecord, status: 'failed', lastError: message },
        sourceFile,
      );
    }
  }

  private async findReusableArtifact(
    workspaceId: string,
    sourceFileId: number,
    fingerprint: string,
  ): Promise<DerivedArtifactRecord | null> {
    const row = await this.db<DerivedArtifactRecord>('derived_artifacts')
      .where({
        workspaceId,
        sourceVersionFingerprint: fingerprint,
        pipelineStage: PART_BASE_STAGE,
      })
      .whereNotNull('derivedArtifactFileId')
      .whereIn('status', ['ready', 'partial'])
      .whereNot({ sourceFileId })
      .orderBy([{ column: 'updatedAt', order: 'desc' }, { column: 'createdAt', order: 'desc' }])
      .first();
    return row || null;
  }

  private async cloneArtifactForSource(
    workspaceId: string,
    userId: string,
    sourceFile: SourceFileRecord,
    reusable: DerivedArtifactRecord,
  ): Promise<DerivedArtifactRecord> {
    const artifactId = randomUUID();
    const summaryMetadata = reusable.summaryMetadataJson || {};
    const clonedRecord: DerivedArtifactRecord = {
      id: artifactId,
      workspaceId,
      sourceFileId: Number(sourceFile.id),
      sourceVersionFingerprint: reusable.sourceVersionFingerprint,
      pipelineStage: PART_BASE_STAGE,
      artifactVersion: 1,
      understandingMode: normalizeMode(reusable.understandingMode),
      status: normalizeStatus(reusable.status),
      derivedArtifactFileId: reusable.derivedArtifactFileId ? Number(reusable.derivedArtifactFileId) : null,
      summaryMetadataJson: {
        ...summaryMetadata,
        title: summaryMetadata.title ?? path.basename(sourceFile.name),
      },
      lastError: reusable.lastError ?? null,
      createdBy: userId,
      updatedBy: userId,
    };

    await this.db('derived_artifacts').insert({
      ...clonedRecord,
      createdAt: this.db.fn.now(),
      updatedAt: this.db.fn.now(),
    });
    return (await this.db<DerivedArtifactRecord>('derived_artifacts').where({ id: artifactId }).first()) || clonedRecord;
  }

  private async lookupFileIdByName(workspaceId: string, name: string): Promise<number | null> {
    const row = await this.db('files').where({ workspaceId, name }).first();
    return row?.id ? Number(row.id) : null;
  }

  private scheduleArtifactBuild(
    artifactId: string,
    workspaceId: string,
    userId: string,
    sourceFile: SourceFileRecord,
    buffer: Buffer,
  ) {
    if (this.inFlightJobs.has(artifactId)) {
      return;
    }
    const promise = this.buildArtifactInBackground(artifactId, workspaceId, userId, sourceFile, buffer)
      .finally(() => {
        this.inFlightJobs.delete(artifactId);
      });
    this.inFlightJobs.set(artifactId, promise);
  }

  private async waitForFileContextRef(
    workspaceId: string,
    userId: string,
    sourceFileId: number,
    artifactId: string,
    timeoutMs = 120000,
  ): Promise<FileContextRef> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const row = await this.db<DerivedArtifactRecord>('derived_artifacts').where({ id: artifactId, workspaceId }).first();
      if (!row) {
        throw new Error(`Derived artifact ${artifactId} not found`);
      }
      if (row.status !== 'pending') {
        const sourceFile = await this.fileService.getFileRecord(sourceFileId, userId);
        return this.toFileContextRef(row, sourceFile as SourceFileRecord);
      }
      const inFlight = this.inFlightJobs.get(artifactId);
      if (inFlight) {
        try {
          await Promise.race([
            inFlight,
            new Promise((resolve) => setTimeout(resolve, 1000)),
          ]);
        } catch {
          // Ignore here and let the DB row state determine the final result.
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const sourceFile = await this.fileService.getFileRecord(sourceFileId, userId);
    const fallback = await this.db<DerivedArtifactRecord>('derived_artifacts').where({ id: artifactId, workspaceId }).first();
    if (!fallback) {
      throw new Error(`Derived artifact ${artifactId} not found`);
    }
    return this.toFileContextRef(fallback, sourceFile as SourceFileRecord);
  }

  private async buildArtifactInBackground(
    artifactId: string,
    workspaceId: string,
    userId: string,
    sourceFile: SourceFileRecord,
    buffer: Buffer,
  ) {
    try {
      const row = await this.db<DerivedArtifactRecord>('derived_artifacts').where({ id: artifactId, workspaceId }).first();
      if (!row || row.status !== 'pending') {
        return;
      }
      await this.buildAndPersistArtifact(row, userId, sourceFile, buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build derived artifact';
      console.error('Derived artifact build failed', { artifactId, workspaceId, sourceFileId: sourceFile.id, error });
      await this.db('derived_artifacts')
        .where({ id: artifactId })
        .update({
          status: 'failed',
          lastError: message,
          updatedBy: userId,
          updatedAt: this.db.fn.now(),
        });
    }
  }

  private async buildAndPersistArtifact(
    row: DerivedArtifactRecord,
    userId: string,
    sourceFile: SourceFileRecord,
    buffer: Buffer,
  ): Promise<DerivedArtifactRecord> {
    const built = await this.buildArtifactContent(sourceFile, buffer);
    const existingAssetFiles = await this.db('files')
      .where({ workspaceId: row.workspaceId })
      .whereLike('name', `${buildHiddenExtractedAssetPath(row.id, '')}%`);
    for (const assetFile of existingAssetFiles) {
      await this.fileService.deleteFile(Number(assetFile.id), userId);
    }
    const persistedAssets: Array<{
      path: string;
      name: string;
      mimeType: string;
      caption?: string | null;
      footnote?: string | null;
    }> = [];
    for (const [index, asset] of (built.extractedAssets || []).entries()) {
      const fileName = sanitizeAssetFileName(index, asset.name, asset.mimeType);
      const assetPath = buildHiddenExtractedAssetPath(row.id, fileName);
      const created = await this.fileService.createFile(
        row.workspaceId,
        assetPath,
        Buffer.from(asset.contentB64, 'base64'),
        asset.mimeType,
        userId,
        { forceLocal: true },
      );
      persistedAssets.push({
        path: String(created.name || assetPath).replace(/\\/g, '/'),
        name: fileName,
        mimeType: asset.mimeType,
        caption: asset.caption || null,
        footnote: asset.footnote || null,
      });
    }
    const markdownWithExtractedAssets = rewriteMarkdownAssetLinks(
      built.markdown,
      persistedAssets.map((asset, index) => ({
        sourcePath: (built.extractedAssets || [])[index]?.sourcePath || null,
        workspacePath: asset.path,
        caption: asset.caption || null,
      })),
    );
    const artifactPath = buildHiddenArtifactPath(row.id, row.artifactVersion);
    let derivedFileId = row.derivedArtifactFileId ?? null;

    if (derivedFileId) {
      await this.fileService.updateFile(derivedFileId, markdownWithExtractedAssets, userId);
    } else {
      const hiddenFile = await this.fileService.createTextFile(
        row.workspaceId,
        artifactPath,
        markdownWithExtractedAssets,
        userId,
        'text/markdown',
      );
      derivedFileId = Number(hiddenFile.id);
    }

    await this.db('derived_artifacts')
      .where({ id: row.id })
      .update({
        status: built.status,
        understandingMode: built.effectiveMode,
        derivedArtifactFileId: derivedFileId,
        summaryMetadataJson: {
          summary: built.summary ?? null,
          outline: built.outline ?? null,
          sections: built.sections ?? null,
          title: built.title ?? path.basename(sourceFile.name),
          extractedAssets: persistedAssets,
        },
        lastError: null,
        updatedBy: userId,
        updatedAt: this.db.fn.now(),
      });

    const updated = await this.db<DerivedArtifactRecord>('derived_artifacts').where({ id: row.id }).first();
    if (!updated) {
      throw new Error('Derived artifact disappeared after update');
    }
    return updated;
  }

  private async buildArtifactContent(sourceFile: SourceFileRecord, buffer: Buffer): Promise<ArtifactBuildResult> {
    if (isMarkdownLike(sourceFile.name, sourceFile.mimeType)) {
      const rawText = buffer.toString('utf-8');
      const title = path.basename(sourceFile.name);
      const summary = rawText.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || title;
      const markdown = `# ${title}\n\n## Summary\n\n${summary}\n\n## Source Content\n\n${rawText}`;
      return {
        markdown,
        summary,
        outline: splitMarkdownSections(markdown).map((section) => section.heading),
        sections: splitMarkdownSections(markdown),
        title,
        effectiveMode: 'part',
        status: 'ready',
      };
    }

    const response = await understandAttachment({
      fileName: sourceFile.name,
      mimeType: sourceFile.mimeType || 'application/octet-stream',
      contentB64: buffer.toString('base64'),
    });
    const title = response.title || path.basename(sourceFile.name);
    const sections = Array.isArray(response.sections) && response.sections.length
      ? response.sections
      : splitMarkdownSections(response.markdown || '');
    return {
      markdown: response.markdown,
      summary: response.summary || null,
      outline: Array.isArray(response.outline) ? response.outline : sections.map((section) => section.heading),
      sections,
      title,
      extractedAssets: Array.isArray(response.extractedAssets)
        ? response.extractedAssets
            .filter((asset) =>
              Boolean(
                asset
                && typeof asset === 'object'
                && typeof asset.contentB64 === 'string'
                && asset.contentB64.trim(),
              ),
            )
            .map((asset) => ({
              name: String(asset.name || 'image.png'),
              mimeType: String(asset.mimeType || 'image/png'),
              contentB64: String(asset.contentB64 || ''),
              sourcePath: typeof asset.sourcePath === 'string' ? asset.sourcePath : null,
              caption: typeof asset.caption === 'string' ? asset.caption : null,
              footnote: typeof asset.footnote === 'string' ? asset.footnote : null,
            }))
        : [],
      effectiveMode: normalizeMode(response.effectiveMode || 'part'),
      status: response.status === 'partial' ? 'partial' : 'ready',
    };
  }

  private toFileContextRef(row: DerivedArtifactRecord, sourceFile: SourceFileRecord): FileContextRef {
    const summaryMetadata = row.summaryMetadataJson || {};
    return {
      sourceFileId: Number(row.sourceFileId),
      sourceName: sourceFile.name,
      sourceMimeType: sourceFile.mimeType ?? null,
      sourceVersionFingerprint: row.sourceVersionFingerprint,
      artifactId: row.id,
      artifactVersion: Number(row.artifactVersion || 1),
      derivedArtifactFileId: row.derivedArtifactFileId ? Number(row.derivedArtifactFileId) : null,
      derivedArtifactPath: row.derivedArtifactFileId ? buildHiddenArtifactPath(row.id, Number(row.artifactVersion || 1)) : null,
      effectiveMode: normalizeMode(row.understandingMode),
      status: normalizeStatus(row.status),
      summary: typeof summaryMetadata.summary === 'string' ? summaryMetadata.summary : null,
      lastError: row.lastError ?? null,
    };
  }
}

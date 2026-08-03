import { createHash } from 'crypto';
import path from 'path';
import { Knex } from 'knex';
import { DatabaseService } from './databaseService';
import { WorkspaceService } from './workspaceService';
import { FileService } from './fileService';
import { ConflictError, NotFoundError } from '../errors';
import { KnowledgeType } from '../types/knowledge';
import { extractWorkspaceDocument } from './agentService';
import { workbookBufferToMarkdown } from '../utils/spreadsheetMarkdown';

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
const OKF_GENERATOR = 'helpudoc-okf/1';
const OKF_SYSTEM_ROOT = '.system/knowledge';

type KnowledgeIngestionStatus = 'queued' | 'processing' | 'published' | 'failed';

type KnowledgeIngestionMetadata = {
  status: KnowledgeIngestionStatus;
  queuedAt?: string;
  startedAt?: string;
  publishedAt?: string;
  failedAt?: string;
  error?: string | null;
  sourceFingerprint?: string | null;
  bundlePath?: string | null;
  conceptCount?: number;
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

const splitMarkdownSections = (markdown: string): Array<{ title: string; body: string }> => {
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
  return sections.slice(0, 50);
};

export class KnowledgeService {
  private db: Knex;
  private workspaceService: WorkspaceService;
  private fileService?: FileService;
  private inFlightIngestions = new Map<number, Promise<void>>();

  constructor(
    databaseService: DatabaseService,
    workspaceService: WorkspaceService,
    fileService?: FileService,
  ) {
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
    this.fileService = fileService;
  }

  async listGlobal() {
    const rows = await this.baseQuery()
      .where('knowledge_sources.isGlobal', true)
      .orderBy('knowledge_sources.updatedAt', 'desc');
    return rows.map((row) => this.mapRow(row));
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
        if (!status || status === 'queued' || status === 'processing') {
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
      this.scheduleIngestion(workspaceId, Number(record.id), userId, options.allowSystemAdmin);
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
      await this.updateIngestionMetadata(workspaceId, id, {
        status: 'queued',
        queuedAt: new Date().toISOString(),
        error: null,
        okfVersion: OKF_VERSION,
      });
      this.scheduleIngestion(workspaceId, id, userId, options.allowSystemAdmin);
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
    await this.updateIngestionMetadata(workspaceId, id, {
      status: 'queued',
      queuedAt: new Date().toISOString(),
      error: null,
      okfVersion: OKF_VERSION,
    });
    this.scheduleIngestion(workspaceId, id, userId, options.allowSystemAdmin);
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
    const deleted = await this.db('knowledge_sources').where({ id, workspaceId }).del();
    if (!deleted) {
      throw new NotFoundError('Knowledge source not found');
    }
    if (this.fileService) {
      const bundlePath = this.getIngestionMetadata(existing.metadata)?.bundlePath
        || path.posix.join(OKF_SYSTEM_ROOT, String(id));
      await this.removeStaleBundleFiles(workspaceId, userId, bundlePath, new Set(), options.allowSystemAdmin);
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
  }

  private scheduleIngestion(workspaceId: string, id: number, userId: string, allowSystemAdmin = false): void {
    if (!this.fileService || this.inFlightIngestions.has(id)) {
      return;
    }
    const promise = this.runIngestion(workspaceId, id, userId, allowSystemAdmin)
      .catch((error) => {
        console.error('OKF knowledge ingestion failed', { workspaceId, knowledgeId: id, error });
      })
      .finally(() => {
        this.inFlightIngestions.delete(id);
      });
    this.inFlightIngestions.set(id, promise);
  }

  private async runIngestion(workspaceId: string, id: number, userId: string, allowSystemAdmin = false): Promise<void> {
    if (!this.fileService) {
      return;
    }
    await this.updateIngestionMetadata(workspaceId, id, {
      status: 'processing',
      startedAt: new Date().toISOString(),
      error: null,
      okfVersion: OKF_VERSION,
    });
    try {
      const knowledge = await this.db('knowledge_sources').where({ id, workspaceId }).first();
      if (!knowledge) {
        return;
      }
      if (!knowledge.fileId) {
        throw new ConflictError('Knowledge source is not backed by a file');
      }
      const sourceFile = await this.fileService.getFileRecord(Number(knowledge.fileId), userId, { allowSystemAdmin });
      const buffer = await this.fileService.readFileBuffer(sourceFile);
      const sourceFingerprint = createHash('sha256').update(buffer).digest('hex');
      const extracted = await this.extractKnowledgeSource(
        workspaceId,
        sourceFile,
        buffer,
      );
      const bundlePath = path.posix.join(OKF_SYSTEM_ROOT, String(id));
      const generatedAt = new Date().toISOString();
      const sourceResource = `workspace-file://${workspaceId}/${encodeURIComponent(sourceFile.name)}?sha256=${sourceFingerprint}`;
      const tags = Array.isArray(knowledge.tags)
        ? knowledge.tags.map((item: unknown) => String(item).trim()).filter(Boolean)
        : [];
      const description = String(knowledge.description || extracted.summary || '').trim();
      const documents = new Map<string, string>();
      documents.set(
        path.posix.join(bundlePath, 'source.md'),
        this.buildOkfConcept({
          type: 'Reference',
          title: String(knowledge.title || extracted.title || sourceFile.name),
          description,
          resource: sourceResource,
          tags,
          generatedAt,
          sourceTitle: sourceFile.name,
          sourceResource,
          body: extracted.markdown,
        }),
      );

      const sectionEntries: Array<{ title: string; fileName: string; description: string }> = [];
      const usedNames = new Set<string>();
      for (const [sectionIndex, section] of splitMarkdownSections(extracted.markdown).entries()) {
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
        documents.set(
          path.posix.join(bundlePath, 'concepts', fileName),
          this.buildOkfConcept({
            type: 'Knowledge Section',
            title: section.title,
            description: sectionDescription,
            resource: sourceResource,
            tags,
            generatedAt,
            sourceTitle: sourceFile.name,
            sourceResource,
            body: `${section.body}\n\n[Back to the source concept](../source.md)`,
          }),
        );
        sectionEntries.push({ title: section.title, fileName, description: sectionDescription });
      }

      const indexLines = [
        '---',
        `okf_version: ${quoteYaml(OKF_VERSION)}`,
        '---',
        '',
        `# ${String(knowledge.title || extracted.title || sourceFile.name).trim()}`,
        '',
        description || `Knowledge generated from ${sourceFile.name}.`,
        '',
        '# Source',
        '',
        `* [${String(knowledge.title || extracted.title || sourceFile.name).trim()}](source.md) - ${description || `Source material from ${sourceFile.name}`}`,
      ];
      if (sectionEntries.length) {
        indexLines.push('', '# Concepts', '');
        for (const entry of sectionEntries) {
          indexLines.push(
            `* [${entry.title}](concepts/${entry.fileName}) - ${entry.description || 'Derived knowledge section'}`,
          );
        }
      }
      documents.set(path.posix.join(bundlePath, 'index.md'), `${indexLines.join('\n').trim()}\n`);
      documents.set(
        path.posix.join(bundlePath, 'log.md'),
        `# Knowledge Update Log\n\n## ${generatedAt.slice(0, 10)}\n\n* **Update**: Published OKF bundle from [${sourceFile.name}](source.md).\n`,
      );

      for (const [fileName, content] of documents) {
        await this.fileService.upsertInternalTextFile(
          workspaceId,
          fileName,
          content,
          userId,
          'text/markdown',
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
      await this.updateIngestionMetadata(workspaceId, id, {
        status: 'published',
        publishedAt: new Date().toISOString(),
        error: null,
        sourceFingerprint,
        bundlePath,
        conceptCount: sectionEntries.length + 1,
        okfVersion: OKF_VERSION,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.updateIngestionMetadata(workspaceId, id, {
        status: 'failed',
        failedAt: new Date().toISOString(),
        error: message,
        okfVersion: OKF_VERSION,
      });
      throw error;
    }
  }

  private async extractKnowledgeSource(
    workspaceId: string,
    sourceFile: any,
    buffer: Buffer,
  ): Promise<{ title: string; summary: string; markdown: string }> {
    const extension = path.extname(String(sourceFile.name || '')).toLowerCase();
    const title = path.basename(String(sourceFile.name || 'Knowledge source'));
    if (extension === '.xlsx' || extension === '.xlsm') {
      const markdown = await workbookBufferToMarkdown(buffer, { title });
      const summary = markdown
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('#') && !line.startsWith('```'))
        || `Workbook knowledge from ${title}`;
      return { title, summary, markdown };
    }
    if (['.md', '.txt', '.csv', '.tsv', '.json', '.html', '.htm'].includes(extension)) {
      const markdown = buffer.toString('utf-8');
      const summary = markdown.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || title;
      return { title, summary, markdown: `# ${title}\n\n${markdown}` };
    }
    const response = await extractWorkspaceDocument(workspaceId, sourceFile.name);
    return {
      title: String(response.title || title),
      summary: String(response.summary || `Knowledge generated from ${title}`),
      markdown: String(response.markdown || '').trim(),
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
      'status: draft',
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

  private resolvePublishedBundle(knowledge: any): { bundlePath: string; okfVersion: string } {
    const ingestion = this.getIngestionMetadata(knowledge.metadata);
    if (ingestion?.status !== 'published' || !ingestion.bundlePath) {
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
    if (path.posix.extname(normalized).toLowerCase() !== '.md') {
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

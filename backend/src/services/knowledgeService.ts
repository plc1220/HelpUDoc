import { Knex } from 'knex';
import { DatabaseService } from './databaseService';
import { WorkspaceService } from './workspaceService';
import { ConflictError, NotFoundError } from '../errors';
import { KnowledgeType } from '../types/knowledge';

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

const SUPPORTED_TYPES: KnowledgeType[] = ['text', 'table', 'image', 'presentation', 'infographic'];

export class KnowledgeService {
  private db: Knex;
  private workspaceService: WorkspaceService;

  constructor(databaseService: DatabaseService, workspaceService: WorkspaceService) {
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
  }

  async list(workspaceId: string, userId: string) {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    const rows = await this.baseQuery()
      .where('knowledge_sources.workspaceId', workspaceId)
      .orderBy('knowledge_sources.updatedAt', 'desc');

    return rows.map((row) => this.mapRow(row));
  }

  async getById(workspaceId: string, id: number, userId: string) {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    const row = await this.baseQuery()
      .where('knowledge_sources.workspaceId', workspaceId)
      .andWhere('knowledge_sources.id', id)
      .first();
    if (!row) {
      throw new NotFoundError('Knowledge source not found');
    }
    return this.mapRow(row);
  }

  async create(workspaceId: string, userId: string, payload: KnowledgeInput) {
    this.assertType(payload.type);
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });

    if (payload.fileId) {
      await this.assertFileInWorkspace(payload.fileId, workspaceId);
    }
    this.assertMinimalFields(payload.type, payload);

    const [record] = await this.db('knowledge_sources')
      .insert({
        workspaceId,
        title: payload.title,
        type: payload.type,
        description: payload.description,
        content: payload.content,
        fileId: payload.fileId ?? null,
        sourceUrl: payload.sourceUrl,
        tags: payload.tags ?? null,
        metadata: payload.metadata ?? null,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning('*');

    await this.workspaceService.touchWorkspace(workspaceId, userId);
    return this.getById(workspaceId, record.id, userId);
  }

  async update(workspaceId: string, id: number, userId: string, payload: Partial<KnowledgeInput>) {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
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

    return this.getById(workspaceId, id, userId);
  }

  async delete(workspaceId: string, id: number, userId: string) {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const deleted = await this.db('knowledge_sources').where({ id, workspaceId }).del();
    if (!deleted) {
      throw new NotFoundError('Knowledge source not found');
    }
    await this.workspaceService.touchWorkspace(workspaceId, userId);
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
          publicUrl: row.filePublicUrl as string | null,
          storageType: row.fileStorageType as string | null,
          path: row.filePath as string | null,
        }
      : null;

    return {
      id: row.id as number,
      workspaceId: row.workspaceId as string,
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
}

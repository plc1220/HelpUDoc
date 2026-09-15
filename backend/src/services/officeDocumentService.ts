import { createHash, randomUUID } from 'crypto';
import path from 'path';
import axios from 'axios';
import { z } from 'zod';
import { ConflictError, HttpError, NotFoundError } from '../errors';
import { FileService } from './fileService';
import { WorkspaceService } from './workspaceService';
import { signAgentContextToken } from './agentToken';
import { editOfficeDocument, previewOfficeDocument } from './agentService';

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const QUICK_EDIT_OPERATION_PREFIX = 'office-quick-edit:';
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

const selection = {
  paragraphId: z.string().regex(/^p:(0|[1-9][0-9]{0,6})$/),
  start: z.number().int().nonnegative().max(10_000_000),
  end: z.number().int().nonnegative().max(10_000_000),
  quote: z.string().min(1).max(100_000),
};
export const officeQuickEditSchema = z.object({
  version: z.number().int().positive(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  edit: z.discriminatedUnion('action', [
    z.object({ ...selection, action: z.literal('bold'), value: z.boolean() }),
    z.object({ ...selection, action: z.literal('italic'), value: z.boolean() }),
    z.object({ ...selection, action: z.literal('fontSize'), value: z.number().min(1).max(400).multipleOf(0.5) }),
    z.object({ ...selection, action: z.literal('style'), value: z.string().min(1).max(200) }),
    z.object({ ...selection, action: z.literal('replaceText'), value: z.string().max(20_000) }),
  ]).refine(value => value.end > value.start, 'Select text before editing'),
});
export const officeUndoSchema = z.object({
  version: z.number().int().positive(),
  restoreVersion: z.number().int().positive(),
});
export const officePreviewSchema = z.object({
  filename: z.string().min(1).max(1024),
  content: z.string().min(1).max(Math.ceil(MAX_SOURCE_BYTES / 3) * 4),
});

type AgentOfficeClient = { preview: typeof previewOfficeDocument; edit: typeof editOfficeDocument };

/** Operations use authorized, immutable source bytes. The agent never chooses a workspace path to edit. */
export class OfficeDocumentService {
  constructor(
    private readonly files: FileService,
    private readonly workspaces: WorkspaceService,
    private readonly agent: AgentOfficeClient = { preview: previewOfficeDocument, edit: editOfficeDocument },
  ) {}

  private async file(workspaceId: string, fileId: number, userId: string, requireEdit = false) {
    const file = await this.files.getFileRecord(fileId, userId, { requireEdit });
    if (String(file.workspaceId) !== workspaceId) throw new NotFoundError('File not found in this workspace');
    return file;
  }

  private assertOfficeType(file: { name: string }, editing = false) {
    const extension = path.extname(file.name).toLowerCase();
    if (editing ? extension !== '.docx' : !['.docx', '.pptx'].includes(extension)) {
      throw new HttpError(422, editing ? 'Quick edits are available for DOCX files' : 'Office previews support DOCX and PPTX files');
    }
  }

  private token(workspaceId: string, userId: string) {
    const authToken = signAgentContextToken({ sub: userId, userId, workspaceId });
    if (!authToken) throw new HttpError(503, 'Document processing is not configured');
    return { authToken };
  }

  private async source(file: any, userId: string): Promise<Buffer> {
    const download = await this.files.getFileDownloadStream(Number(file.id), userId, Number(file.version));
    if (download.sizeBytes > MAX_SOURCE_BYTES) {
      download.stream.destroy();
      throw new HttpError(413, 'Office documents must be 25 MiB or smaller');
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of download.stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_SOURCE_BYTES) {
        download.stream.destroy();
        throw new HttpError(413, 'Office documents must be 25 MiB or smaller');
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }

  private async process<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (!axios.isAxiosError(error)) throw error;
      const status = error.response?.status;
      const messages: Record<number, string> = {
        400: 'The document request could not be processed',
        409: 'The document changed. Refresh the preview and try again',
        413: 'The document exceeds the preview size limit',
        422: 'This document or selection cannot be edited or rendered safely',
        503: 'The Office preview service is unavailable',
        504: 'The document took too long to render. Try again',
      };
      if (status && messages[status]) {
        // The internal document endpoints return intentional, user-readable validation errors.
        const detail = error.response?.data?.detail;
        throw new HttpError(status, typeof detail === 'string' && detail.length <= 300 ? detail : messages[status]);
      }
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') throw new HttpError(504, messages[504]);
      throw new HttpError(503, messages[503]);
    }
  }

  private decodeResult(content: string, limit: number): Buffer {
    if (typeof content !== 'string' || content.length > Math.ceil(limit / 3) * 4
      || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
      throw new HttpError(502, 'Document processing returned an invalid file');
    }
    const bytes = Buffer.from(content, 'base64');
    if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== content) throw new HttpError(502, 'Document processing returned an invalid file');
    return bytes;
  }

  private async render(workspaceId: string, filename: string, source: Buffer, userId: string) {
    const revision = sha256(source);
    const result = await this.process(() => this.agent.preview({
      workspaceId, filename: path.basename(filename), content: source.toString('base64'),
    }, this.token(workspaceId, userId)));
    const pdf = this.decodeResult(result.pdf, MAX_PDF_BYTES);
    if (result.revision !== revision || pdf.subarray(0, 5).toString() !== '%PDF-') {
      throw new HttpError(502, 'Document preview does not match the source file');
    }
    return { ...result, revision };
  }

  async previewBytes(workspaceId: string, userId: string, input: unknown) {
    const payload = officePreviewSchema.parse(input);
    await this.workspaces.ensureMembership(workspaceId, userId);
    this.assertOfficeType({ name: payload.filename });
    let source: Buffer;
    try { source = this.decodeResult(payload.content, MAX_SOURCE_BYTES); } catch {
      throw new HttpError(400, 'Invalid Office document content');
    }
    return { ...await this.render(workspaceId, payload.filename, source, userId), version: null, canEdit: false };
  }

  async preview(workspaceId: string, fileId: number, userId: string) {
    const file = await this.file(workspaceId, fileId, userId);
    this.assertOfficeType(file);
    const { membership } = await this.workspaces.ensureMembership(workspaceId, userId);
    const source = await this.source(file, userId);
    const result = await this.render(workspaceId, file.name, source, userId);
    return { ...result, version: Number(file.version), canEdit: Boolean(membership.canEdit) && path.extname(file.name).toLowerCase() === '.docx' };
  }

  async quickEdit(workspaceId: string, fileId: number, userId: string, input: unknown) {
    const payload = officeQuickEditSchema.parse(input);
    const file = await this.file(workspaceId, fileId, userId, true);
    this.assertOfficeType(file, true);
    if (Number(file.version) !== payload.version) throw new ConflictError('The document changed. Refresh the preview and try again');
    const source = await this.source(file, userId);
    if (sha256(source) !== payload.revision) throw new ConflictError('The document changed. Refresh the preview and try again');
    const result = await this.process(() => this.agent.edit({
      workspaceId, filename: path.basename(file.name), content: source.toString('base64'),
      revision: payload.revision, edit: payload.edit,
    }, this.token(workspaceId, userId)));
    const updated = this.decodeResult(result.content, MAX_SOURCE_BYTES);
    if (sha256(updated) !== result.revision || updated.subarray(0, 2).toString() !== 'PK') {
      throw new HttpError(502, 'Document processing returned an invalid DOCX file');
    }
    const saved = await this.files.commitFileBuffer(fileId, updated, userId, payload.version, {
      strictVersion: true,
      operationId: `${QUICK_EDIT_OPERATION_PREFIX}${randomUUID()}`,
    });
    return { file: { ...saved, content: result.content }, previousVersion: payload.version };
  }

  async undo(workspaceId: string, fileId: number, userId: string, input: unknown) {
    const payload = officeUndoSchema.parse(input);
    const file = await this.file(workspaceId, fileId, userId, true);
    this.assertOfficeType(file, true);
    if (Number(file.version) !== payload.version) throw new ConflictError('The document changed. Undo is no longer available');
    const versions = await this.files.getFileVersions(fileId, userId);
    const current = versions.find(version => Number(version.version) === payload.version);
    const previous = versions.find(version => Number(version.version) === payload.restoreVersion);
    if (!current || !previous || current.createdBy !== userId
      || !String(current.operationId || '').startsWith(QUICK_EDIT_OPERATION_PREFIX)
      || Number(current.baseVersion) !== payload.restoreVersion) {
      throw new ConflictError('Only your most recent quick edit can be undone');
    }
    const source = await this.source({ ...file, version: payload.restoreVersion }, userId);
    // restoreFileVersion checks expectedVersion again under its row lock before writing.
    const restored = await this.files.restoreFileVersion(fileId, String(previous.id), userId, payload.version);
    return { file: { ...restored, content: source.toString('base64') } };
  }
}

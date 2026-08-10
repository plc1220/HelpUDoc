import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import * as path from 'path';
import type { ObjectStore } from './objectStore';
import { getObjectStore } from './objectStoreFactory';
import { DatabaseService } from './databaseService';
import { Knex } from 'knex';
import { WorkspaceService } from './workspaceService';
import { ConflictError, NotFoundError } from '../errors';
import { resolveWorkspaceRoot } from '../config/workspaceRoot';

const WORKSPACE_DIR = resolveWorkspaceRoot();
const TEXT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'application/json',
  'text/html',
  'text/css',
  'application/javascript',
];

const TEXT_FILE_EXTENSIONS = ['.md', '.mermaid', '.txt', '.json', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.svg', '.csv'];
const INTERNAL_WORKSPACE_DIR_NAMES = new Set(['.system', 'sandbox-runs']);
const TEXT_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.mermaid': 'text/plain',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv',
};
const BINARY_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.parquet': 'application/octet-stream',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const normalizeS3Key = (workspaceId: string, fileName: string) => {
  const sanitized = fileName.replace(/^\/+/, '').replace(/\\/g, '/');
  return path.posix.normalize(`${workspaceId}/${sanitized}`);
};

type FileVersionChangeKind = 'create' | 'content' | 'rename' | 'move' | 'restore' | 'delete' | 'artifact';

export type WorkspaceArtifactBaseline = Record<string, {
  fileId: number;
  version: number;
  sha256: string | null;
}>;

export class FileService {
  private objectStore: ObjectStore;
  private db: Knex;
  private workspaceService: WorkspaceService;

  constructor(databaseService: DatabaseService, workspaceService: WorkspaceService) {
    this.objectStore = getObjectStore();
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
  }

  async createDirectUploadUrl(
    workspaceId: string,
    uploadId: string,
    fileName: string,
    mimeType: string,
    userId: string,
    expiresInSeconds: number,
    options?: { allowSystemAdmin?: boolean },
  ): Promise<{
    objectKey: string;
    uploadUrl: string;
    uploadHeaders: Readonly<Record<string, string>>;
    requestedFileName: string;
  }> {
    await this.workspaceService.ensureMembership(workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options?.allowSystemAdmin,
    });
    const requestedFileName = this.normalizeRelativePath(fileName);
    if (this.isInternalWorkspacePath(requestedFileName)) {
      throw new ConflictError('System workspace paths are reserved');
    }
    const objectKey = normalizeS3Key(
      workspaceId,
      path.posix.join('.system', 'uploads', uploadId, path.posix.basename(requestedFileName)),
    );
    const signedUpload = await this.objectStore.signUpload(objectKey, {
      mimeType,
      expiresInSeconds,
      ifAbsent: true,
    });
    return {
      objectKey,
      uploadUrl: signedUpload.url,
      uploadHeaders: signedUpload.headers,
      requestedFileName,
    };
  }

  async inspectStoredObject(objectKey: string) {
    return this.objectStore.head(objectKey);
  }

  async finalizeDirectUpload(
    input: {
      workspaceId: string;
      objectKey: string;
      requestedFileName: string;
      mimeType: string;
    },
    userId: string,
    options?: { allowSystemAdmin?: boolean },
  ) {
    await this.workspaceService.ensureMembership(input.workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options?.allowSystemAdmin,
    });
    const relativePath = await this.resolveUniqueRelativePath(
      input.workspaceId,
      input.requestedFileName,
      userId,
      options,
    );
    const uploadPrefix = normalizeS3Key(input.workspaceId, path.posix.join('.system', 'uploads'));
    if (!String(input.objectKey).startsWith(`${uploadPrefix}/`)) {
      throw new ConflictError('Upload object does not belong to this workspace session');
    }
    const metadata = await this.objectStore.head(String(input.objectKey));
    const sha256 = metadata.integrity.sha256 || await this.hashStoredObject(String(input.objectKey));
    const versionId = randomUUID();
    let createdFileId: number | null = null;
    try {
      const newFile = await this.db.transaction(async (tx) => {
        const [created] = await tx('files').insert({
          name: relativePath,
          workspaceId: input.workspaceId,
          storageType: 's3',
          path: input.objectKey,
          mimeType: input.mimeType,
          publicUrl: null,
          version: 1,
          createdBy: userId,
          updatedBy: userId,
        }).returning('*');
        createdFileId = Number(created.id);
        await tx('file_versions').insert(this.buildVersionRecord({
          id: versionId,
          file: created,
          version: 1,
          name: relativePath,
          mimeType: input.mimeType,
          objectKey: input.objectKey,
          providerVersion: metadata.providerVersion,
          sha256,
          sizeBytes: metadata.sizeBytes,
          changeKind: 'create',
          createdBy: userId,
        }));
        const [current] = await tx('files')
          .where({ id: created.id })
          .update({ currentVersionId: versionId })
          .returning('*');
        return current;
      });
      await this.workspaceService.touchWorkspace(input.workspaceId, userId, { contentChanged: true });
      return newFile;
    } catch (error) {
      if (createdFileId) await this.db('files').where({ id: createdFileId }).del().catch(() => undefined);
      throw error;
    }
  }

  async deleteStoredObject(objectKey: string): Promise<void> {
    await this.objectStore.delete(objectKey, { ignoreMissing: true });
  }

  async ensureLocalMirror(file: any): Promise<string> {
    if (file.storageType === 'local') return String(file.path);
    const localPath = this.getLocalPath(String(file.workspaceId), String(file.name));
    const expectedVersion = file.currentVersionId
      ? await this.db('file_versions')
        .where({ id: file.currentVersionId })
        .select('sha256', 'objectProvider')
        .first()
      : null;
    this.assertObjectProvider(expectedVersion?.objectProvider);
    try {
      const local = await fs.stat(localPath);
      const remote = await this.objectStore.head(String(file.path));
      if (local.isFile() && local.size === remote.sizeBytes) {
        if (!expectedVersion?.sha256 || await this.hashLocalPath(localPath) === expectedVersion.sha256) return localPath;
      }
    } catch {
      // Missing or stale local mirrors are rebuilt from object storage below.
    }
    const temporaryPath = `${localPath}.download-${process.pid}-${Date.now()}.part`;
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    try {
      await this.objectStore.downloadToPath(String(file.path), temporaryPath);
      await fs.rename(temporaryPath, localPath);
      return localPath;
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async ensureLocalMirrorForVersion(file: any, version: number): Promise<string> {
    await this.ensureCanonicalVersion(file);
    const currentVersion = this.assertVersion(file.version);
    if (version === currentVersion) return this.ensureLocalMirror(file);
    const historical = await this.db('file_versions')
      .where({ fileId: file.id, version })
      .first();
    if (!historical || historical.changeKind === 'delete') {
      throw new NotFoundError('File version not found');
    }
    this.assertObjectProvider(historical.objectProvider);
    const historicalPath = this.getLocalPath(
      String(file.workspaceId),
      path.posix.join('.system', 'tagged-versions', String(file.id), `v${version}`, path.posix.basename(String(historical.name))),
    );
    try {
      const local = await fs.stat(historicalPath);
      if (local.isFile() && local.size === Number(historical.sizeBytes || 0)) return historicalPath;
    } catch {
      // Materialize the immutable historical object below.
    }
    const temporaryPath = `${historicalPath}.download-${process.pid}-${randomUUID()}.part`;
    await fs.mkdir(path.dirname(historicalPath), { recursive: true });
    try {
      await this.objectStore.downloadToPath(String(historical.objectKey), temporaryPath, {
        providerVersion: historical.providerVersion || undefined,
      });
      await fs.rename(temporaryPath, historicalPath);
      return historicalPath;
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async hashFile(file: any): Promise<string> {
    const localPath = await this.ensureLocalMirror(file);
    return this.hashLocalPath(localPath);
  }

  private async hashLocalPath(localPath: string): Promise<string> {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(localPath)) {
      digest.update(chunk as Buffer);
    }
    return digest.digest('hex');
  }

  private async readObjectBuffer(objectKey: string, providerVersion?: string): Promise<Buffer> {
    const { stream } = await this.objectStore.getStream(String(objectKey), { providerVersion });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private assertObjectProvider(provider?: string | null): void {
    if (provider && provider !== this.objectStore.provider) {
      throw new ConflictError(
        `File object is stored in ${provider}; migrate and verify it before switching to ${this.objectStore.provider}`,
      );
    }
  }

  private async hashStoredObject(objectKey: string, providerVersion?: string): Promise<string> {
    const { stream } = await this.objectStore.getStream(objectKey, { providerVersion });
    const digest = createHash('sha256');
    for await (const chunk of stream) digest.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return digest.digest('hex');
  }

  private isInternalWorkspacePath(fileName: string): boolean {
    const normalized = fileName.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    const parts = normalized.split('/').filter(Boolean);
    return parts.some((part) => INTERNAL_WORKSPACE_DIR_NAMES.has(part));
  }

  async getFiles(workspaceId: string, userId: string, options?: { includeInternal?: boolean }) {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    const files = await this.db('files').where({ workspaceId }).whereNull('deletedAt');
    const globalKnowledgeFiles = await this.db('knowledge_sources')
      .select('fileId')
      .where({ isGlobal: true, workspaceId })
      .whereNotNull('fileId');
    const standaloneKnowledgeFileIds = new Set(
      globalKnowledgeFiles.map((row: { fileId: number }) => Number(row.fileId)),
    );
    const visibleFiles = options?.includeInternal
      ? files
      : files.filter((file) => (
          !this.isInternalWorkspacePath(String(file.name || ''))
          && !standaloneKnowledgeFileIds.has(Number(file.id))
        ));
    await Promise.all(visibleFiles.map((file) => this.clearLegacyPublicUrl(file)));
    return visibleFiles;
  }

  async hasFileName(
    workspaceId: string,
    fileName: string,
    userId: string,
    options?: { allowSystemAdmin?: boolean },
  ): Promise<boolean> {
    await this.workspaceService.ensureMembership(workspaceId, userId, options);
    const existing = await this.db('files').where({ workspaceId, name: fileName }).whereNull('deletedAt').first();
    return Boolean(existing);
  }

  async resolveUniqueRelativePath(
    workspaceId: string,
    fileName: string,
    userId: string,
    options?: { allowSystemAdmin?: boolean },
  ): Promise<string> {
    await this.workspaceService.ensureMembership(workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options?.allowSystemAdmin,
    });
    const relativePath = this.normalizeRelativePath(fileName);
    if (!await this.hasFileName(workspaceId, relativePath, userId, options)) {
      return relativePath;
    }

    const parsed = path.posix.parse(relativePath);
    const directory = parsed.dir ? `${parsed.dir}/` : '';
    const baseName = parsed.name || 'file';
    const extension = parsed.ext || '';
    for (let index = 2; index <= 99; index += 1) {
      const candidate = `${directory}${baseName} (${index})${extension}`;
      if (!await this.hasFileName(workspaceId, candidate, userId, options)) {
        return candidate;
      }
    }

    let candidate = `${directory}${baseName}-${Date.now()}${extension}`;
    while (await this.hasFileName(workspaceId, candidate, userId, options)) {
      candidate = `${directory}${baseName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${extension}`;
    }
    return candidate;
  }

  async listFolders(workspaceId: string, userId: string): Promise<string[]> {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    const workspaceRoot = path.resolve(WORKSPACE_DIR, workspaceId);
    try {
      await fs.access(workspaceRoot);
    } catch {
      return [];
    }

    const folders = await this.walkWorkspaceFolders(workspaceRoot);
    return folders
      .map((folderPath) => path.relative(workspaceRoot, folderPath).replace(/\\/g, '/'))
      .filter(Boolean)
      .filter((folderPath) => !this.isInternalWorkspacePath(folderPath))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
  }

  async createFolder(workspaceId: string, folderPath: string, userId: string) {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });

    const normalizedFolder = this.normalizeRelativeFolderPath(folderPath);
    if (!normalizedFolder) {
      throw new ConflictError('Folder path is required');
    }
    if (this.isInternalWorkspacePath(normalizedFolder)) {
      throw new ConflictError('System workspace paths are reserved');
    }

    const workspaceRoot = path.resolve(WORKSPACE_DIR, workspaceId);
    const absoluteFolderPath = path.resolve(workspaceRoot, normalizedFolder);
    if (!absoluteFolderPath.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new ConflictError('Invalid folder path');
    }

    await fs.mkdir(absoluteFolderPath, { recursive: true });
    await this.workspaceService.touchWorkspace(workspaceId, userId, { contentChanged: true });

    return { path: normalizedFolder };
  }

  private isTextFile(fileName: string, mimeType: string): boolean {
    const ext = path.extname(fileName).toLowerCase();
    if (TEXT_FILE_EXTENSIONS.includes(ext)) {
      return true;
    }
    if (mimeType && TEXT_MIME_TYPES.some(type => mimeType.startsWith(type))) {
      return true;
    }
    return false;
  }

  private resolveMimeType(fileName: string, current?: string | null): string | null {
    if (current) {
      return current;
    }
    const ext = path.extname(fileName).toLowerCase();
    return TEXT_MIME_TYPES_BY_EXTENSION[ext] || BINARY_MIME_TYPES_BY_EXTENSION[ext] || null;
  }

  private normalizeRelativePath(fileName: string): string {
    const normalized = path.posix
      .normalize(fileName.replace(/\\/g, '/'))
      .replace(/^(\.\.\/)+/, '')
      .replace(/^\/+/, '');
    if (!normalized || normalized === '.') {
      throw new ConflictError('Invalid file name');
    }
    return normalized;
  }

  private normalizeRelativeFolderPath(folderPath: string): string {
    const normalized = path.posix
      .normalize((folderPath || '').replace(/\\/g, '/'))
      .replace(/^(\.\.\/)+/, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.includes('..')) {
      throw new ConflictError('Invalid folder path');
    }
    if (!normalized || normalized === '.') {
      return '';
    }
    return normalized;
  }

  private getLocalPath(workspaceId: string, fileName: string): string {
    const relative = this.normalizeRelativePath(fileName);
    return path.join(WORKSPACE_DIR, workspaceId, relative);
  }

  private async clearLegacyPublicUrl(file: any): Promise<void> {
    const mimeType = this.resolveMimeType(file.name, file.mimeType);
    const update: Record<string, unknown> = {};
    if (file.publicUrl) {
      file.publicUrl = null;
      update.publicUrl = null;
    }
    if (!file.mimeType && mimeType) {
      file.mimeType = mimeType;
      update.mimeType = mimeType;
    }
    if (Object.keys(update).length) {
      await this.db('files').where({ id: file.id }).update(update);
    }
  }

  private immutableObjectKey(workspaceId: string, versionId: string): string {
    return normalizeS3Key(workspaceId, path.posix.join('.system', 'file-versions', versionId));
  }

  private hashBuffer(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private buildVersionRecord(input: {
    id: string;
    file: any;
    version: number;
    name: string;
    mimeType: string | null;
    objectKey: string;
    providerVersion?: string | null;
    sha256?: string | null;
    sizeBytes: number;
    changeKind: FileVersionChangeKind;
    baseVersion?: number | null;
    createdBy?: string | null;
    sourceRunId?: string | null;
    operationId?: string | null;
  }) {
    return {
      id: input.id,
      fileId: Number(input.file.id),
      workspaceId: String(input.file.workspaceId),
      version: input.version,
      name: input.name,
      mimeType: input.mimeType,
      objectKey: input.objectKey,
      objectProvider: this.objectStore.provider,
      providerVersion: input.providerVersion || null,
      sha256: input.sha256 || null,
      sizeBytes: input.sizeBytes,
      changeKind: input.changeKind,
      baseVersion: input.baseVersion || null,
      createdBy: input.createdBy || null,
      sourceRunId: input.sourceRunId || null,
      operationId: input.operationId || null,
    };
  }

  private async writeLocalMirror(workspaceId: string, name: string, payload: Buffer): Promise<string> {
    const destination = this.getLocalPath(workspaceId, name);
    const temporary = `${destination}.write-${process.pid}-${randomUUID()}.part`;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.writeFile(temporary, payload, { flag: 'wx' });
      await fs.rename(temporary, destination);
      return destination;
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async uploadImmutableObject(
    workspaceId: string,
    versionId: string,
    payload: Buffer,
    mimeType: string,
  ) {
    const objectKey = this.immutableObjectKey(workspaceId, versionId);
    const sha256 = this.hashBuffer(payload);
    const metadata = await this.objectStore.putStream(objectKey, Readable.from(payload), {
      mimeType,
      contentLength: payload.length,
      sha256,
      ifAbsent: true,
    });
    return { objectKey, metadata, sha256 };
  }

  private async ensureCanonicalVersion(file: any, userId?: string): Promise<any> {
    if (file.currentVersionId) {
      const existing = await this.db('file_versions').where({ id: file.currentVersionId }).first();
      if (existing) {
        this.assertObjectProvider(existing.objectProvider);
        return existing;
      }
    }

    const version = this.assertVersion(file.version);
    const mimeType = this.resolveMimeType(file.name, file.mimeType) || 'application/octet-stream';
    const payload = await this.readFileBuffer(file);
    const versionId = randomUUID();
    let objectKey = String(file.path);
    let metadata: any;
    let uploaded = false;
    if (file.storageType === 'local') {
      const upload = await this.uploadImmutableObject(String(file.workspaceId), versionId, payload, mimeType);
      objectKey = upload.objectKey;
      metadata = upload.metadata;
      uploaded = true;
    } else {
      this.assertObjectProvider('s3');
      metadata = await this.objectStore.head(objectKey);
    }

    try {
      return await this.db.transaction(async (tx) => {
        const locked = await tx('files').where({ id: file.id }).forUpdate().first();
        if (!locked || locked.deletedAt) throw new NotFoundError('File not found');
        if (locked.currentVersionId) {
          const winner = await tx('file_versions').where({ id: locked.currentVersionId }).first();
          if (winner) return winner;
        }
        const record = this.buildVersionRecord({
          id: versionId,
          file: locked,
          version,
          name: String(locked.name),
          mimeType,
          objectKey,
          providerVersion: metadata.providerVersion,
          sha256: metadata.integrity?.sha256 || this.hashBuffer(payload),
          sizeBytes: metadata.sizeBytes ?? payload.length,
          changeKind: version === 1 ? 'create' : 'content',
          createdBy: userId || locked.updatedBy || locked.createdBy || null,
        });
        await tx('file_versions').insert(record);
        await tx('files').where({ id: locked.id }).update({
          storageType: 's3',
          path: objectKey,
          currentVersionId: versionId,
        });
        return record;
      });
    } catch (error) {
      if (uploaded) await this.objectStore.delete(objectKey, { ignoreMissing: true }).catch(() => undefined);
      throw error;
    }
  }

  async createFile(
    workspaceId: string,
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string,
    userId: string,
    options?: {
      forceLocal?: boolean;
      sourceProvider?: string | null;
      sourceExternalId?: string | null;
      sourceVersionFingerprint?: string | null;
      sourceUrl?: string | null;
      internal?: boolean;
      allowSystemAdmin?: boolean;
      sourceRunId?: string | null;
      operationId?: string | null;
      changeKind?: FileVersionChangeKind;
    },
  ) {
    await this.workspaceService.ensureMembership(workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options?.allowSystemAdmin,
    });
    const relativePath = this.normalizeRelativePath(fileName);
    if (this.isInternalWorkspacePath(relativePath) && !options?.internal) {
      throw new ConflictError('System workspace paths are reserved');
    }
    const existingFile = await this.db('files')
      .where({ workspaceId, name: relativePath })
      .whereNull('deletedAt')
      .first();
    if (existingFile) {
      throw new ConflictError(`File "${relativePath}" already exists`);
    }
    const versionId = randomUUID();
    const upload = await this.uploadImmutableObject(workspaceId, versionId, fileBuffer, mimeType);
    let newFile: any;
    try {
      newFile = await this.db.transaction(async (tx) => {
        const [created] = await tx('files').insert({
          name: relativePath,
          workspaceId,
          storageType: 's3',
          path: upload.objectKey,
          mimeType,
          publicUrl: null,
          sourceProvider: options?.sourceProvider || null,
          sourceExternalId: options?.sourceExternalId || null,
          sourceVersionFingerprint: options?.sourceVersionFingerprint || null,
          sourceUrl: options?.sourceUrl || null,
          version: 1,
          createdBy: userId,
          updatedBy: userId,
        }).returning('*');
        await tx('file_versions').insert(this.buildVersionRecord({
          id: versionId,
          file: created,
          version: 1,
          name: relativePath,
          mimeType,
          objectKey: upload.objectKey,
          providerVersion: upload.metadata.providerVersion,
          sha256: upload.sha256,
          sizeBytes: fileBuffer.length,
          changeKind: options?.changeKind || 'create',
          createdBy: userId,
          sourceRunId: options?.sourceRunId,
          operationId: options?.operationId,
        }));
        const [updated] = await tx('files')
          .where({ id: created.id })
          .update({ currentVersionId: versionId })
          .returning('*');
        return updated;
      });
    } catch (error) {
      await this.objectStore.delete(upload.objectKey, { ignoreMissing: true }).catch(() => undefined);
      throw error;
    }

    await this.writeLocalMirror(workspaceId, relativePath, fileBuffer).catch((error) => {
      console.error('Failed to refresh local file cache after durable create:', error);
    });

    await this.workspaceService.touchWorkspace(workspaceId, userId, { contentChanged: true });

    return newFile;
  }

  async captureWorkspaceArtifactBaseline(workspaceId: string, userId: string): Promise<WorkspaceArtifactBaseline> {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    const rows = await this.db('files as file')
      .leftJoin('file_versions as version', 'file.currentVersionId', 'version.id')
      .select('file.id', 'file.name', 'file.version', 'version.sha256')
      .where({ 'file.workspaceId': workspaceId })
      .whereNull('file.deletedAt');
    return Object.fromEntries(rows
      .filter((row) => !this.isInternalWorkspacePath(String(row.name || '')))
      .map((row) => [String(row.name), {
        fileId: Number(row.id),
        version: this.assertVersion(row.version),
        sha256: row.sha256 || null,
      }]));
  }

  async reconcileWorkspaceMirror(
    workspaceId: string,
    userId: string,
    assertLeaseOwned?: () => Promise<void>,
  ): Promise<void> {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const workspacePath = path.join(WORKSPACE_DIR, workspaceId);
    await fs.mkdir(workspacePath, { recursive: true });
    const liveFiles = await this.db('files')
      .where({ workspaceId })
      .whereNull('deletedAt');
    const durableNames = new Set<string>();
    for (const file of liveFiles) {
      await assertLeaseOwned?.();
      const relativeName = this.normalizeRelativePath(String(file.name));
      if (this.isInternalWorkspacePath(relativeName)) continue;
      await this.ensureCanonicalVersion(file, userId);
      const canonicalFile = await this.db('files').where({ id: file.id }).first();
      if (!canonicalFile || canonicalFile.deletedAt) continue;
      const canonicalName = this.normalizeRelativePath(String(canonicalFile.name));
      if (this.isInternalWorkspacePath(canonicalName)) continue;
      durableNames.add(canonicalName);
      await this.ensureLocalMirror(canonicalFile);
    }
    const latestLiveNames = await this.db('files')
      .where({ workspaceId })
      .whereNull('deletedAt')
      .select('name');
    for (const row of latestLiveNames) {
      const latestName = this.normalizeRelativePath(String(row.name));
      if (!this.isInternalWorkspacePath(latestName)) durableNames.add(latestName);
    }
    let diskFiles: string[] = [];
    try {
      diskFiles = await this.walkWorkspace(workspacePath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const absolutePath of diskFiles) {
      const relativeName = path.relative(workspacePath, absolutePath).replace(/\\/g, '/');
      if (this.isInternalWorkspacePath(relativeName) || durableNames.has(relativeName)) continue;
      await assertLeaseOwned?.();
      const becameLive = await this.db('files')
        .where({ workspaceId, name: relativeName })
        .whereNull('deletedAt')
        .first();
      if (becameLive) continue;
      await fs.unlink(absolutePath);
    }
  }

  private async restoreDurableWorkspaceMirror(workspaceId: string, relativeName: string): Promise<void> {
    const localPath = this.getLocalPath(workspaceId, relativeName);
    await fs.unlink(localPath).catch((error: any) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    const current = await this.db('files')
      .where({ workspaceId, name: relativeName })
      .whereNull('deletedAt')
      .first();
    if (current) await this.ensureLocalMirror(current);
  }

  async commitWorkspaceArtifacts(
    workspaceId: string,
    userId: string,
    sourceRunId: string,
    options?: {
      baseline?: WorkspaceArtifactBaseline | null;
      touchedPaths?: string[];
      assertLeaseOwned?: () => Promise<void>;
    },
  ) {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const workspacePath = path.join(WORKSPACE_DIR, workspaceId);
    let diskFiles: string[];
    try {
      diskFiles = await this.walkWorkspace(workspacePath);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const liveFiles = await this.db('files').where({ workspaceId }).whereNull('deletedAt');
    const byLocalPath = new Map<string, any>();
    for (const file of liveFiles) {
      byLocalPath.set(path.normalize(this.getLocalPath(workspaceId, String(file.name))), file);
    }
    const touched = new Set((options?.touchedPaths || []).flatMap((rawPath) => {
      try {
        const normalized = this.normalizeRelativePath(String(rawPath || '').replace(/^\/+/, ''));
        return this.isInternalWorkspacePath(normalized) ? [] : [normalized];
      } catch {
        return [];
      }
    }));
    const restrictToTouchedPaths = options?.touchedPaths !== undefined;

    const committed: any[] = [];
    for (const absolutePath of diskFiles) {
      const relativeName = path.relative(workspacePath, absolutePath).replace(/\\/g, '/');
      if (this.isInternalWorkspacePath(relativeName)) continue;
      if (restrictToTouchedPaths && !touched.has(relativeName)) continue;
      await options?.assertLeaseOwned?.();
      const payload = await fs.readFile(absolutePath);
      const digest = this.hashBuffer(payload);
      const existing = byLocalPath.get(path.normalize(absolutePath));
      if (!existing) {
        if (options?.baseline?.[relativeName]) {
          await this.restoreDurableWorkspaceMirror(workspaceId, relativeName);
          throw new ConflictError(`Artifact path changed concurrently: ${relativeName}`);
        }
        const mimeType = this.resolveMimeType(relativeName, null) || 'application/octet-stream';
        try {
          await options?.assertLeaseOwned?.();
          committed.push(await this.createFile(workspaceId, relativeName, payload, mimeType, userId, {
            sourceRunId,
            operationId: `${sourceRunId}:create:${relativeName}:${digest}`,
            changeKind: 'artifact',
          }));
        } catch (error: any) {
          if (error instanceof ConflictError || error?.code === '23505') {
            await this.restoreDurableWorkspaceMirror(workspaceId, relativeName);
            throw new ConflictError(`Artifact path changed concurrently: ${relativeName}`);
          }
          throw error;
        }
        continue;
      }
      const current = await this.ensureCanonicalVersion(existing, userId);
      if (current.sha256 === digest) continue;
      const baseline = options?.baseline?.[relativeName];
      if (options?.baseline && (!baseline || baseline.fileId !== Number(existing.id))) {
        await this.restoreDurableWorkspaceMirror(workspaceId, relativeName);
        throw new ConflictError(`Artifact path changed concurrently: ${relativeName}`);
      }
      if (baseline && this.assertVersion(existing.version) !== baseline.version) {
        await this.restoreDurableWorkspaceMirror(workspaceId, relativeName);
        throw new ConflictError(`Artifact changed concurrently: ${relativeName}`, {
          expectedVersion: baseline.version,
          actualVersion: this.assertVersion(existing.version),
        });
      }
      try {
        await options?.assertLeaseOwned?.();
        committed.push(await this.commitFileBuffer(
          Number(existing.id),
          payload,
          userId,
          baseline?.version || this.assertVersion(existing.version),
          {
            changeKind: 'artifact',
            sourceRunId,
            operationId: `${sourceRunId}:update:${existing.id}:${digest}`,
            strictVersion: true,
          },
        ));
      } catch (error) {
        if (error instanceof ConflictError || error instanceof NotFoundError) {
          await this.restoreDurableWorkspaceMirror(workspaceId, relativeName);
          if (error instanceof NotFoundError) {
            throw new ConflictError(`Artifact path changed concurrently: ${relativeName}`);
          }
        }
        throw error;
      }
    }
    return committed;
  }

  async createTextFile(
    workspaceId: string,
    fileName: string,
    content: string,
    userId: string,
    mimeType = 'text/markdown',
    options?: { internal?: boolean; allowSystemAdmin?: boolean },
  ) {
    return this.createFile(
      workspaceId,
      fileName,
      Buffer.from(content, 'utf-8'),
      mimeType,
      userId,
      { forceLocal: true, internal: options?.internal, allowSystemAdmin: options?.allowSystemAdmin },
    );
  }

  async upsertInternalTextFile(
    workspaceId: string,
    fileName: string,
    content: string,
    userId: string,
    mimeType = 'text/markdown',
    options?: { allowSystemAdmin?: boolean },
  ) {
    await this.workspaceService.ensureMembership(workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options?.allowSystemAdmin,
    });
    const relativePath = this.normalizeRelativePath(fileName);
    if (!this.isInternalWorkspacePath(relativePath)) {
      throw new ConflictError('Internal text files must use a reserved system workspace path');
    }
    const existing = await this.db('files')
      .where({ workspaceId, name: relativePath })
      .whereNull('deletedAt')
      .first();
    if (existing) {
      return this.updateFile(Number(existing.id), content, userId, undefined, options);
    }
    return this.createTextFile(
      workspaceId,
      relativePath,
      content,
      userId,
      mimeType,
      { internal: true, allowSystemAdmin: options?.allowSystemAdmin },
    );
  }

  async getFileContent(fileId: number, userId: string) {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) {
      throw new NotFoundError('File not found');
    }

    await this.workspaceService.ensureMembership(file.workspaceId, userId);
    await this.clearLegacyPublicUrl(file);
    const canonical = await this.ensureCanonicalVersion(file, userId);
    this.assertObjectProvider(canonical.objectProvider);

    const buffer = file.storageType === 'local'
      ? await fs.readFile(file.path)
      : await this.readObjectBuffer(file.path);
    const mimeType = this.resolveMimeType(file.name, file.mimeType) || 'application/octet-stream';

    if (this.isTextFile(file.name, mimeType)) {
      const content = buffer.toString('utf-8');
      return { ...file, content };
    } else {
      const content = buffer.toString('base64');
      return { ...file, content };
    }
  }

  async getFileDownload(fileId: number, userId: string, version?: number) {
    const download = await this.getFileDownloadStream(fileId, userId, version);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return { ...download, buffer: Buffer.concat(chunks) };
  }

  async getFileDownloadStream(fileId: number, userId: string, version?: number) {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) throw new NotFoundError('File not found');
    await this.workspaceService.ensureMembership(file.workspaceId, userId);
    const current = await this.ensureCanonicalVersion(file, userId);
    const selected = typeof version === 'number'
      ? await this.db('file_versions').where({ fileId, version }).first()
      : current;
    if (!selected) throw new NotFoundError('File version not found');
    this.assertObjectProvider(selected.objectProvider);
    const object = await this.objectStore.getStream(String(selected.objectKey), {
      providerVersion: selected.providerVersion || undefined,
    });
    return {
      file,
      version: selected,
      stream: object.stream,
      sizeBytes: Number(selected.sizeBytes || object.metadata.sizeBytes || 0),
      mimeType: selected.mimeType || this.resolveMimeType(file.name, file.mimeType) || 'application/octet-stream',
      name: String(selected.name || file.name),
    };
  }

  async getFileVersions(fileId: number, userId: string) {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) throw new NotFoundError('File not found');
    await this.workspaceService.ensureMembership(file.workspaceId, userId);
    await this.ensureCanonicalVersion(file, userId);
    return this.db('file_versions')
      .select(
        'id', 'fileId', 'workspaceId', 'version', 'name', 'mimeType', 'sha256',
        'sizeBytes', 'changeKind', 'baseVersion', 'createdBy', 'sourceRunId',
        'operationId', 'createdAt',
      )
      .where({ fileId })
      .orderBy('version', 'desc');
  }

  async restoreFileVersion(
    fileId: number,
    versionId: string,
    userId: string,
    expectedVersion?: number,
  ) {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) throw new NotFoundError('File not found');
    await this.workspaceService.ensureMembership(file.workspaceId, userId, { requireEdit: true });
    await this.ensureCanonicalVersion(file, userId);
    const source = await this.db('file_versions').where({ id: versionId, fileId }).first();
    if (!source) throw new NotFoundError('File version not found');

    const restoredVersionId = randomUUID();
    let updated: any;
    await this.db.transaction(async (tx) => {
      const locked = await tx('files')
        .where({ id: fileId })
        .whereNull('deletedAt')
        .forUpdate()
        .first();
      if (!locked) throw new NotFoundError('File not found');
      const currentVersion = this.assertVersion(locked.version, expectedVersion);
      const nextVersion = currentVersion + 1;
      await tx('file_versions').insert(this.buildVersionRecord({
        id: restoredVersionId,
        file: locked,
        version: nextVersion,
        name: String(locked.name),
        mimeType: source.mimeType || locked.mimeType || null,
        objectKey: String(source.objectKey),
        providerVersion: source.providerVersion || null,
        sha256: source.sha256 || null,
        sizeBytes: Number(source.sizeBytes || 0),
        changeKind: 'restore',
        baseVersion: Number(source.version),
        createdBy: userId,
      }));
      [updated] = await tx('files').where({ id: fileId }).update({
        storageType: 's3',
        path: source.objectKey,
        mimeType: source.mimeType || locked.mimeType,
        currentVersionId: restoredVersionId,
        version: nextVersion,
        updatedBy: userId,
        updatedAt: tx.fn.now(),
      }).returning('*');
      await tx('workspaces').where({ id: locked.workspaceId }).update({
        contentRevision: tx.raw('COALESCE("contentRevision", 0) + 1'),
        updatedAt: tx.fn.now(),
        lastModifiedBy: userId,
      });
    });
    const payload = await this.readObjectBuffer(String(source.objectKey), source.providerVersion || undefined);
    await this.writeLocalMirror(String(file.workspaceId), String(updated.name), payload).catch((error) => {
      console.error('Failed to refresh local file cache after durable update:', error);
    });
    return updated;
  }

  async getFileRecord(fileId: number, userId: string, options?: { requireEdit?: boolean; allowSystemAdmin?: boolean }) {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) {
      throw new NotFoundError('File not found');
    }
    await this.workspaceService.ensureMembership(file.workspaceId, userId, options);
    await this.clearLegacyPublicUrl(file);
    return file;
  }

  async findImportedExternalFile(
    workspaceId: string,
    userId: string,
    params: {
      sourceProvider: string;
      sourceExternalId: string;
      sourceVersionFingerprint: string;
    },
  ) {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    const file = await this.db('files')
      .where({
        workspaceId,
        sourceProvider: params.sourceProvider,
        sourceExternalId: params.sourceExternalId,
        sourceVersionFingerprint: params.sourceVersionFingerprint,
      })
      .whereNull('deletedAt')
      .first();
    if (!file) {
      return null;
    }
    await this.clearLegacyPublicUrl(file);
    return file;
  }

  async readFileBuffer(file: any): Promise<Buffer> {
    if (file.storageType === 'local') {
      return fs.readFile(file.path);
    }
    return this.readObjectBuffer(file.path);
  }

  async commitFileBuffer(
    fileId: number,
    payload: Buffer,
    userId: string,
    expectedVersion?: number,
    options?: {
      allowSystemAdmin?: boolean;
      changeKind?: FileVersionChangeKind;
      sourceRunId?: string | null;
      operationId?: string | null;
      strictVersion?: boolean;
    },
  ) {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) throw new NotFoundError('File not found');

    const { workspace } = await this.workspaceService.ensureMembership(file.workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options?.allowSystemAdmin,
    });
    const freeflow = workspace.visibility === 'team' && workspace.editingPolicy === 'direct';
    await this.ensureCanonicalVersion(file, userId);

    if (options?.operationId) {
      const previous = await this.db('file_versions')
        .where({ workspaceId: file.workspaceId, operationId: options.operationId })
        .first();
      if (previous) {
        return this.db('files').where({ id: previous.fileId }).first();
      }
    }

    const mimeType = this.resolveMimeType(file.name, file.mimeType) || 'application/octet-stream';
    const versionId = randomUUID();
    const upload = await this.uploadImmutableObject(String(file.workspaceId), versionId, payload, mimeType);
    let staleOverwrite = false;
    let updated: any;
    try {
      await this.db.transaction(async (tx) => {
        const lockedFile = await tx('files')
          .where({ id: fileId })
          .whereNull('deletedAt')
          .forUpdate()
          .first();
        if (!lockedFile) throw new NotFoundError('File not found');
        const currentVersion = this.assertVersion(
          lockedFile.version,
          options?.strictVersion ? expectedVersion : freeflow ? undefined : expectedVersion,
        );
        staleOverwrite = typeof expectedVersion === 'number'
          && expectedVersion > 0
          && expectedVersion !== currentVersion;
        const nextVersion = currentVersion + 1;
        await tx('file_versions').insert(this.buildVersionRecord({
          id: versionId,
          file: lockedFile,
          version: nextVersion,
          name: String(lockedFile.name),
          mimeType,
          objectKey: upload.objectKey,
          providerVersion: upload.metadata.providerVersion,
          sha256: upload.sha256,
          sizeBytes: payload.length,
          changeKind: options?.changeKind || 'content',
          baseVersion: currentVersion,
          createdBy: userId,
          sourceRunId: options?.sourceRunId,
          operationId: options?.operationId,
        }));
        [updated] = await tx('files')
          .where({ id: fileId })
          .update({
            storageType: 's3',
            path: upload.objectKey,
            currentVersionId: versionId,
            publicUrl: null,
            updatedBy: userId,
            updatedAt: tx.fn.now(),
            version: nextVersion,
          })
          .returning('*');
        await tx('workspaces').where({ id: lockedFile.workspaceId }).update({
          contentRevision: tx.raw('COALESCE("contentRevision", 0) + 1'),
          updatedAt: tx.fn.now(),
          lastModifiedBy: userId,
        });
      });
    } catch (error) {
      await this.objectStore.delete(upload.objectKey, { ignoreMissing: true }).catch(() => undefined);
      if (options?.operationId) {
        const previous = await this.db('file_versions')
          .where({ workspaceId: file.workspaceId, operationId: options.operationId })
          .first();
        if (previous) return this.db('files').where({ id: previous.fileId }).first();
      }
      throw error;
    }

    await this.writeLocalMirror(String(file.workspaceId), String(updated.name), payload).catch((error) => {
      console.error('Failed to refresh local file cache after restore:', error);
    });
    return { ...updated, staleOverwrite };
  }

  async updateFile(
    fileId: number,
    content: string,
    userId: string,
    expectedVersion?: number,
    options?: { allowSystemAdmin?: boolean },
  ) {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) {
      throw new NotFoundError('File not found');
    }

    const mimeType = this.resolveMimeType(file.name, file.mimeType) || 'application/octet-stream';
    const payload = this.isTextFile(file.name, mimeType)
      ? Buffer.from(content, 'utf-8')
      : Buffer.from(content, 'base64');
    return this.commitFileBuffer(fileId, payload, userId, expectedVersion, options);
  }

  async getWorkspaceFilePreview(workspaceId: string, relativePath: string, userId: string) {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    if (!relativePath || typeof relativePath !== 'string') {
      throw new NotFoundError('File path is required');
    }

    const normalized = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const workspaceRoot = path.resolve(WORKSPACE_DIR, workspaceId);
    const absolutePath = path.resolve(workspaceRoot, normalized);
    if (!absolutePath.startsWith(workspaceRoot)) {
      throw new NotFoundError('Invalid file path');
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(absolutePath);
    } catch (error) {
      throw new NotFoundError('File not found');
    }

    const mimeType = this.resolveMimeType(normalized, null) || 'application/octet-stream';
    const encoding = this.isTextFile(normalized, mimeType) ? 'text' : 'base64';
    const content = encoding === 'text' ? buffer.toString('utf-8') : buffer.toString('base64');

    return {
      path: normalized,
      mimeType,
      encoding,
      content,
    };
  }

  async deleteFile(fileId: number, userId: string, options?: { allowSystemAdmin?: boolean }) {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) {
      return;
    }

    await this.workspaceService.ensureMembership(file.workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options?.allowSystemAdmin,
    });

    const current = await this.ensureCanonicalVersion(file, userId);
    const versionId = randomUUID();
    await this.db.transaction(async (tx) => {
      const locked = await tx('files').where({ id: fileId }).whereNull('deletedAt').forUpdate().first();
      if (!locked) return;
      const currentVersion = this.assertVersion(locked.version);
      const nextVersion = currentVersion + 1;
      await tx('file_versions').insert(this.buildVersionRecord({
        id: versionId,
        file: locked,
        version: nextVersion,
        name: String(locked.name),
        mimeType: current.mimeType || locked.mimeType || null,
        objectKey: String(current.objectKey),
        providerVersion: current.providerVersion || null,
        sha256: current.sha256 || null,
        sizeBytes: Number(current.sizeBytes || 0),
        changeKind: 'delete',
        baseVersion: currentVersion,
        createdBy: userId,
      }));
      await tx('files').where({ id: fileId }).update({
        currentVersionId: versionId,
        version: nextVersion,
        deletedAt: tx.fn.now(),
        updatedBy: userId,
        updatedAt: tx.fn.now(),
      });
      await tx('workspaces').where({ id: locked.workspaceId }).update({
        contentRevision: tx.raw('COALESCE("contentRevision", 0) + 1'),
        updatedAt: tx.fn.now(),
        lastModifiedBy: userId,
      });
    });
    const localPath = this.getLocalPath(file.workspaceId, file.name);
    await fs.unlink(localPath).catch((error: any) => {
      if (error?.code !== 'ENOENT') console.error(`Failed to evict local file cache: ${localPath}`, error);
    });

  }

  async deleteFolder(workspaceId: string, folderPath: string, userId: string) {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });

    const normalizedFolder = this.normalizeRelativeFolderPath(folderPath);
    if (!normalizedFolder) {
      throw new ConflictError('Folder path is required');
    }

    const workspaceRoot = path.resolve(WORKSPACE_DIR, workspaceId);
    const absoluteFolderPath = path.resolve(workspaceRoot, normalizedFolder);
    if (!absoluteFolderPath.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new ConflictError('Invalid folder path');
    }

    const prefix = `${normalizedFolder}/`;
    const filesInFolder = await this.db('files')
      .where({ workspaceId })
      .whereNull('deletedAt')
      .andWhere((query) => {
        query.where('name', normalizedFolder).orWhere('name', 'like', `${prefix}%`);
      });

    for (const file of filesInFolder) {
      await this.deleteFile(Number(file.id), userId);
    }

    try {
      await fs.rm(absoluteFolderPath, { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to delete folder from filesystem: ${absoluteFolderPath}`, error);
    }

  }

  async renameFolder(workspaceId: string, folderPath: string, nextFolderName: string, userId: string) {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });

    const normalizedFolder = this.normalizeRelativeFolderPath(folderPath);
    if (!normalizedFolder) {
      throw new ConflictError('Folder path is required');
    }
    if (this.isInternalWorkspacePath(normalizedFolder)) {
      throw new ConflictError('System workspace paths are reserved');
    }

    const normalizedName = this.normalizeRelativeFolderPath(nextFolderName);
    const nameParts = normalizedName.split('/').filter(Boolean);
    if (nameParts.length !== 1) {
      throw new ConflictError('Folder name cannot contain path separators');
    }

    const parentPath = path.posix.dirname(normalizedFolder);
    const destinationFolder = parentPath === '.'
      ? normalizedName
      : path.posix.join(parentPath, normalizedName);
    return this.relocateFolder(workspaceId, normalizedFolder, destinationFolder, userId);
  }

  async moveFolder(workspaceId: string, folderPath: string, destinationFolderPath: string, userId: string) {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });

    const normalizedFolder = this.normalizeRelativeFolderPath(folderPath);
    if (!normalizedFolder) {
      throw new ConflictError('Folder path is required');
    }
    if (this.isInternalWorkspacePath(normalizedFolder)) {
      throw new ConflictError('System workspace paths are reserved');
    }

    const destinationParent = this.normalizeRelativeFolderPath(destinationFolderPath);
    const destinationFolder = destinationParent
      ? path.posix.join(destinationParent, path.posix.basename(normalizedFolder))
      : path.posix.basename(normalizedFolder);
    return this.relocateFolder(workspaceId, normalizedFolder, destinationFolder, userId);
  }

  private async relocateFolder(workspaceId: string, normalizedFolder: string, destinationFolder: string, userId: string) {
    if (destinationFolder === normalizedFolder) {
      return { path: destinationFolder, files: [] };
    }
    if (this.isInternalWorkspacePath(destinationFolder)) {
      throw new ConflictError('System workspace paths are reserved');
    }
    if (destinationFolder.startsWith(`${normalizedFolder}/`)) {
      throw new ConflictError('A folder cannot be moved into itself');
    }

    const workspaceRoot = path.resolve(WORKSPACE_DIR, workspaceId);
    const absoluteFolderPath = path.resolve(workspaceRoot, normalizedFolder);
    const absoluteDestinationPath = path.resolve(workspaceRoot, destinationFolder);
    if (
      !absoluteFolderPath.startsWith(`${workspaceRoot}${path.sep}`)
      || !absoluteDestinationPath.startsWith(`${workspaceRoot}${path.sep}`)
    ) {
      throw new ConflictError('Invalid folder path');
    }

    const sourcePrefix = `${normalizedFolder}/`;
    const destinationPrefix = `${destinationFolder}/`;
    const existingDestinationFiles = await this.db('files')
      .where({ workspaceId })
      .whereNull('deletedAt')
      .andWhere((query) => {
        query.where('name', destinationFolder).orWhere('name', 'like', `${destinationPrefix}%`);
      });
    if (existingDestinationFiles.length) {
      throw new ConflictError('A folder or file already exists at the destination');
    }

    try {
      await fs.access(absoluteDestinationPath);
      throw new ConflictError('A folder already exists at the destination');
    } catch (error: any) {
      if (error instanceof ConflictError) {
        throw error;
      }
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    const filesInFolder = await this.db('files')
      .where({ workspaceId })
      .whereNull('deletedAt')
      .andWhere((query) => {
        query.where('name', normalizedFolder).orWhere('name', 'like', `${sourcePrefix}%`);
      });

    let renamedLocalDirectory = false;
    try {
      await fs.mkdir(path.dirname(absoluteDestinationPath), { recursive: true });
      await fs.rename(absoluteFolderPath, absoluteDestinationPath);
      renamedLocalDirectory = true;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        console.error('Failed to rename folder on disk:', error);
        throw error;
      }
      if (!filesInFolder.length) {
        throw new NotFoundError('Folder not found');
      }
    }

    const renamedIds: number[] = [];
    for (const file of filesInFolder) {
      const currentRelativePath = this.normalizeRelativePath(file.name);
      const destinationRelativePath = currentRelativePath === normalizedFolder
        ? destinationFolder
        : `${destinationPrefix}${currentRelativePath.slice(sourcePrefix.length)}`;

      await this.renameFile(
        Number(file.id),
        { path: path.posix.dirname(destinationRelativePath) === '.' ? '' : path.posix.dirname(destinationRelativePath) },
        userId,
        this.assertVersion(file.version),
      );
      renamedIds.push(file.id);
    }

    const files = renamedIds.length
      ? await this.db('files').whereIn('id', renamedIds)
      : [];
    return { path: destinationFolder, files };
  }

  async renameFile(
    fileId: number,
    target: { name?: string; path?: string },
    userId: string,
    expectedVersion?: number,
  ) {
    const file = await this.db('files').where({ id: fileId }).whereNull('deletedAt').first();
    if (!file) {
      throw new NotFoundError('File not found');
    }

    await this.workspaceService.ensureMembership(file.workspaceId, userId, { requireEdit: true });
    const currentRelativePath = this.normalizeRelativePath(file.name);
    const destinationRelativePath = target.path !== undefined
      ? (() => {
          const destinationFolder = this.normalizeRelativeFolderPath(target.path || '');
          const baseName = path.posix.basename(currentRelativePath);
          return destinationFolder ? path.posix.join(destinationFolder, baseName) : baseName;
        })()
      : (() => {
          if (!target.name) {
            throw new ConflictError('Missing destination name');
          }
          const normalizedNewName = this.normalizeRelativePath(target.name);
          const currentDir = path.posix.dirname(currentRelativePath);
          return currentDir === '.'
            ? normalizedNewName
            : path.posix.join(currentDir, normalizedNewName);
        })();

    if (destinationRelativePath === currentRelativePath) {
      return file;
    }
    if (this.isInternalWorkspacePath(destinationRelativePath)) {
      throw new ConflictError('System workspace paths are reserved');
    }
    const occupied = await this.db('files')
      .where({ workspaceId: file.workspaceId, name: destinationRelativePath })
      .whereNull('deletedAt')
      .whereNot({ id: fileId })
      .first();
    if (occupied) throw new ConflictError('A file already exists at the destination');

    const current = await this.ensureCanonicalVersion(file, userId);
    const versionId = randomUUID();
    let updated: any;
    await this.db.transaction(async (tx) => {
      const locked = await tx('files').where({ id: fileId }).whereNull('deletedAt').forUpdate().first();
      if (!locked) throw new NotFoundError('File not found');
      const currentVersion = this.assertVersion(locked.version, expectedVersion);
      const nextVersion = currentVersion + 1;
      await tx('file_versions').insert(this.buildVersionRecord({
        id: versionId,
        file: locked,
        version: nextVersion,
        name: destinationRelativePath,
        mimeType: current.mimeType || locked.mimeType || null,
        objectKey: String(current.objectKey),
        providerVersion: current.providerVersion || null,
        sha256: current.sha256 || null,
        sizeBytes: Number(current.sizeBytes || 0),
        changeKind: target.path !== undefined ? 'move' : 'rename',
        baseVersion: currentVersion,
        createdBy: userId,
      }));
      [updated] = await tx('files').where({ id: fileId }).update({
        name: destinationRelativePath,
        storageType: 's3',
        path: current.objectKey,
        currentVersionId: versionId,
        publicUrl: null,
        updatedBy: userId,
        updatedAt: tx.fn.now(),
        version: nextVersion,
      }).returning('*');
      await tx('workspaces').where({ id: locked.workspaceId }).update({
        contentRevision: tx.raw('COALESCE("contentRevision", 0) + 1'),
        updatedAt: tx.fn.now(),
        lastModifiedBy: userId,
      });
    });

    const currentLocalPath = this.getLocalPath(file.workspaceId, currentRelativePath);
    const newLocalPath = this.getLocalPath(file.workspaceId, destinationRelativePath);
    try {
      await fs.mkdir(path.dirname(newLocalPath), { recursive: true });
      await fs.rename(currentLocalPath, newLocalPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.error('Failed to move local file cache:', error);
    }
    return updated;
  }

  private async walkWorkspace(root: string): Promise<string[]> {
    const results: string[] = [];
    const stack: string[] = [root];

    while (stack.length) {
      const current = stack.pop()!;
      const dirEntries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of dirEntries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (entry.isFile()) {
          results.push(entryPath);
        }
      }
    }

    return results;
  }

  private async walkWorkspaceFolders(root: string): Promise<string[]> {
    const results: string[] = [];
    const stack: string[] = [root];

    while (stack.length) {
      const current = stack.pop()!;
      const dirEntries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of dirEntries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const entryPath = path.join(current, entry.name);
        const relativePath = path.relative(root, entryPath).replace(/\\/g, '/');
        if (this.isInternalWorkspacePath(relativePath)) {
          continue;
        }
        results.push(entryPath);
        stack.push(entryPath);
      }
    }

    return results;
  }

  private assertVersion(currentVersion: number | null | undefined, expectedVersion?: number): number {
    const normalizedCurrent = typeof currentVersion === 'number' && !Number.isNaN(currentVersion)
      ? currentVersion
      : 1;
    if (typeof expectedVersion === 'number' && expectedVersion > 0 && expectedVersion !== normalizedCurrent) {
      throw new ConflictError('File version mismatch', {
        expectedVersion,
        actualVersion: normalizedCurrent,
      });
    }
    return normalizedCurrent;
  }
}

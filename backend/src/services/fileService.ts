import * as fs from 'fs/promises';
import * as path from 'path';
import { S3Service } from './s3Service';
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
const INTERNAL_WORKSPACE_DIR_NAMES = new Set(['.system']);
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

export class FileService {
  private s3Service: S3Service;
  private db: Knex;
  private workspaceService: WorkspaceService;

  constructor(databaseService: DatabaseService, workspaceService: WorkspaceService) {
    this.s3Service = new S3Service();
    this.db = databaseService.getDb();
    this.workspaceService = workspaceService;
  }

  private isInternalWorkspacePath(fileName: string): boolean {
    const normalized = fileName.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    const parts = normalized.split('/').filter(Boolean);
    return parts.some((part) => INTERNAL_WORKSPACE_DIR_NAMES.has(part));
  }

  async getFiles(workspaceId: string, userId: string, options?: { includeInternal?: boolean }) {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    await this.syncWorkspaceFiles(workspaceId);
    const files = await this.db('files').where({ workspaceId });
    const visibleFiles = options?.includeInternal
      ? files
      : files.filter((file) => !this.isInternalWorkspacePath(String(file.name || '')));
    await Promise.all(visibleFiles.map((file) => this.clearLegacyPublicUrl(file)));
    return visibleFiles;
  }

  async hasFileName(workspaceId: string, fileName: string, userId: string): Promise<boolean> {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    const existing = await this.db('files').where({ workspaceId, name: fileName }).first();
    return Boolean(existing);
  }

  async resolveUniqueRelativePath(workspaceId: string, fileName: string, userId: string): Promise<string> {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const relativePath = this.normalizeRelativePath(fileName);
    if (!await this.hasFileName(workspaceId, relativePath, userId)) {
      return relativePath;
    }

    const parsed = path.posix.parse(relativePath);
    const directory = parsed.dir ? `${parsed.dir}/` : '';
    const baseName = parsed.name || 'file';
    const extension = parsed.ext || '';
    for (let index = 2; index <= 99; index += 1) {
      const candidate = `${directory}${baseName} (${index})${extension}`;
      if (!await this.hasFileName(workspaceId, candidate, userId)) {
        return candidate;
      }
    }

    let candidate = `${directory}${baseName}-${Date.now()}${extension}`;
    while (await this.hasFileName(workspaceId, candidate, userId)) {
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
    const existingFile = await this.db('files').where({ workspaceId, name: relativePath }).first();
    if (existingFile) {
      throw new ConflictError(`File "${relativePath}" already exists`);
    }
    const localPath = this.getLocalPath(workspaceId, relativePath);
    const isText = this.isTextFile(relativePath, mimeType);
    let storageType: 'local' | 's3';
    let filePath: string;

    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, fileBuffer);

    if (isText || options?.forceLocal) {
      storageType = 'local';
      filePath = localPath;
    } else {
      storageType = 's3';
      const key = normalizeS3Key(workspaceId, relativePath);
      const result = await this.s3Service.uploadFile(
        workspaceId,
        relativePath,
        fileBuffer,
        mimeType,
        key,
      );
      filePath = result.Key || key;
      // Objects remain private in storage and are read through authenticated
      // workspace APIs. Do not issue persistent object URLs.
    }

    const [newFile] = await this.db('files').insert({
      name: relativePath,
      workspaceId,
      storageType,
      path: filePath,
      mimeType,
      publicUrl: null,
      sourceProvider: options?.sourceProvider || null,
      sourceExternalId: options?.sourceExternalId || null,
      sourceVersionFingerprint: options?.sourceVersionFingerprint || null,
      sourceUrl: options?.sourceUrl || null,
      createdBy: userId,
      updatedBy: userId,
    }).returning('*');

    await this.workspaceService.touchWorkspace(workspaceId, userId, { contentChanged: true });

    return newFile;
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
    const existing = await this.db('files').where({ workspaceId, name: relativePath }).first();
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
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) {
      throw new NotFoundError('File not found');
    }

    await this.workspaceService.ensureMembership(file.workspaceId, userId);
    await this.clearLegacyPublicUrl(file);

    const buffer = file.storageType === 'local'
      ? await fs.readFile(file.path)
      : await this.s3Service.getFile(file.path);
    const mimeType = this.resolveMimeType(file.name, file.mimeType) || 'application/octet-stream';

    if (this.isTextFile(file.name, mimeType)) {
      const content = buffer.toString('utf-8');
      return { ...file, content };
    } else {
      const content = buffer.toString('base64');
      return { ...file, content };
    }
  }

  async getFileRecord(fileId: number, userId: string, options?: { requireEdit?: boolean; allowSystemAdmin?: boolean }) {
    const file = await this.db('files').where({ id: fileId }).first();
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
    return this.s3Service.getFile(file.path);
  }

  async updateFile(
    fileId: number,
    content: string,
    userId: string,
    expectedVersion?: number,
    options?: { allowSystemAdmin?: boolean },
  ) {
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) {
      throw new NotFoundError('File not found');
    }

    const { workspace } = await this.workspaceService.ensureMembership(file.workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options?.allowSystemAdmin,
    });
    if (file.storageType !== 'local') {
      throw new ConflictError('Updating S3 files is not supported.');
    }

    const freeflow = workspace.visibility === 'team' && workspace.editingPolicy === 'direct';
    let staleOverwrite = false;
    let updated: any;
    await this.db.transaction(async (tx) => {
      const lockedFile = await tx('files').where({ id: fileId }).forUpdate().first();
      if (!lockedFile) {
        throw new NotFoundError('File not found');
      }
      const currentVersion = this.assertVersion(
        lockedFile.version,
        freeflow ? undefined : expectedVersion,
      );
      staleOverwrite = typeof expectedVersion === 'number'
        && expectedVersion > 0
        && expectedVersion !== currentVersion;
      const nextVersion = currentVersion + 1;
      const mimeType = this.resolveMimeType(lockedFile.name, lockedFile.mimeType) || 'application/octet-stream';
      const previousContent = await this.readFileBuffer(lockedFile);
      const payload = this.isTextFile(lockedFile.name, mimeType)
        ? Buffer.from(content, 'utf-8')
        : Buffer.from(content, 'base64');

      await tx('workspace_file_revisions').insert({
        fileId: lockedFile.id,
        workspaceId: lockedFile.workspaceId,
        name: lockedFile.name,
        version: currentVersion,
        storageType: lockedFile.storageType,
        mimeType,
        content: previousContent,
        replacedByUserId: userId,
        staleOverwrite,
      });
      await fs.writeFile(lockedFile.path, payload);
      [updated] = await tx('files')
        .where({ id: fileId })
        .update({
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

    return { ...updated, staleOverwrite };
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
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) {
      return;
    }

    await this.workspaceService.ensureMembership(file.workspaceId, userId, {
      requireEdit: true,
      allowSystemAdmin: options?.allowSystemAdmin,
    });

    const localPath = this.getLocalPath(file.workspaceId, file.name);
    if (file.storageType === 'local') {
      try {
        await fs.unlink(file.path);
      } catch (error) {
        console.error(`Failed to delete file from filesystem: ${file.path}`, error);
      }
    } else {
      try {
        await this.s3Service.deleteFile(file.path);
      } catch (error) {
        console.error(`Failed to delete S3 file: ${file.path}`, error);
      }
      try {
        await fs.unlink(localPath);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          console.error(`Failed to delete local copy of S3 file: ${localPath}`, error);
        }
      }
    }

    await this.db('files').where({ id: fileId }).del();
    await this.workspaceService.touchWorkspace(file.workspaceId, userId, { contentChanged: true });

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
      .andWhere((query) => {
        query.where('name', normalizedFolder).orWhere('name', 'like', `${prefix}%`);
      });

    for (const file of filesInFolder) {
      const localPath = this.getLocalPath(workspaceId, file.name);
      if (file.storageType === 'local') {
        try {
          await fs.unlink(file.path);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') {
            console.error(`Failed to delete file from filesystem: ${file.path}`, error);
          }
        }
      } else {
        try {
          await this.s3Service.deleteFile(file.path);
        } catch (error) {
          console.error(`Failed to delete S3 file: ${file.path}`, error);
        }
        try {
          await fs.unlink(localPath);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') {
            console.error(`Failed to delete local copy of S3 file: ${localPath}`, error);
          }
        }
      }
    }

    if (filesInFolder.length) {
      await this.db('files').whereIn('id', filesInFolder.map((file) => file.id)).del();
    }

    try {
      await fs.rm(absoluteFolderPath, { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to delete folder from filesystem: ${absoluteFolderPath}`, error);
    }

    await this.workspaceService.touchWorkspace(workspaceId, userId, { contentChanged: true });

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

      if (file.storageType === 'local') {
        const newPath = this.getLocalPath(workspaceId, destinationRelativePath);
        if (!renamedLocalDirectory) {
          await fs.mkdir(path.dirname(newPath), { recursive: true });
          await fs.rename(this.getLocalPath(workspaceId, currentRelativePath), newPath);
        }
        await this.db('files').where({ id: file.id }).update({
          name: destinationRelativePath,
          path: newPath,
          updatedBy: userId,
          updatedAt: this.db.fn.now(),
          version: this.assertVersion(file.version) + 1,
        });
      } else {
        const currentKey = file.path.replace(/\\/g, '/');
        const newKey = normalizeS3Key(workspaceId, destinationRelativePath);
        const newLocalPath = this.getLocalPath(workspaceId, destinationRelativePath);
        await this.s3Service.copyFile(currentKey, newKey);
        await this.s3Service.deleteFile(currentKey);
        if (!renamedLocalDirectory) {
          try {
            await fs.mkdir(path.dirname(newLocalPath), { recursive: true });
            await fs.rename(this.getLocalPath(workspaceId, currentRelativePath), newLocalPath);
          } catch (error: any) {
            if (error?.code !== 'ENOENT') {
              console.error('Failed to rename local copy of S3 file:', error);
            }
          }
        }
        await this.db('files').where({ id: file.id }).update({
          name: destinationRelativePath,
          path: newKey,
          publicUrl: null,
          updatedBy: userId,
          updatedAt: this.db.fn.now(),
          version: this.assertVersion(file.version) + 1,
        });
      }

      renamedIds.push(file.id);
    }

    await this.workspaceService.touchWorkspace(workspaceId, userId, { contentChanged: true });

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
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) {
      throw new NotFoundError('File not found');
    }

    await this.workspaceService.ensureMembership(file.workspaceId, userId, { requireEdit: true });
    const currentVersion = this.assertVersion(file.version, expectedVersion);
    const nextVersion = currentVersion + 1;
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

    if (file.storageType === 'local') {
      const currentLocalPath = this.getLocalPath(file.workspaceId, currentRelativePath);
      const newPath = this.getLocalPath(file.workspaceId, destinationRelativePath);

      try {
        await fs.mkdir(path.dirname(newPath), { recursive: true });
        await fs.rename(currentLocalPath, newPath);
      } catch (error) {
        console.error('Failed to rename file on disk:', error);
        throw error;
      }

      await this.db('files').where({ id: fileId }).update({
        name: destinationRelativePath,
        path: newPath,
        updatedBy: userId,
        updatedAt: this.db.fn.now(),
        version: nextVersion,
      });
    } else {
      const currentKey = file.path.replace(/\\/g, '/');
      const currentLocalPath = this.getLocalPath(file.workspaceId, currentRelativePath);
      const newLocalPath = this.getLocalPath(file.workspaceId, destinationRelativePath);
      const newKey = normalizeS3Key(file.workspaceId, destinationRelativePath);
      await this.s3Service.copyFile(currentKey, newKey);
      await this.s3Service.deleteFile(currentKey);
      try {
        await fs.mkdir(path.dirname(newLocalPath), { recursive: true });
        await fs.rename(currentLocalPath, newLocalPath);
      } catch (error) {
        console.error('Failed to rename local copy of S3 file:', error);
      }

      await this.db('files').where({ id: fileId }).update({
        name: destinationRelativePath,
        path: newKey,
        publicUrl: null,
        updatedBy: userId,
        updatedAt: this.db.fn.now(),
        version: nextVersion,
      });
    }

    await this.workspaceService.touchWorkspace(file.workspaceId, userId, { contentChanged: true });

    return this.db('files').where({ id: fileId }).first();
  }

  private async syncWorkspaceFiles(workspaceId: string) {
    const workspacePath = path.join(WORKSPACE_DIR, workspaceId);
    try {
      await fs.access(workspacePath);
    } catch {
      return;
    }

    const existing = await this.db('files').where({ workspaceId });
    const diskFiles = await this.walkWorkspace(workspacePath);
    const normalizedDiskFiles = new Set(diskFiles.map((filePath) => path.normalize(filePath)));
    const staleLocalFileIds: number[] = [];
    const localPathRepairs: Array<{ id: number; path: string }> = [];
    const mimeTypeRepairs: Array<{ id: number; mimeType: string }> = [];

    for (const file of existing) {
      if (file.storageType !== 'local') {
        continue;
      }

      let expectedLocalPath: string | null = null;
      try {
        expectedLocalPath = path.normalize(this.getLocalPath(workspaceId, file.name));
      } catch (error) {
        console.error('Failed to resolve expected local path during workspace sync:', error);
      }

      const currentPath = path.normalize(file.path);
      const diskHasCurrentPath = normalizedDiskFiles.has(currentPath);
      const diskHasExpectedPath = expectedLocalPath ? normalizedDiskFiles.has(expectedLocalPath) : false;

      if (!diskHasCurrentPath && !diskHasExpectedPath) {
        staleLocalFileIds.push(file.id);
        continue;
      }

      if (expectedLocalPath && currentPath !== expectedLocalPath && diskHasExpectedPath) {
        localPathRepairs.push({ id: file.id, path: expectedLocalPath });
      }

      const resolvedMimeType = this.resolveMimeType(file.name, file.mimeType);
      if (!file.mimeType && resolvedMimeType) {
        mimeTypeRepairs.push({ id: file.id, mimeType: resolvedMimeType });
      }
    }

    if (staleLocalFileIds.length) {
      await this.db('files').whereIn('id', staleLocalFileIds).del();
    }

    if (localPathRepairs.length) {
      await Promise.all(
        localPathRepairs.map(({ id, path: nextPath }) =>
          this.db('files').where({ id }).update({ path: nextPath }),
        ),
      );
    }

    if (mimeTypeRepairs.length) {
      await Promise.all(
        mimeTypeRepairs.map(({ id, mimeType }) =>
          this.db('files').where({ id }).update({ mimeType }),
        ),
      );
    }

    const remainingExisting = staleLocalFileIds.length
      ? existing.filter((file) => !staleLocalFileIds.includes(file.id))
      : existing;
    const existingPaths = new Set<string>();
    for (const file of remainingExisting) {
      existingPaths.add(path.normalize(file.path));
      if (file.storageType === 's3') {
        try {
          existingPaths.add(path.normalize(this.getLocalPath(workspaceId, file.name)));
        } catch (error) {
          console.error('Failed to resolve local path for file during sync:', error);
        }
      }
    }

    const missingFiles = diskFiles.filter((filePath) => {
      if (existingPaths.has(path.normalize(filePath))) {
        return false;
      }
      const relativePath = path.relative(workspacePath, filePath).replace(/\\/g, '/');
      return !this.isInternalWorkspacePath(relativePath);
    });

    if (!missingFiles.length) {
      return;
    }

    const newRecords = missingFiles.map((filePath) => ({
      name: path.relative(workspacePath, filePath),
      workspaceId,
      storageType: 'local' as const,
      path: filePath,
      mimeType: this.resolveMimeType(filePath, null),
    }));

    await this.db('files').insert(newRecords);
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

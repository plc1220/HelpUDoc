import * as fs from 'fs/promises';
import * as path from 'path';
import { S3Service } from './s3Service';
import { DatabaseService } from './databaseService';
import { Knex } from 'knex';
import { WorkspaceService } from './workspaceService';
import { ConflictError, NotFoundError } from '../errors';

const WORKSPACE_DIR = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.join(process.cwd(), 'workspaces');
const TEXT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'application/json',
  'text/html',
  'text/css',
  'application/javascript',
];

const TEXT_FILE_EXTENSIONS = ['.md', '.mermaid', '.txt', '.json', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.svg', '.csv'];
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

  async getFiles(workspaceId: string, userId: string) {
    await this.workspaceService.ensureMembership(workspaceId, userId);
    await this.syncWorkspaceFiles(workspaceId);
    const files = await this.db('files').where({ workspaceId });
    await Promise.all(files.map((file) => this.ensurePublicUrl(file)));
    return files;
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
    return BINARY_MIME_TYPES_BY_EXTENSION[ext] || null;
  }

  private async ensurePublicUrl(file: any): Promise<void> {
    if (file.publicUrl || file.storageType !== 'local') {
      if (!file.mimeType) {
        const resolved = this.resolveMimeType(file.name, file.mimeType);
        if (resolved) {
          file.mimeType = resolved;
          await this.db('files').where({ id: file.id }).update({ mimeType: resolved });
        }
      }
      return;
    }

    const mimeType = this.resolveMimeType(file.name, file.mimeType);
    if (this.isTextFile(file.name, mimeType || '')) {
      if (!file.mimeType && mimeType) {
        file.mimeType = mimeType;
        await this.db('files').where({ id: file.id }).update({ mimeType });
      }
      return;
    }

    try {
      const buffer = await fs.readFile(file.path);
      const s3Key = normalizeS3Key(file.workspaceId, file.name);
      const result = await this.s3Service.uploadFile(
        file.workspaceId,
        file.name,
        buffer,
        mimeType || undefined,
        s3Key,
      );
      file.publicUrl = result.publicUrl;
      if (!file.mimeType && mimeType) {
        file.mimeType = mimeType;
      }
      await this.db('files').where({ id: file.id }).update({
        publicUrl: file.publicUrl,
        mimeType: file.mimeType,
      });
    } catch (error) {
      console.error('Failed to upload workspace file to object storage', error);
    }
  }

  async createFile(
    workspaceId: string,
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string,
    userId: string,
    options?: { forceLocal?: boolean },
  ) {
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });
    const isText = this.isTextFile(fileName, mimeType);
    let storageType: 'local' | 's3';
    let filePath: string;
    let publicUrl: string | null = null;

    if (isText || options?.forceLocal) {
      storageType = 'local';
      filePath = path.join(WORKSPACE_DIR, workspaceId, fileName);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, fileBuffer);
    } else {
      storageType = 's3';
      const key = normalizeS3Key(workspaceId, fileName);
      const result = await this.s3Service.uploadFile(
        workspaceId,
        fileName,
        fileBuffer,
        mimeType,
        key,
      );
      filePath = result.Key || key;
      publicUrl = result.publicUrl;
    }

    const [newFile] = await this.db('files').insert({
      name: fileName,
      workspaceId,
      storageType,
      path: filePath,
      mimeType,
      publicUrl,
      createdBy: userId,
      updatedBy: userId,
    }).returning('*');

    await this.workspaceService.touchWorkspace(workspaceId, userId);

    return newFile;
  }

  async getFileContent(fileId: number, userId: string) {
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) {
      throw new NotFoundError('File not found');
    }

    await this.workspaceService.ensureMembership(file.workspaceId, userId);
    await this.ensurePublicUrl(file);

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

  async updateFile(fileId: number, content: string, userId: string, expectedVersion?: number) {
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) {
      throw new NotFoundError('File not found');
    }

    await this.workspaceService.ensureMembership(file.workspaceId, userId, { requireEdit: true });
    const currentVersion = this.assertVersion(file.version, expectedVersion);
    const nextVersion = currentVersion + 1;

    if (file.storageType === 'local') {
      await fs.writeFile(file.path, content);
    } else {
      throw new ConflictError('Updating S3 files is not supported.');
    }

    const [updated] = await this.db('files')
      .where({ id: fileId })
      .update({
        updatedBy: userId,
        updatedAt: this.db.fn.now(),
        version: nextVersion,
      })
      .returning('*');

    await this.workspaceService.touchWorkspace(file.workspaceId, userId);

    return updated;
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

  async deleteFile(fileId: number, userId: string) {
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) {
      return;
    }

    await this.workspaceService.ensureMembership(file.workspaceId, userId, { requireEdit: true });

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
    }

    await this.db('files').where({ id: fileId }).del();
    await this.workspaceService.touchWorkspace(file.workspaceId, userId);
  }

  async renameFile(fileId: number, newName: string, userId: string, expectedVersion?: number) {
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) {
      throw new NotFoundError('File not found');
    }

    await this.workspaceService.ensureMembership(file.workspaceId, userId, { requireEdit: true });
    const currentVersion = this.assertVersion(file.version, expectedVersion);
    const nextVersion = currentVersion + 1;

    if (file.storageType === 'local') {
      const targetDir = path.dirname(file.path);
      const newPath = path.join(targetDir, newName);

      try {
        await fs.rename(file.path, newPath);
      } catch (error) {
        console.error('Failed to rename file on disk:', error);
        throw error;
      }

      await this.db('files').where({ id: fileId }).update({
        name: newName,
        path: newPath,
        updatedBy: userId,
        updatedAt: this.db.fn.now(),
        version: nextVersion,
      });
    } else {
      const currentKey = file.path.replace(/\\/g, '/');
      const currentDir = path.posix.dirname(currentKey);
      const newKey = currentDir === '.'
        ? newName
        : `${currentDir}/${newName}`;
      await this.s3Service.copyFile(currentKey, newKey);
      await this.s3Service.deleteFile(currentKey);
      const publicUrl = this.s3Service.getPublicUrl(newKey);

      await this.db('files').where({ id: fileId }).update({
        name: newName,
        path: newKey,
        publicUrl,
        updatedBy: userId,
        updatedAt: this.db.fn.now(),
        version: nextVersion,
      });
    }

    await this.workspaceService.touchWorkspace(file.workspaceId, userId);

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
    const existingPaths = new Set(
      existing.map((file) => path.normalize(file.path))
    );

    const diskFiles = await this.walkWorkspace(workspacePath);
    const missingFiles = diskFiles.filter(
      (filePath) => !existingPaths.has(path.normalize(filePath))
    );

    if (!missingFiles.length) {
      return;
    }

    const newRecords = missingFiles.map((filePath) => ({
      name: path.relative(workspacePath, filePath),
      workspaceId,
      storageType: 'local' as const,
      path: filePath,
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

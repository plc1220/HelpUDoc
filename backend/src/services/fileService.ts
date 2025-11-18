import * as fs from 'fs/promises';
import * as path from 'path';
import { S3Service } from './s3Service';
import { DatabaseService } from './databaseService';
import { Knex } from 'knex';

const WORKSPACE_DIR = path.join(process.cwd(), 'workspaces');
const TEXT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'application/json',
  'text/html',
  'text/css',
  'application/javascript',
];

const TEXT_FILE_EXTENSIONS = ['.md', '.mermaid', '.txt', '.json', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.svg'];

export class FileService {
  private s3Service: S3Service;
  private db: Knex;

  constructor(databaseService: DatabaseService) {
    this.s3Service = new S3Service();
    this.db = databaseService.getDb();
  }

  async getFiles(workspaceId: string) {
    await this.syncWorkspaceFiles(workspaceId);
    return this.db('files').where({ workspaceId });
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

  async createFile(workspaceId: string, fileName: string, fileBuffer: Buffer, mimeType: string) {
    let storageType: 'local' | 's3';
    let filePath: string;

    storageType = 'local';
    filePath = path.join(WORKSPACE_DIR, workspaceId, fileName);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, fileBuffer);

    const [newFile] = await this.db('files').insert({
      name: fileName,
      workspaceId,
      storageType,
      path: filePath,
    }).returning('*');

    return newFile;
  }

  async getFileContent(fileId: number) {
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) {
      throw new Error('File not found');
    }

    const buffer = await fs.readFile(file.path);
    const mimeType = file.mimeType || 'application/octet-stream';

    if (this.isTextFile(file.name, mimeType)) {
      const content = buffer.toString('utf-8');
      return { ...file, content };
    } else {
      const content = buffer.toString('base64');
      return { ...file, content };
    }
  }

  async updateFile(fileId: number, content: string) {
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) {
      throw new Error('File not found');
    }

    if (file.storageType === 'local') {
      await fs.writeFile(file.path, content);
    } else {
      // For S3, we'd need to re-upload the file.
      // This is a simplified example.
      console.warn('Updating S3 files is not fully implemented.');
    }

    return this.db('files').where({ id: fileId }).first();
  }

  async deleteFile(fileId: number) {
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) {
      return;
    }

    if (file.storageType === 'local') {
      try {
        await fs.unlink(file.path);
      } catch (error) {
        console.error(`Failed to delete file from filesystem: ${file.path}`, error);
      }
    } else {
      // TODO: Implement S3 file deletion
    }

    await this.db('files').where({ id: fileId }).del();
  }

  async renameFile(fileId: number, newName: string) {
    const file = await this.db('files').where({ id: fileId }).first();
    if (!file) {
      throw new Error('File not found');
    }

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
    });

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
}

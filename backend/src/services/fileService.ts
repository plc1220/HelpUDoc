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

    if (this.isTextFile(fileName, mimeType)) {
      storageType = 'local';
      filePath = path.join(WORKSPACE_DIR, workspaceId, fileName);
      await fs.writeFile(filePath, fileBuffer);
    } else {
      storageType = 's3';
      const result = await this.s3Service.uploadFile(workspaceId, fileName, fileBuffer);
      filePath = result.Key;
    }

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

    if (file.storageType === 'local') {
      const buffer = await fs.readFile(file.path);
      const mimeType = file.mimeType || 'application/octet-stream';
      
      if (this.isTextFile(file.name, mimeType)) {
        return { ...file, content: buffer.toString('utf-8') };
      } else {
        return { ...file, content: buffer.toString('base64') };
      }
    } else {
      // TODO: Implement S3 file content retrieval
      console.warn('Retrieving S3 file content is not fully implemented.');
      return file;
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

    return this.db('files').where({ id: fileId }).update({ content }).returning('*');
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
}
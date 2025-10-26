import * as fs from 'fs/promises';
import * as path from 'path';
import { DatabaseService } from './databaseService';

const WORKSPACE_DIR = path.join(process.cwd(), 'workspaces');
export class WorkspaceService {
  private dbService: DatabaseService;

  constructor(dbService: DatabaseService) {
    this.dbService = dbService;
    this.ensureWorkspaceDir();
  }

  private async ensureWorkspaceDir() {
    try {
      await fs.mkdir(WORKSPACE_DIR, { recursive: true });
    } catch (error) {
      console.error('Error creating workspace directory:', error);
    }
  }

  async getWorkspaces() {
    const entries = await fs.readdir(WORKSPACE_DIR, { withFileTypes: true });
    const workspaces = entries
      .filter(entry => entry.isDirectory())
      .map(entry => ({
        id: entry.name,
        name: entry.name, // For now, use the directory name as the workspace name
        files: [], // TODO: Implement file listing
      }));
    return workspaces;
  }

  async createWorkspace(name: string) {
    const workspacePath = path.join(WORKSPACE_DIR, name);
    await fs.mkdir(workspacePath, { recursive: true });
    console.log(`Created workspace directory: ${workspacePath}`);
    return { id: name, name, files: [] };
  }

  async getWorkspace(id: string) {
    // TODO: Implement actual get workspace logic
    return { id, name: 'Test Workspace', files: [] };
  }

  async deleteWorkspace(id: string) {
    // First, delete from the database
    await this.dbService.deleteWorkspace(id);

    // Then, delete the directory from the file system
    const workspacePath = path.join(WORKSPACE_DIR, id);
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}
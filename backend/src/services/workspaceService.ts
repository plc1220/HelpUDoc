import * as fs from 'fs/promises';
import * as path from 'path';
import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';
import { UserContext } from '../types/user';
import { AccessDeniedError, NotFoundError } from '../errors';

const WORKSPACE_DIR = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.join(process.cwd(), 'workspaces');

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  lastModifiedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembershipRecord {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MembershipCheckOptions {
  requireEdit?: boolean;
}

export class WorkspaceService {
  private db: Knex;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
    this.ensureWorkspaceDir();
  }

  private async ensureWorkspaceDir(): Promise<void> {
    try {
      await fs.mkdir(WORKSPACE_DIR, { recursive: true });
    } catch (error) {
      console.error('Error creating workspace directory:', error);
    }
  }

  async listWorkspacesForUser(userId: string): Promise<Array<WorkspaceRecord & { role: WorkspaceRole; canEdit: boolean }>> {
    const rows = await this.db('workspace_members')
      .join('workspaces', 'workspace_members.workspaceId', 'workspaces.id')
      .select(
        'workspaces.*',
        'workspace_members.role',
        'workspace_members.canEdit',
      )
      .where('workspace_members.userId', userId)
      .orderBy('workspaces.updatedAt', 'desc');

    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      ownerId: row.ownerId,
      lastModifiedBy: row.lastModifiedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      role: row.role as WorkspaceRole,
      canEdit: Boolean(row.canEdit),
    }));
  }

  async createWorkspace(user: UserContext, name: string): Promise<WorkspaceRecord> {
    const workspaceId = uuidv4();
    const slug = await this.generateUniqueSlug(name);
    const [workspace] = await this.db<WorkspaceRecord>('workspaces')
      .insert({
        id: workspaceId,
        name,
        slug,
        ownerId: user.userId,
        lastModifiedBy: user.userId,
      })
      .returning('*');

    await this.db('workspace_members').insert({
      workspaceId,
      userId: user.userId,
      role: 'owner',
      canEdit: true,
    });

    await this.createWorkspaceDirectory(workspaceId);

    return workspace;
  }

  async getWorkspaceForUser(workspaceId: string, userId: string): Promise<{ workspace: WorkspaceRecord; membership: WorkspaceMembershipRecord }> {
    return this.ensureMembership(workspaceId, userId);
  }

  async ensureMembership(
    workspaceId: string,
    userId: string,
    options: MembershipCheckOptions = {},
  ): Promise<{ workspace: WorkspaceRecord; membership: WorkspaceMembershipRecord }> {
    const workspace = await this.db<WorkspaceRecord>('workspaces').where({ id: workspaceId }).first();
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    const membership = await this.db<WorkspaceMembershipRecord>('workspace_members')
      .where({ workspaceId, userId })
      .first();
    if (!membership) {
      throw new AccessDeniedError('Workspace access denied');
    }

    const normalizedMembership: WorkspaceMembershipRecord = {
      ...membership,
      role: membership.role as WorkspaceRole,
      canEdit: Boolean(membership.canEdit),
    };

    if (options.requireEdit && !normalizedMembership.canEdit) {
      throw new AccessDeniedError('Workspace is read-only for this user');
    }

    return { workspace, membership: normalizedMembership };
  }

  async deleteWorkspace(workspaceId: string, userId: string): Promise<void> {
    const { workspace, membership } = await this.ensureMembership(workspaceId, userId);
    if (membership.role !== 'owner') {
      throw new AccessDeniedError('Only workspace owners can delete a workspace');
    }

    await this.db('workspaces').where({ id: workspace.id }).del();

    const workspacePath = path.join(WORKSPACE_DIR, workspace.id);
    await fs.rm(workspacePath, { recursive: true, force: true });
  }

  async addCollaborator(
    workspaceId: string,
    actingUserId: string,
    targetUserId: string,
    role: WorkspaceRole,
  ): Promise<void> {
    const { membership } = await this.ensureMembership(workspaceId, actingUserId);
    if (membership.role !== 'owner') {
      throw new AccessDeniedError('Only workspace owners can invite collaborators');
    }

    const canEdit = role !== 'viewer';
    const existing = await this.db('workspace_members').where({ workspaceId, userId: targetUserId }).first();
    if (existing) {
      await this.db('workspace_members')
        .where({ workspaceId, userId: targetUserId })
        .update({
          role,
          canEdit,
          updatedAt: this.db.fn.now(),
        });
      return;
    }

    await this.db('workspace_members').insert({
      workspaceId,
      userId: targetUserId,
      role,
      canEdit,
    });
  }

  async listCollaborators(
    workspaceId: string,
    userId: string,
  ): Promise<Array<{ userId: string; displayName: string; role: WorkspaceRole; canEdit: boolean }>> {
    await this.ensureMembership(workspaceId, userId);
    const collaborators = await this.db('workspace_members')
      .join('users', 'workspace_members.userId', 'users.id')
      .select(
        'workspace_members.userId',
        'workspace_members.role',
        'workspace_members.canEdit',
        'users.displayName',
      )
      .where('workspace_members.workspaceId', workspaceId)
      .orderBy('users.displayName', 'asc');

    return collaborators.map((row: any) => ({
      userId: row.userId,
      displayName: row.displayName,
      role: row.role as WorkspaceRole,
      canEdit: Boolean(row.canEdit),
    }));
  }

  async touchWorkspace(workspaceId: string, userId: string): Promise<void> {
    await this.db('workspaces')
      .where({ id: workspaceId })
      .update({
        updatedAt: this.db.fn.now(),
        lastModifiedBy: userId,
      });
  }

  private async createWorkspaceDirectory(workspaceId: string): Promise<void> {
    const workspacePath = path.join(WORKSPACE_DIR, workspaceId);
    await fs.mkdir(workspacePath, { recursive: true });
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-') || 'workspace';
  }

  private async generateUniqueSlug(name: string): Promise<string> {
    const base = this.slugify(name);
    let candidate = base;
    let counter = 1;
    while (true) {
      const existing = await this.db('workspaces').where({ slug: candidate }).first();
      if (!existing) {
        return candidate;
      }
      candidate = `${base}-${counter}`;
      counter += 1;
    }
  }
}

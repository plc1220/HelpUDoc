import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';

export interface UserRecord {
  id: string;
  externalId: string;
  email?: string | null;
  displayName: string;
  isAdmin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GroupRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface UserProfileInput {
  externalId: string;
  displayName?: string | null;
  email?: string | null;
}

const normalizeEmail = (email?: string | null) => email?.trim().toLowerCase() || null;

const parseAdminEmails = () => new Set(
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
);

export class UserService {
  private db: Knex;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
  }

  async ensureUser(profile: UserProfileInput): Promise<UserRecord> {
    const normalizedExternalId = profile.externalId.trim().toLowerCase();
    const displayName = (profile.displayName || profile.externalId).trim();
    const email = normalizeEmail(profile.email);
    const adminEmails = parseAdminEmails();

    const existing = await this.db<UserRecord>('users').where({ externalId: normalizedExternalId }).first();
    if (!existing) {
      const isAdmin = !!(email && adminEmails.has(email));
      const [created] = await this.db<UserRecord>('users')
        .insert({
          id: uuidv4(),
          externalId: normalizedExternalId,
          displayName,
          email,
          isAdmin,
        })
        .returning('*');
      return created;
    }

    const updates: Partial<UserRecord> = {};
    if (displayName && displayName !== existing.displayName) {
      updates.displayName = displayName;
    }
    if (email !== existing.email) {
      updates.email = email;
    }

    if (!existing.isAdmin && email && adminEmails.has(email)) {
      updates.isAdmin = true;
    }

    if (Object.keys(updates).length) {
      const [updated] = await this.db<UserRecord>('users')
        .where({ id: existing.id })
        .update({
          ...updates,
          updatedAt: this.db.fn.now(),
        })
        .returning('*');
      return updated;
    }

    return existing;
  }

  async listUsers(): Promise<UserRecord[]> {
    return this.db<UserRecord>('users')
      .select('*')
      .orderBy('createdAt', 'asc');
  }

  async getUserById(userId: string): Promise<UserRecord | null> {
    const user = await this.db<UserRecord>('users').where({ id: userId }).first();
    return user || null;
  }
  async setUserAdmin(userId: string, isAdmin: boolean): Promise<UserRecord | null> {
    const [updated] = await this.db<UserRecord>('users')
      .where({ id: userId })
      .update({
        isAdmin,
        updatedAt: this.db.fn.now(),
      })
      .returning('*');

    return updated || null;
  }

  async listGroups(): Promise<GroupRecord[]> {
    return this.db<GroupRecord>('groups')
      .select('*')
      .orderBy('name', 'asc');
  }

  async createGroup(name: string): Promise<GroupRecord> {
    const [group] = await this.db<GroupRecord>('groups')
      .insert({
        id: uuidv4(),
        name: name.trim(),
      })
      .returning('*');
    return group;
  }

  async deleteGroup(groupId: string): Promise<number> {
    return this.db<GroupRecord>('groups').where({ id: groupId }).del();
  }

  async listGroupMembers(groupId: string): Promise<UserRecord[]> {
    return this.db<UserRecord>('users as u')
      .join('group_members as gm', 'u.id', 'gm.userId')
      .where('gm.groupId', groupId)
      .select('u.*')
      .orderBy('u.displayName', 'asc');
  }

  async addGroupMember(groupId: string, userId: string): Promise<void> {
    await this.db('group_members')
      .insert({
        groupId,
        userId,
      })
      .onConflict(['groupId', 'userId'])
      .ignore();
  }

  async removeGroupMember(groupId: string, userId: string): Promise<number> {
    return this.db('group_members').where({ groupId, userId }).del();
  }
}

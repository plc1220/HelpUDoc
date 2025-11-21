import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './databaseService';

export interface UserRecord {
  id: string;
  externalId: string;
  email?: string | null;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

interface UserProfileInput {
  externalId: string;
  displayName?: string | null;
  email?: string | null;
}

export class UserService {
  private db: Knex;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
  }

  async ensureUser(profile: UserProfileInput): Promise<UserRecord> {
    const normalizedExternalId = profile.externalId.trim().toLowerCase();
    const displayName = (profile.displayName || profile.externalId).trim();
    const email = profile.email?.trim() || null;

    const existing = await this.db<UserRecord>('users').where({ externalId: normalizedExternalId }).first();
    if (!existing) {
      const [created] = await this.db<UserRecord>('users')
        .insert({
          id: uuidv4(),
          externalId: normalizedExternalId,
          displayName,
          email,
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
}

import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import { AccessDeniedError, ConflictError, HttpError, NotFoundError } from '../errors';
import type { UserService } from './userService';

/** A bucket registration as an admin sees it, grants included. */
export type GcsBucketRecord = {
  id: string;
  bucketName: string;
  pathPrefix: string;
  displayName: string;
  description: string | null;
  defaultAccess: 'allow' | 'deny';
  isArchived: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  teamGrants: Array<{ teamId: string; teamName: string | null; effect: 'allow' | 'deny' }>;
};

export type GcsBucketInput = {
  bucketName: string;
  pathPrefix?: string;
  displayName?: string;
  description?: string | null;
  defaultAccess?: 'allow' | 'deny';
};

type BucketRow = {
  id: string;
  bucketName: string;
  pathPrefix: string | null;
  displayName: string;
  description: string | null;
  defaultAccess: string;
  isArchived: boolean;
  createdByUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/**
 * GCS bucket names are lowercase, and a trailing slash on a prefix is
 * meaningful to the object API, so both are normalised once here rather than at
 * every call site.
 */
export function normalizeBucketName(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/^gs:\/\//, '').replace(/\/.*$/, '');
}

/** Normalises to '' (whole bucket) or a single-trailing-slash prefix. */
export function normalizePathPrefix(value: string | null | undefined): string {
  const raw = String(value || '').trim().replace(/^\/+/, '');
  if (!raw) {
    return '';
  }
  return raw.endsWith('/') ? raw.replace(/\/{2,}$/, '/') : `${raw}/`;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toRecord(row: BucketRow, teamGrants: GcsBucketRecord['teamGrants']): GcsBucketRecord {
  return {
    id: row.id,
    bucketName: row.bucketName,
    pathPrefix: row.pathPrefix || '',
    displayName: row.displayName,
    description: row.description || null,
    defaultAccess: row.defaultAccess === 'allow' ? 'allow' : 'deny',
    isArchived: Boolean(row.isArchived),
    createdByUserId: row.createdByUserId || null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    teamGrants,
  };
}

export class GcsBucketRegistryService {
  constructor(
    private readonly db: Knex,
    private readonly userService: UserService,
  ) {}

  /**
   * Buckets this user may browse, in the resolution order used elsewhere in the
   * codebase (see `UserService.getEffectivePromptAccess`):
   *
   *   1. platform admin -> every live bucket
   *   2. an explicit `deny` on any of the user's teams -> excluded
   *   3. `defaultAccess = 'allow'` -> included
   *   4. otherwise -> included only on an explicit team `allow`
   *
   * Deny beats allow, so a single deny grant is enough to withdraw a bucket
   * from someone who also sits in a team that was granted it.
   */
  async listAccessibleBuckets(userId: string): Promise<GcsBucketRecord[]> {
    const rows = await this.db<BucketRow>('gcs_buckets')
      .where({ isArchived: false })
      .orderBy('displayName', 'asc');
    if (!rows.length) {
      return [];
    }

    if (await this.userService.isPlatformAdmin(userId)) {
      return rows.map((row) => toRecord(row, []));
    }

    const memberships = await this.db('group_members').select('groupId').where({ userId });
    const teamIds = memberships
      .map((row: { groupId?: string }) => String(row.groupId || ''))
      .filter(Boolean);

    const grants = teamIds.length
      ? await this.db('gcs_bucket_team_grants')
        .select('bucketId', 'effect')
        .whereIn('teamId', teamIds)
      : [];

    const denied = new Set<string>();
    const allowed = new Set<string>();
    for (const grant of grants as Array<{ bucketId: string; effect: string }>) {
      if (grant.effect === 'deny') {
        denied.add(grant.bucketId);
      } else {
        allowed.add(grant.bucketId);
      }
    }

    return rows
      .filter((row) => {
        if (denied.has(row.id)) {
          return false;
        }
        return row.defaultAccess === 'allow' || allowed.has(row.id);
      })
      .map((row) => toRecord(row, []));
  }

  /**
   * The bucket behind an id, or a 403 if this user may not reach it. Callers get
   * the same answer whether the bucket is missing, archived or merely ungranted,
   * so the registry does not leak which buckets exist.
   */
  async requireAccessibleBucket(userId: string, bucketId: string): Promise<GcsBucketRecord> {
    const accessible = await this.listAccessibleBuckets(userId);
    const bucket = accessible.find((entry) => entry.id === bucketId);
    if (!bucket) {
      throw new AccessDeniedError('This Cloud Storage bucket is not available to you.');
    }
    return bucket;
  }

  // --- admin surface -------------------------------------------------------

  async listAll(options: { includeArchived?: boolean } = {}): Promise<GcsBucketRecord[]> {
    const query = this.db<BucketRow>('gcs_buckets').orderBy('displayName', 'asc');
    if (!options.includeArchived) {
      query.where({ isArchived: false });
    }
    const rows = await query;
    if (!rows.length) {
      return [];
    }

    const grants = await this.db('gcs_bucket_team_grants as grant')
      .leftJoin('groups as team', 'team.id', 'grant.teamId')
      .select('grant.bucketId', 'grant.teamId', 'grant.effect', 'team.name as teamName')
      .whereIn('grant.bucketId', rows.map((row) => row.id));

    const grantsByBucket = new Map<string, GcsBucketRecord['teamGrants']>();
    for (const grant of grants as Array<{ bucketId: string; teamId: string; effect: string; teamName: string | null }>) {
      const list = grantsByBucket.get(grant.bucketId) || [];
      list.push({
        teamId: grant.teamId,
        teamName: grant.teamName || null,
        effect: grant.effect === 'deny' ? 'deny' : 'allow',
      });
      grantsByBucket.set(grant.bucketId, list);
    }

    return rows.map((row) => toRecord(row, grantsByBucket.get(row.id) || []));
  }

  async create(input: GcsBucketInput, createdByUserId: string): Promise<GcsBucketRecord> {
    const bucketName = normalizeBucketName(input.bucketName);
    if (!bucketName) {
      throw new HttpError(400, 'A bucket name is required');
    }
    const pathPrefix = normalizePathPrefix(input.pathPrefix);
    const existing = await this.db('gcs_buckets').where({ bucketName, pathPrefix }).first();
    if (existing) {
      throw new ConflictError(`"${bucketName}/${pathPrefix}" is already registered`);
    }

    const id = randomUUID();
    await this.db('gcs_buckets').insert({
      id,
      bucketName,
      pathPrefix,
      displayName: String(input.displayName || '').trim() || bucketName,
      description: input.description || null,
      defaultAccess: input.defaultAccess === 'allow' ? 'allow' : 'deny',
      isArchived: false,
      createdByUserId,
    });

    return this.requireById(id);
  }

  async update(bucketId: string, input: Partial<GcsBucketInput> & { isArchived?: boolean }): Promise<GcsBucketRecord> {
    await this.requireById(bucketId);
    const patch: Record<string, unknown> = { updatedAt: this.db.fn.now() };

    if (input.displayName !== undefined) {
      patch.displayName = String(input.displayName).trim();
    }
    if (input.description !== undefined) {
      patch.description = input.description || null;
    }
    if (input.defaultAccess !== undefined) {
      patch.defaultAccess = input.defaultAccess === 'allow' ? 'allow' : 'deny';
    }
    if (input.pathPrefix !== undefined) {
      patch.pathPrefix = normalizePathPrefix(input.pathPrefix);
    }
    if (input.isArchived !== undefined) {
      patch.isArchived = Boolean(input.isArchived);
    }

    await this.db('gcs_buckets').where({ id: bucketId }).update(patch);
    return this.requireById(bucketId);
  }

  /**
   * Retiring a bucket archives it rather than deleting the row, so the grants an
   * admin built up survive and the action stays reversible — the same choice the
   * skill catalog makes.
   */
  async archive(bucketId: string): Promise<GcsBucketRecord> {
    return this.update(bucketId, { isArchived: true });
  }

  async replaceTeamGrants(
    bucketId: string,
    grants: Array<{ teamId: string; effect: 'allow' | 'deny' }>,
    grantedByUserId: string,
  ): Promise<GcsBucketRecord> {
    await this.requireById(bucketId);
    await this.db.transaction(async (tx) => {
      await tx('gcs_bucket_team_grants').where({ bucketId }).del();
      if (!grants.length) {
        return;
      }
      await tx('gcs_bucket_team_grants').insert(grants.map((grant) => ({
        bucketId,
        teamId: grant.teamId,
        effect: grant.effect === 'deny' ? 'deny' : 'allow',
        grantedByUserId,
      })));
    });
    return this.requireById(bucketId);
  }

  private async requireById(bucketId: string): Promise<GcsBucketRecord> {
    const row = await this.db<BucketRow>('gcs_buckets').where({ id: bucketId }).first();
    if (!row) {
      throw new NotFoundError('Cloud Storage bucket registration not found');
    }
    const grants = await this.db('gcs_bucket_team_grants as grant')
      .leftJoin('groups as team', 'team.id', 'grant.teamId')
      .select('grant.teamId', 'grant.effect', 'team.name as teamName')
      .where({ 'grant.bucketId': bucketId });
    return toRecord(row, (grants as Array<{ teamId: string; effect: string; teamName: string | null }>).map((grant) => ({
      teamId: grant.teamId,
      teamName: grant.teamName || null,
      effect: grant.effect === 'deny' ? 'deny' : 'allow',
    })));
  }
}

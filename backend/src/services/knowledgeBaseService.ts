import { randomUUID } from 'crypto';
import { Knex } from 'knex';
import { DatabaseService } from './databaseService';
import { KnowledgeService } from './knowledgeService';
import { AccessDeniedError, ConflictError, NotFoundError } from '../errors';
import {
  DEFAULT_KNOWLEDGE_BASE_ID,
  KNOWLEDGE_STORAGE_USER_ID,
  KnowledgeBase,
  KnowledgeBaseStatus,
  KnowledgeBaseVersionMember,
  KnowledgeType,
} from '../types/knowledge';
import { isPlatformAdmin, isTeamLead, leadTeamIds, userTeamIds } from './governance/teamRoles';

interface KnowledgeBaseRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  ownerTeamId: string | null;
  status: KnowledgeBaseStatus;
  currentVersion: string | null;
  isDefault: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

const slugify = (value: string): string => String(value || '')
  .normalize('NFKD')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 96) || 'base';

const readIngestion = (metadata: unknown): Record<string, any> | null => {
  let parsed: any = metadata;
  if (typeof metadata === 'string') {
    try { parsed = JSON.parse(metadata); } catch { return null; }
  }
  const ingestion = parsed && typeof parsed === 'object' ? parsed.ingestion : null;
  return ingestion && typeof ingestion === 'object' && !Array.isArray(ingestion) ? ingestion : null;
};

const readSnapshotHash = (metadata: unknown): string | null => {
  const hash = readIngestion(metadata)?.snapshotHash;
  return typeof hash === 'string' && hash ? hash : null;
};

const parseMemberSnapshot = (value: unknown): KnowledgeBaseVersionMember[] => {
  let parsed: any = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { parsed = []; }
  }
  return Array.isArray(parsed) ? parsed : [];
};

/** Compute the next `major.minor` version string given the existing ones. */
const nextVersion = (existing: string[]): string => {
  let bestMajor = 0;
  let bestMinor = 0;
  let seen = false;
  for (const raw of existing) {
    const match = /^(\d+)\.(\d+)/.exec(String(raw || '').trim());
    if (!match) continue;
    seen = true;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major > bestMajor || (major === bestMajor && minor > bestMinor)) {
      bestMajor = major;
      bestMinor = minor;
    }
  }
  return seen ? `${bestMajor}.${bestMinor + 1}` : '0.1';
};

export class KnowledgeBaseService {
  private db: Knex;
  private knowledgeService: KnowledgeService;

  constructor(databaseService: DatabaseService, knowledgeService: KnowledgeService) {
    this.db = databaseService.getDb();
    this.knowledgeService = knowledgeService;
  }

  private mapKb(row: KnowledgeBaseRow): KnowledgeBase {
    return {
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      description: row.description ?? null,
      ownerTeamId: row.ownerTeamId ?? null,
      status: row.status,
      currentVersion: row.currentVersion ?? null,
      isDefault: Boolean(row.isDefault),
      createdByUserId: row.createdByUserId ?? null,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  }

  private async requireKb(knowledgeBaseId: string): Promise<KnowledgeBaseRow> {
    const row = await this.db('knowledge_bases').where({ id: knowledgeBaseId }).first();
    if (!row) throw new NotFoundError('Knowledge base not found');
    return row as KnowledgeBaseRow;
  }

  /** Manage = create/edit/publish/grant. Platform admin, or team lead of the owner team. */
  private async canManage(userId: string, kb: Pick<KnowledgeBaseRow, 'ownerTeamId'>): Promise<boolean> {
    if (await isPlatformAdmin(this.db, userId)) return true;
    return Boolean(kb.ownerTeamId) && isTeamLead(this.db, userId, String(kb.ownerTeamId));
  }

  private async requireManage(userId: string, kb: KnowledgeBaseRow): Promise<void> {
    if (!await this.canManage(userId, kb)) {
      throw new AccessDeniedError('Team Lead of the owning team (or platform admin) is required');
    }
  }

  /** View = manage, or a member of the owner team / a granted team. */
  private async canView(userId: string, kb: KnowledgeBaseRow): Promise<boolean> {
    if (await this.canManage(userId, kb)) return true;
    const teamIds = await userTeamIds(this.db, userId);
    if (kb.ownerTeamId && teamIds.includes(String(kb.ownerTeamId))) return true;
    if (!teamIds.length) return false;
    const grant = await this.db('knowledge_base_group_grants')
      .where({ knowledgeBaseId: kb.id, effect: 'allow' })
      .whereIn('teamId', teamIds)
      .first();
    return Boolean(grant);
  }

  /**
   * Authorize read access to a member source's OKF data (bundle/graph/snapshots)
   * for whoever can view the base. Throws if the base is not viewable or the
   * source is not a member of it.
   */
  async assertSourceAccess(userId: string, knowledgeBaseId: string, knowledgeSourceId: number): Promise<void> {
    const kb = await this.requireKb(knowledgeBaseId);
    if (!await this.canView(userId, kb)) throw new NotFoundError('Knowledge base not found');
    const member = await this.db('knowledge_sources')
      .where({ id: knowledgeSourceId, knowledgeBaseId })
      .first();
    if (!member) throw new NotFoundError('Knowledge source not found in this knowledge base');
  }

  private async usage(knowledgeBaseId: string): Promise<{ sourceCount: number; teamGrantCount: number }> {
    const [sources, teams] = await Promise.all([
      this.db('knowledge_sources').where({ knowledgeBaseId }).count<{ count: string }[]>('* as count').first(),
      this.db('knowledge_base_group_grants').where({ knowledgeBaseId }).count<{ count: string }[]>('* as count').first(),
    ]);
    return {
      sourceCount: Number(sources?.count || 0),
      teamGrantCount: Number(teams?.count || 0),
    };
  }

  private async ownerTeamName(ownerTeamId: string | null): Promise<string | null> {
    if (!ownerTeamId) return null;
    const group = await this.db('groups').select('name').where({ id: ownerTeamId }).first();
    return group?.name ? String(group.name) : null;
  }

  /** Bases the caller may view, with counts + availability. Admins see everything. */
  async catalog(userId: string) {
    const admin = await isPlatformAdmin(this.db, userId);
    let query = this.db('knowledge_bases as kb').where('kb.status', '!=', 'archived');
    if (!admin) {
      const teamIds = await userTeamIds(this.db, userId);
      // Non-admins with no team memberships can access no bases.
      if (!teamIds.length) return [];
      query = query.andWhere((builder) => {
        builder.whereIn('kb.ownerTeamId', teamIds)
          .orWhereIn('kb.id', this.db('knowledge_base_group_grants')
            .select('knowledgeBaseId')
            .where('effect', 'allow')
            .whereIn('teamId', teamIds));
      });
    }
    const rows = await query.select('kb.*').orderBy('kb.name', 'asc');
    return Promise.all(rows.map(async (row: KnowledgeBaseRow) => ({
      ...this.mapKb(row),
      ownerTeamName: await this.ownerTeamName(row.ownerTeamId),
      ...(await this.usage(row.id)),
      available: row.status === 'published',
    })));
  }

  /** Bases the caller can manage — for the create/manage view. */
  async listMine(userId: string) {
    const admin = await isPlatformAdmin(this.db, userId);
    let rows: KnowledgeBaseRow[];
    if (admin) {
      rows = await this.db('knowledge_bases').whereNot({ status: 'archived' }).orderBy('name', 'asc');
    } else {
      const teamIds = await userTeamIds(this.db, userId);
      rows = teamIds.length
        ? await this.db('knowledge_bases').whereIn('ownerTeamId', teamIds).whereNot({ status: 'archived' }).orderBy('name', 'asc')
        : [];
    }
    return Promise.all(rows.map(async (row) => ({
      ...this.mapKb(row),
      ownerTeamName: await this.ownerTeamName(row.ownerTeamId),
      ...(await this.usage(row.id)),
    })));
  }

  async create(userId: string, input: { name: string; description?: string | null; ownerTeamId: string }) {
    const name = String(input.name || '').trim();
    if (!name) throw new ConflictError('Knowledge base name is required');
    const ownerTeamId = String(input.ownerTeamId || '').trim();
    if (!ownerTeamId) throw new ConflictError('An owning team is required');
    // Manage check against the intended owner team.
    if (!await this.canManage(userId, { ownerTeamId })) {
      throw new AccessDeniedError('Team Lead of the owning team (or platform admin) is required');
    }
    const slug = await this.uniqueSlug(name);
    const id = randomUUID();
    const [row] = await this.db('knowledge_bases')
      .insert({
        id,
        slug,
        name,
        description: input.description ? String(input.description) : null,
        ownerTeamId,
        status: 'draft',
        isDefault: false,
        createdByUserId: userId,
      })
      .returning('*');
    return this.mapKb(row as KnowledgeBaseRow);
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = `knowledge/${slugify(name)}`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await this.db('knowledge_bases').where({ slug: candidate }).first();
      if (!existing) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  /** The member snapshot of the most recently published version, or null if never published. */
  private async latestPublishedMembers(knowledgeBaseId: string): Promise<KnowledgeBaseVersionMember[] | null> {
    const row = await this.db('knowledge_base_versions')
      .where({ knowledgeBaseId })
      .orderBy('publishedAt', 'desc')
      .first();
    return row ? parseMemberSnapshot(row.memberSnapshot) : null;
  }

  /**
   * Flag current members added/changed since the last published version and report
   * whether there is anything to publish. When never published, all members count as
   * pending (added). When published, a change is an added/changed/removed member.
   */
  private changeState<T extends { knowledgeSourceId: number; snapshotHash?: string | null }>(
    members: T[],
    publishedMembers: KnowledgeBaseVersionMember[] | null,
    status: KnowledgeBaseStatus,
  ): { flagged: Array<T & { addedSincePublish: boolean; changedSincePublish: boolean }>; hasUnpublishedChanges: boolean } {
    const publishedById = new Map((publishedMembers || []).map((m) => [m.knowledgeSourceId, m.snapshotHash || null]));
    let changed = false;
    const flagged = members.map((member) => {
      const addedSincePublish = publishedMembers === null ? true : !publishedById.has(member.knowledgeSourceId);
      const changedSincePublish = publishedById.has(member.knowledgeSourceId)
        && publishedById.get(member.knowledgeSourceId) !== (member.snapshotHash || null);
      if (addedSincePublish || changedSincePublish) changed = true;
      return { ...member, addedSincePublish, changedSincePublish };
    });
    const currentIds = new Set(members.map((m) => m.knowledgeSourceId));
    const removed = (publishedMembers || []).some((m) => !currentIds.has(m.knowledgeSourceId));
    const hasUnpublishedChanges = status !== 'published' ? members.length > 0 : (changed || removed);
    return { flagged, hasUnpublishedChanges };
  }

  async getDetail(userId: string, knowledgeBaseId: string) {
    const kb = await this.requireKb(knowledgeBaseId);
    if (!await this.canView(userId, kb)) throw new NotFoundError('Knowledge base not found');
    const sources = await this.db('knowledge_sources')
      .where({ knowledgeBaseId })
      .select('id', 'title', 'type', 'fileId', 'metadata')
      .orderBy('title', 'asc');
    const rawMembers = sources.map((row: any) => {
      const ingestion = readIngestion(row.metadata);
      const snapshotHash = readSnapshotHash(row.metadata);
      return {
        knowledgeSourceId: Number(row.id),
        title: String(row.title),
        type: String(row.type),
        snapshotHash,
        published: Boolean(snapshotHash),
        ingestionStatus: ingestion?.status ? String(ingestion.status) : null,
        ingestionStage: ingestion?.stage ? String(ingestion.stage) : null,
        coveragePercent: typeof ingestion?.coveragePercent === 'number' ? ingestion.coveragePercent : null,
      };
    });
    const publishedMembers = await this.latestPublishedMembers(knowledgeBaseId);
    const { flagged, hasUnpublishedChanges } = this.changeState(rawMembers, publishedMembers, kb.status);
    return {
      ...this.mapKb(kb),
      ownerTeamName: await this.ownerTeamName(kb.ownerTeamId),
      ...(await this.usage(knowledgeBaseId)),
      members: flagged,
      hasUnpublishedChanges,
      permissions: { canManage: await this.canManage(userId, kb) },
    };
  }

  async update(userId: string, knowledgeBaseId: string, patch: { name?: string; description?: string | null; ownerTeamId?: string }) {
    const kb = await this.requireKb(knowledgeBaseId);
    await this.requireManage(userId, kb);
    if (kb.isDefault && patch.ownerTeamId) {
      throw new ConflictError('The default knowledge base cannot be reassigned to a team');
    }
    const update: Record<string, unknown> = { updatedAt: this.db.fn.now() };
    if (typeof patch.name === 'string' && patch.name.trim()) update.name = patch.name.trim();
    if (patch.description !== undefined) update.description = patch.description ? String(patch.description) : null;
    if (typeof patch.ownerTeamId === 'string' && patch.ownerTeamId.trim()) {
      // Reassigning owner requires manage rights over the target team too.
      if (!await this.canManage(userId, { ownerTeamId: patch.ownerTeamId.trim() })) {
        throw new AccessDeniedError('Team Lead of the target team (or platform admin) is required');
      }
      update.ownerTeamId = patch.ownerTeamId.trim();
    }
    const [row] = await this.db('knowledge_bases').where({ id: knowledgeBaseId }).update(update).returning('*');
    return this.mapKb(row as KnowledgeBaseRow);
  }

  async addSource(userId: string, knowledgeBaseId: string, knowledgeSourceId: number) {
    const kb = await this.requireKb(knowledgeBaseId);
    await this.requireManage(userId, kb);
    const source = await this.db('knowledge_sources').where({ id: knowledgeSourceId, isGlobal: true }).first();
    if (!source) throw new NotFoundError('Knowledge source not found');
    await this.db('knowledge_sources').where({ id: knowledgeSourceId }).update({ knowledgeBaseId, updatedAt: this.db.fn.now() });
    return this.getDetail(userId, knowledgeBaseId);
  }

  async removeSource(userId: string, knowledgeBaseId: string, knowledgeSourceId: number) {
    const kb = await this.requireKb(knowledgeBaseId);
    await this.requireManage(userId, kb);
    // Sources must always belong to a base; removal returns them to the default base.
    await this.db('knowledge_sources')
      .where({ id: knowledgeSourceId, knowledgeBaseId })
      .update({ knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID, updatedAt: this.db.fn.now() });
    return this.getDetail(userId, knowledgeBaseId);
  }

  async publish(userId: string, knowledgeBaseId: string, input: { version?: string; note?: string } = {}) {
    const kb = await this.requireKb(knowledgeBaseId);
    await this.requireManage(userId, kb);
    const sources = await this.db('knowledge_sources')
      .where({ knowledgeBaseId })
      .select('id', 'title', 'type', 'metadata');
    const memberSnapshot: KnowledgeBaseVersionMember[] = sources.map((row: any) => ({
      knowledgeSourceId: Number(row.id),
      title: String(row.title),
      type: row.type as KnowledgeType,
      snapshotHash: readSnapshotHash(row.metadata),
    }));
    const publishedMembers = await this.latestPublishedMembers(knowledgeBaseId);
    const { hasUnpublishedChanges } = this.changeState(memberSnapshot, publishedMembers, kb.status);
    if (!hasUnpublishedChanges) {
      throw new ConflictError('No changes to publish since the last published version');
    }
    const existingVersions = (await this.db('knowledge_base_versions')
      .where({ knowledgeBaseId })
      .pluck('version')) as string[];
    const requested = String(input.version || '').trim();
    if (requested && existingVersions.includes(requested)) {
      throw new ConflictError(`Version ${requested} already exists for this knowledge base`);
    }
    const version = requested || nextVersion(existingVersions);
    const versionId = randomUUID();
    await this.db.transaction(async (trx) => {
      await trx('knowledge_base_versions').insert({
        id: versionId,
        knowledgeBaseId,
        version,
        memberSnapshot: JSON.stringify(memberSnapshot),
        note: input.note ? String(input.note) : null,
        publishedByUserId: userId,
      });
      await trx('knowledge_bases').where({ id: knowledgeBaseId }).update({
        status: 'published',
        currentVersion: version,
        updatedAt: trx.fn.now(),
      });
    });
    return this.getDetail(userId, knowledgeBaseId);
  }

  async listVersions(userId: string, knowledgeBaseId: string) {
    const kb = await this.requireKb(knowledgeBaseId);
    if (!await this.canView(userId, kb)) throw new NotFoundError('Knowledge base not found');
    const rows = await this.db('knowledge_base_versions')
      .where({ knowledgeBaseId })
      .orderBy('publishedAt', 'asc');
    const parseMembers = parseMemberSnapshot;
    const result = rows.map((row: any, index: number) => {
      const members = parseMembers(row.memberSnapshot);
      const prev = index > 0 ? parseMembers(rows[index - 1].memberSnapshot) : [];
      const prevById = new Map(prev.map((m) => [m.knowledgeSourceId, m]));
      const curById = new Map(members.map((m) => [m.knowledgeSourceId, m]));
      const added = members.filter((m) => !prevById.has(m.knowledgeSourceId)).map((m) => m.title);
      const updated = members
        .filter((m) => {
          const before = prevById.get(m.knowledgeSourceId);
          return before && (before.snapshotHash || null) !== (m.snapshotHash || null);
        })
        .map((m) => m.title);
      const removed = prev.filter((m) => !curById.has(m.knowledgeSourceId)).map((m) => m.title);
      return {
        id: String(row.id),
        version: String(row.version),
        note: row.note ?? null,
        publishedByUserId: row.publishedByUserId ?? null,
        publishedAt: String(row.publishedAt),
        sourceCount: members.length,
        changes: { added, updated, removed },
        isCurrent: kb.currentVersion === String(row.version),
      };
    });
    // Newest first for display.
    return result.reverse();
  }

  async setTeamGrant(userId: string, knowledgeBaseId: string, teamId: string, allow: boolean) {
    const kb = await this.requireKb(knowledgeBaseId);
    await this.requireManage(userId, kb);
    const team = await this.db('groups').where({ id: teamId }).first();
    if (!team) throw new NotFoundError('Team not found');
    if (allow) {
      await this.db('knowledge_base_group_grants')
        .insert({ knowledgeBaseId, teamId, effect: 'allow', grantedByUserId: userId })
        .onConflict(['knowledgeBaseId', 'teamId'])
        .merge({ effect: 'allow', grantedByUserId: userId, updatedAt: this.db.fn.now() });
    } else {
      await this.db('knowledge_base_group_grants').where({ knowledgeBaseId, teamId }).del();
    }
    return this.getDetail(userId, knowledgeBaseId);
  }

  async listTeamGrants(userId: string, knowledgeBaseId: string) {
    const kb = await this.requireKb(knowledgeBaseId);
    if (!await this.canView(userId, kb)) throw new NotFoundError('Knowledge base not found');
    const rows = await this.db('knowledge_base_group_grants as kg')
      .join('groups as g', 'g.id', 'kg.teamId')
      .where('kg.knowledgeBaseId', knowledgeBaseId)
      .andWhere('kg.effect', 'allow')
      .select('kg.teamId as teamId', 'g.name as teamName', 'kg.createdAt as createdAt');
    return rows.map((row: any) => ({
      teamId: String(row.teamId),
      teamName: String(row.teamName),
      createdAt: String(row.createdAt),
    }));
  }

  // --- Direct upload into a knowledge base -------------------------------------------------
  // Managers upload documents straight into a base; the storage-workspace operations run as
  // the system storage user (owner of the sandbox) so team leads (non-admins) aren't blocked,
  // while the source's author stays the real requester.

  async createUploadSession(userId: string, knowledgeBaseId: string, input: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    title: string;
    type: KnowledgeType;
    description?: string;
    metadata?: Record<string, unknown>;
  }) {
    const kb = await this.requireKb(knowledgeBaseId);
    await this.requireManage(userId, kb);
    if (kb.status === 'archived') throw new ConflictError('Cannot upload into an archived knowledge base');
    return this.knowledgeService.createGlobalUploadSession(userId, input, {
      knowledgeBaseId,
      storageActorUserId: KNOWLEDGE_STORAGE_USER_ID,
    });
  }

  async completeUpload(userId: string, knowledgeBaseId: string, uploadId: string) {
    const kb = await this.requireKb(knowledgeBaseId);
    await this.requireManage(userId, kb);
    return this.knowledgeService.completeGlobalUploadSession(userId, uploadId, {
      storageActorUserId: KNOWLEDGE_STORAGE_USER_ID,
    });
  }

  async cancelUpload(userId: string, knowledgeBaseId: string, uploadId: string) {
    const kb = await this.requireKb(knowledgeBaseId);
    await this.requireManage(userId, kb);
    return this.knowledgeService.cancelGlobalUploadSession(userId, uploadId);
  }

  /** Global sources the caller may assign into a base they manage — restricted to
   * documents already in bases owned by teams the user leads (admins: all global). */
  async assignableSources(userId: string) {
    const admin = await isPlatformAdmin(this.db, userId);
    let query = this.db('knowledge_sources as ks')
      .leftJoin('knowledge_bases as kb', 'kb.id', 'ks.knowledgeBaseId')
      .where('ks.isGlobal', true);
    if (!admin) {
      const teamIds = await leadTeamIds(this.db, userId);
      if (!teamIds.length) return [];
      query = query.whereIn('kb.ownerTeamId', teamIds);
    }
    const rows = await query
      .select('ks.id as id', 'ks.title as title', 'ks.type as type', 'ks.knowledgeBaseId as knowledgeBaseId', 'kb.name as knowledgeBaseName')
      .orderBy('ks.title', 'asc');
    return rows.map((row: any) => ({
      knowledgeSourceId: Number(row.id),
      title: String(row.title),
      type: String(row.type),
      knowledgeBaseId: row.knowledgeBaseId ? String(row.knowledgeBaseId) : null,
      knowledgeBaseName: row.knowledgeBaseName ? String(row.knowledgeBaseName) : null,
    }));
  }

  async setStatus(userId: string, knowledgeBaseId: string, action: 'archive' | 'restore') {
    const kb = await this.requireKb(knowledgeBaseId);
    await this.requireManage(userId, kb);
    if (kb.isDefault) throw new ConflictError('The default knowledge base cannot be archived');
    const status: KnowledgeBaseStatus = action === 'archive'
      ? 'archived'
      : (kb.currentVersion ? 'published' : 'draft');
    const [row] = await this.db('knowledge_bases')
      .where({ id: knowledgeBaseId })
      .update({ status, updatedAt: this.db.fn.now() })
      .returning('*');
    return this.mapKb(row as KnowledgeBaseRow);
  }
}

import { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';

/**
 * Transactional invariants for Team Chat threads (spec section 5.1).
 *
 * Ordering is derived from an allocated per-thread `sequence`, never from
 * timestamps. Thread creation, root insertion and root assignment happen in a
 * single transaction. Sequences are allocated under a thread row lock so that
 * concurrent inserts cannot collide on `(threadId, sequence)`.
 *
 * Dual writes keep the legacy `threadRootId` / `replyToMessageId` columns valid
 * during rollout: a root has `threadRootId = null`, a reply keeps the original
 * root message id. New thread messages without a quote need no reply target.
 */

export type ThreadStatus = 'open' | 'resolved';

export type ThreadRow = {
  id: string;
  workspaceId: string;
  rootMessageId: string | null;
  title: string | null;
  createdBy: string | null;
  status: ThreadStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  lastMessageSeq: string | number;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
};

export type InsertedMessage = {
  id: string;
  threadId: string;
  sequence: number;
};

const MAX_TITLE_LENGTH = 255;

/**
 * Derive a thread title from the first nonempty line of the opening message.
 * Never invokes an agent. Uses the first 80 Unicode characters with an ellipsis.
 */
export const deriveThreadTitle = (body: string, explicitTitle?: string): string => {
  const explicit = explicitTitle?.trim();
  if (explicit) return Array.from(explicit).slice(0, MAX_TITLE_LENGTH).join('');
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0) || 'New thread';
  const chars = Array.from(firstLine);
  if (chars.length <= 80) return chars.join('');
  return `${chars.slice(0, 80).join('')}…`;
};

export class WorkspaceTeamThreadStore {
  constructor(private readonly db: Knex) {}

  /**
   * Create a thread and its opening (root) message atomically. The first
   * successful send creates the row; an empty composer never reaches here.
   */
  async createThreadWithRoot(
    tx: Knex.Transaction,
    params: {
      workspaceId: string;
      authorId: string;
      title?: string;
      body: string;
      originVersionId: string | null;
      mentionsLumo: boolean;
      metadata: Record<string, unknown>;
      clientMessageId?: string | null;
      clientPayloadHash?: string | null;
    },
  ): Promise<{ thread: ThreadRow; message: InsertedMessage }> {
    const threadId = uuidv4();
    const messageId = uuidv4();
    const title = deriveThreadTitle(params.body, params.title);

    // Insert the thread with the (deferrable) root id set upfront so the deferred
    // integrity trigger never sees a null root. The FK is validated at commit,
    // by which time the root message row exists.
    await tx('workspace_team_threads').insert({
      id: threadId,
      workspaceId: params.workspaceId,
      rootMessageId: messageId,
      title,
      createdBy: params.authorId,
      status: 'open',
      lastMessageSeq: 1,
      lastActivityAt: tx.fn.now(),
    });

    await tx('workspace_team_messages').insert({
      id: messageId,
      workspaceId: params.workspaceId,
      threadId,
      sequence: 1,
      originVersionId: params.originVersionId,
      authorId: params.authorId,
      authorType: 'user',
      body: params.body,
      replyToMessageId: null,
      // Legacy dual-write: a root's threadRootId stays null.
      threadRootId: null,
      mentionsLumo: params.mentionsLumo,
      clientMessageId: params.clientMessageId || null,
      clientPayloadHash: params.clientPayloadHash || null,
      metadata: params.metadata,
    });

    const thread = await tx('workspace_team_threads').where({ id: threadId }).first();
    return { thread: thread as ThreadRow, message: { id: messageId, threadId, sequence: 1 } };
  }

  /**
   * Append a message to an existing thread. Locks the thread row to allocate the
   * next consecutive sequence and update activity counters. A new human message
   * reopens a resolved thread in the same transaction.
   */
  async appendMessage(
    tx: Knex.Transaction,
    params: {
      workspaceId: string;
      threadId: string;
      authorId: string | null;
      authorType: 'user' | 'lumo' | 'system';
      body: string;
      originVersionId: string | null;
      replyToMessageId?: string | null;
      mentionsLumo?: boolean;
      metadata?: Record<string, unknown>;
      clientMessageId?: string | null;
      clientPayloadHash?: string | null;
    },
  ): Promise<InsertedMessage> {
    const thread = await tx('workspace_team_threads')
      .where({ id: params.threadId, workspaceId: params.workspaceId })
      .forUpdate()
      .first();
    if (!thread) {
      throw new Error('Thread not found for message append');
    }
    const nextSeq = Number(thread.lastMessageSeq || 0) + 1;
    const messageId = uuidv4();
    // Legacy dual-write: replies keep the original root message id.
    const rootMessageId = thread.rootMessageId as string | null;

    await tx('workspace_team_messages').insert({
      id: messageId,
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      sequence: nextSeq,
      originVersionId: params.originVersionId,
      authorId: params.authorId,
      authorType: params.authorType,
      body: params.body,
      replyToMessageId: params.replyToMessageId || null,
      threadRootId: rootMessageId,
      mentionsLumo: params.mentionsLumo || false,
      clientMessageId: params.clientMessageId || null,
      clientPayloadHash: params.clientPayloadHash || null,
      metadata: params.metadata || {},
    });

    const reopen = params.authorType === 'user' && thread.status === 'resolved';
    await tx('workspace_team_threads')
      .where({ id: params.threadId })
      .update({
        lastMessageSeq: nextSeq,
        lastActivityAt: tx.fn.now(),
        updatedAt: tx.fn.now(),
        ...(reopen ? { status: 'open', resolvedAt: null, resolvedBy: null } : {}),
      });

    return { id: messageId, threadId: params.threadId, sequence: nextSeq };
  }

  /**
   * Lazily migrate a legacy message group (identified by its original root
   * message id) into a canonical thread before the first new send. Uses the
   * original root UUID as the thread UUID for a stable, idempotent mapping and
   * coordinates via an advisory lock keyed on the root id so bulk backfill and
   * dual writes never renumber or double-assign sequences.
   *
   * Returns the canonical thread id. This is the single source of truth for
   * legacy migration invariants; the bulk backfill delegates here.
   */
  async ensureThreadForLegacyRoot(
    tx: Knex.Transaction,
    workspaceId: string,
    rootMessageId: string,
  ): Promise<string> {
    const result = await this.migrateLegacyGroup(tx, workspaceId, rootMessageId);
    return result.threadId;
  }

  /**
   * Walk a message's `threadRootId` chain WITHIN its own workspace to classify how
   * it should be canonicalized. This is the single source of truth shared by the
   * bulk backfill and the live lazy/dual-write path, so both recover/quarantine
   * identically.
   *  - { kind: 'root', rootId }   → a genuine same-workspace root; migrate its group.
   *  - { kind: 'recover', rootId }→ cycle / malformed / dangling chain; recover the
   *                                 supplied message id as its own independent thread
   *                                 with a visible recovered-history marker.
   *  - { kind: 'foreign' }        → the chain references another workspace; refuse
   *                                 and quarantine (never follow foreign content).
   */
  async classifyLegacyGroup(
    tx: Knex.Transaction,
    workspaceId: string,
    messageId: string,
  ): Promise<{ kind: 'root' | 'recover' | 'foreign'; rootId?: string }> {
    const start = await tx('workspace_team_messages').where({ id: messageId }).first();
    if (!start) throw new Error('Legacy message not found');
    if (String(start.workspaceId) !== String(workspaceId)) return { kind: 'foreign' };
    if (start.threadRootId == null) return { kind: 'root', rootId: String(start.id) };
    const seen = new Set<string>([String(start.id)]);
    let pointer: string | null = String(start.threadRootId);
    for (let hops = 0; pointer && hops < 64; hops += 1) {
      if (seen.has(pointer)) return { kind: 'recover', rootId: String(messageId) }; // cycle
      seen.add(pointer);
      const target: any = await tx('workspace_team_messages').where({ id: pointer }).first();
      if (!target) return { kind: 'recover', rootId: String(messageId) }; // dangling
      if (String(target.workspaceId) !== String(workspaceId)) return { kind: 'foreign' };
      if (target.threadRootId == null) return { kind: 'root', rootId: String(target.id) };
      pointer = String(target.threadRootId);
    }
    return { kind: 'recover', rootId: String(messageId) }; // malformed / too long
  }

  /**
   * Recover a single message as an independent thread keyed by its own id, with a
   * visible recovered-history marker. Idempotent and shared by bulk + lazy paths.
   */
  async recoverAsIndependentThread(
    tx: Knex.Transaction,
    workspaceId: string,
    messageId: string,
  ): Promise<{ threadId: string; migrated: boolean }> {
    await tx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`team-thread-root:${messageId}`]);
    const fresh = await tx('workspace_team_messages').where({ id: messageId, workspaceId }).first();
    if (!fresh) throw new Error('Legacy message not found for recovery');
    if (fresh.threadId) return { threadId: String(fresh.threadId), migrated: false };
    const existing = await tx('workspace_team_threads').where({ id: messageId }).first();
    if (!existing) {
      await tx('workspace_team_threads').insert({
        id: messageId,
        workspaceId,
        rootMessageId: messageId,
        title: `[recovered] ${deriveThreadTitle(String(fresh.body || ''))}`,
        createdBy: fresh.authorId || null,
        status: 'open',
        lastMessageSeq: 1,
        lastActivityAt: fresh.createdAt,
        createdAt: fresh.createdAt,
      });
    }
    if (fresh.sequence == null) {
      await tx('workspace_team_messages').where({ id: messageId }).update({ threadId: messageId, sequence: 1 });
    }
    await this.seedMigrationReadState(tx, workspaceId, messageId, 1);
    return { threadId: messageId, migrated: !existing };
  }

  /**
   * Centralized legacy-group migration used by BOTH the bulk backfill and the live
   * lazy/dual-write path. `entryMessageId` is the message whose group must be
   * canonicalized (a legacy root id, or a reply id whose group needs resolving).
   * Classifies via {@link classifyLegacyGroup} so cycles/malformed chains recover
   * with the recovered marker and cross-workspace chains are refused/quarantined —
   * identically everywhere. Recognizes already-canonical associations so a
   * new-format message is never re-inserted.
   */
  async migrateLegacyGroup(
    tx: Knex.Transaction,
    workspaceId: string,
    entryMessageId: string,
  ): Promise<{ threadId: string; migrated: boolean; anomalies: string[]; quarantined?: boolean }> {
    const anomalies: string[] = [];
    const entry = await tx('workspace_team_messages').where({ id: entryMessageId, workspaceId }).first();
    if (!entry) {
      throw new Error('Legacy root message not found');
    }
    // Already canonical: the message carries a threadId (new-format or migrated).
    if (entry.threadId) {
      return { threadId: String(entry.threadId), migrated: false, anomalies };
    }

    // Resolve where this message's chain actually leads (shared classifier).
    const verdict = await this.classifyLegacyGroup(tx, workspaceId, entryMessageId);
    if (verdict.kind === 'foreign') {
      // Refuse: do not follow foreign content and do not fabricate a thread.
      anomalies.push(`cross-workspace chain from ${entryMessageId} quarantined (unmigrated)`);
      const err: any = new Error('Cannot migrate a cross-workspace message chain');
      err.code = 'CROSS_WORKSPACE_QUARANTINE';
      throw err;
    }
    if (verdict.kind === 'recover') {
      const rec = await this.recoverAsIndependentThread(tx, workspaceId, entryMessageId);
      anomalies.push(`orphan/cycle recovered as independent thread ${entryMessageId}`);
      return { threadId: rec.threadId, migrated: rec.migrated, anomalies };
    }

    // Genuine same-workspace root reached; migrate that root's whole group.
    const rootMessageId = verdict.rootId!;
    // CRITICAL: lock on the resolved canonical ROOT id, not the entry id. Two
    // different replies (A->R, B->R) both resolve to R and must serialize on the
    // SAME lock so only one inserts thread R (otherwise a 23505 unique violation).
    await tx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`team-thread-root:${rootMessageId}`]);

    const root = await tx('workspace_team_messages').where({ id: rootMessageId, workspaceId }).first();
    if (!root) throw new Error('Legacy root message not found');

    // Gather the full TRANSITIVE same-workspace group with a SCOPED recursive CTE
    // that walks child->parent edges (threadRootId) DOWN from this root, staying
    // inside the workspace. This touches only the group (indirect chains like
    // C->A->R included) — never a workspace-wide per-row scan of unrelated threads,
    // so unrelated large history does not scale the query. UNION dedups, so an
    // accidental same-workspace cycle among descendants terminates.
    // Spec §7.3: assign sequences by deterministic historical ordering
    // (createdAt, id). The root is NOT force-ordered first: if a reply carries an
    // earlier createdAt than the root (legacy clock skew / imported history), the
    // reply may legitimately take a lower sequence. The root stays independently
    // retrievable through thread.rootMessageId regardless of its sequence — the
    // thread row records the canonical root id, and getThread/summary resolve root
    // metadata by that id, never by "sequence = 1". This avoids a test-forced
    // root-first renumbering that would contradict the documented ordering while
    // still guaranteeing the root is always addressable.
    const groupRows: any[] = (await tx.raw(
      `WITH RECURSIVE grp AS (
         SELECT id FROM workspace_team_messages WHERE id = ? AND "workspaceId" = ?
         UNION
         SELECT m.id FROM workspace_team_messages m
           JOIN grp ON m."threadRootId" = grp.id
          WHERE m."workspaceId" = ?
       )
       SELECT * FROM workspace_team_messages
        WHERE id IN (SELECT id FROM grp)
          AND ("threadId" IS NULL OR "threadId" = ?)
        ORDER BY "createdAt" ASC, id ASC`,
      [rootMessageId, workspaceId, workspaceId, rootMessageId],
    )).rows;
    const ordered = groupRows;

    // Create the thread if absent (idempotent re-run / concurrent racer safe under
    // the root lock). Otherwise reuse the existing thread. In BOTH cases take the
    // thread row lock (forUpdate) before allocating the tail so a normal live
    // appendMessage — which also locks the thread row to allocate its sequence —
    // cannot race the migration and claim the same (threadId, sequence). The root
    // advisory lock alone does not block appendMessage, which never takes it.
    let existing = await tx('workspace_team_threads').where({ id: rootMessageId }).forUpdate().first();
    let created = false;
    if (!existing) {
      await tx('workspace_team_threads').insert({
        id: rootMessageId,
        workspaceId,
        rootMessageId,
        title: deriveThreadTitle(String(root.body || '')),
        createdBy: root.authorId || null,
        status: 'open',
        lastMessageSeq: 0,
        lastActivityAt: root.createdAt,
        createdAt: root.createdAt,
      });
      existing = await tx('workspace_team_threads').where({ id: rootMessageId }).forUpdate().first();
      created = true;
    }

    // Assign sequences to UNMAPPED members only, after the current tail. Existing
    // canonical rows are never renumbered.
    let nextSeq = Number(existing.lastMessageSeq || 0);
    let lastActivityAt = existing.lastActivityAt;
    let assigned = 0;
    for (const message of ordered) {
      if (message.threadId && message.sequence != null) continue; // never renumber
      nextSeq += 1;
      assigned += 1;
      await tx('workspace_team_messages')
        .where({ id: message.id })
        .update({ threadId: rootMessageId, sequence: nextSeq });
      lastActivityAt = message.createdAt;
    }

    if (assigned > 0) {
      // lastActivityAt must never move BACKWARDS. A concurrent live send may have
      // already advanced the thread's activity to "now" while we are migrating an
      // OLD historical row (whose createdAt is in the past). Take the greatest of
      // the existing activity and the migrated tail timestamp so a late historical
      // migration can never rewind activity below a newer live message (which would
      // reorder the thread list incorrectly). We compare against the freshly
      // re-read row under the same forUpdate lock we hold on the thread.
      const currentActivity = (await tx('workspace_team_threads')
        .where({ id: rootMessageId })
        .select('lastActivityAt')
        .first())?.lastActivityAt || existing.lastActivityAt;
      await tx('workspace_team_threads')
        .where({ id: rootMessageId })
        .update({
          lastMessageSeq: nextSeq,
          lastActivityAt: tx.raw('GREATEST(?::timestamptz, ?::timestamptz)', [currentActivity, lastActivityAt]),
          updatedAt: tx.fn.now(),
        });
      await this.seedMigrationReadState(tx, workspaceId, rootMessageId, nextSeq);
    }

    return { threadId: rootMessageId, migrated: created || assigned > 0, anomalies };
  }

  /**
   * Seed per-user read state at the migration boundary so the release does not
   * mark historical chat unread. All CURRENT workspace members (not only prior
   * authors) start at the current tail; prior participants also start following.
   */
  async seedMigrationReadState(
    tx: Knex.Transaction,
    workspaceId: string,
    threadId: string,
    lastSeq: number,
  ): Promise<void> {
    const members = await tx('workspace_members').where({ workspaceId }).select('userId');
    const participantRows = await tx('workspace_team_messages')
      .where({ threadId }).whereNotNull('authorId').distinct('authorId');
    const participants = new Set(participantRows.map((r: any) => r.authorId));
    for (const { userId } of members) {
      await tx('workspace_team_thread_user_state')
        .insert({ threadId, userId, lastReadSeq: lastSeq, following: participants.has(userId) })
        .onConflict(['threadId', 'userId'])
        .ignore();
    }
  }
}

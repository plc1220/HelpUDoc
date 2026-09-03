import type { Knex } from 'knex';
import { isPlatformAdmin, leadTeamIds } from './governance/teamRoles';
import { describeActivityEvent } from '../lib/activityLabels';

export const ACTIVITY_PAGE_SIZE = 20;
/** The feed reaches back one month. Older events stay in the audit trail. */
export const ACTIVITY_WINDOW_DAYS = 30;
/**
 * Offset paging degrades as it deepens, because every branch has to fetch
 * `offset + pageSize` rows before the merge. One month of events is nowhere near
 * this in practice; the cap is here so a hand-written `page=100000` cannot ask
 * the database for a million rows.
 */
export const MAX_ACTIVITY_PAGE = 50;

export type ActivityScope =
  | { kind: 'platform' }
  | { kind: 'teams'; teamIds: string[]; workspaceIds: string[] };

export type ActivityItem = {
  id: string;
  at: string;
  actorName: string;
  action: string;
  title: string;
  meta: string;
};

/**
 * What this caller is allowed to see.
 *
 * `null` means "not an audience for this feed at all" and the route turns it
 * into a 403. A plain member has no activity view by design.
 *
 * A team lead is scoped to the workspaces their teams *own* — not to what their
 * team members did. Scoping on the actor would expose a member's work in every
 * other team they belong to, because no event carries a team tag to filter on.
 * Scoping on the workspace removes that disclosure by construction.
 */
export async function resolveActivityScope(
  db: Knex,
  userId: string,
): Promise<ActivityScope | null> {
  if (await isPlatformAdmin(db, userId)) {
    return { kind: 'platform' };
  }

  const teamIds = await leadTeamIds(db, userId);
  if (!teamIds.length) {
    return null;
  }

  // `workspaces.teamId` is the only marker of team ownership. `visibility` is
  // NOT a substitute: a workspace shared with selected people also carries
  // visibility 'team' while belonging to no team, and scoping on it would hand a
  // lead workspaces their team does not own.
  const rows = await db('workspaces')
    .whereIn('teamId', teamIds)
    .select('id');

  return {
    kind: 'teams',
    teamIds,
    workspaceIds: rows.map((row: { id: string }) => String(row.id)),
  };
}

type RawRow = {
  id: string;
  at: Date | string;
  actorName: string | null;
  action: string;
  resourceType: string;
  filePath: string | null;
  workspaceName: string | null;
};

const toIso = (value: Date | string): string => (
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()
);

export type ActivityPageRequest = {
  /** 1-based. */
  page?: number;
  /**
   * Upper time bound for the whole paging session, echoed back as `anchor`.
   *
   * Without it, offset paging drifts: an event recorded between page 1 and page
   * 2 shifts every later row down one, so the reader sees an item twice and
   * misses another. Pinning the session to a fixed instant makes the result set
   * stable, which is also what makes OFFSET correct here even when several
   * events share a timestamp.
   */
  before?: string;
};

export type ActivityPage = {
  items: ActivityItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Pass back as `before` to keep paging over the same stable result set. */
  anchor: string;
  /** Oldest instant this feed will reach. */
  since: string;
};

export type ActivityWindow = {
  page: number;
  offset: number;
  /** Upper bound, inclusive. */
  anchor: Date;
  /** Lower bound, inclusive. */
  since: Date;
  /** Rows each branch must fetch for the merge to be correct. */
  fetchDepth: number;
};

/**
 * Page number and time bounds for one request. Pure, so the clamping and the
 * fallbacks can be tested without a database.
 */
export function resolveActivityWindow(
  request: ActivityPageRequest = {},
  now: number = Date.now(),
): ActivityWindow {
  const requestedPage = Math.trunc(Number(request.page)) || 1;
  const page = Math.min(Math.max(1, requestedPage), MAX_ACTIVITY_PAGE);
  const offset = (page - 1) * ACTIVITY_PAGE_SIZE;

  const parsedAnchor = request.before ? Date.parse(request.before) : Number.NaN;
  // An unparseable or future anchor falls back to now rather than erroring: a
  // stale or hand-edited bookmark should show the current feed, not a failure.
  const anchorMs = Number.isNaN(parsedAnchor) ? now : Math.min(parsedAnchor, now);

  return {
    page,
    offset,
    anchor: new Date(anchorMs),
    since: new Date(anchorMs - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000),
    // One extra row so "is there another page" is answered by evidence rather
    // than guessed from a full page.
    fetchDepth: offset + ACTIVITY_PAGE_SIZE + 1,
  };
}

/**
 * One page of scoped events, newest first.
 *
 * Each branch is ordered and limited before the union so neither audit table is
 * scanned in full, then the merged set is re-sorted and sliced. Fetching
 * `offset + pageSize + 1` per branch is what makes the merge correct: the true
 * global top N rows are always a subset of the union of each branch's top N.
 */
export async function listRecentActivity(
  db: Knex,
  scope: ActivityScope,
  request: ActivityPageRequest = {},
): Promise<ActivityPage> {
  const pageSize = ACTIVITY_PAGE_SIZE;
  const { page, offset, anchor, since, fetchDepth } = resolveActivityWindow(request);

  const isPlatform = scope.kind === 'platform';
  const workspaceIds = scope.kind === 'teams' ? scope.workspaceIds : [];
  const teamIds = scope.kind === 'teams' ? scope.teamIds : [];

  // A lead whose teams own no workspaces must see nothing. An empty `whereIn`
  // is the dangerous case: some builders drop an empty predicate and return
  // every row, so the team branches are skipped outright rather than relying on
  // that behaviour.
  const hasWorkspaceScope = isPlatform || workspaceIds.length > 0;
  const hasTeamScope = isPlatform || teamIds.length > 0;

  // `resourceId` is varchar and holds a different kind of value per resource
  // type — a uuid for a workspace but an integer file id for a file. Casting the
  // column to uuid throws as soon as the planner meets a file row, so the
  // known-uuid side is compared as text instead.
  const workspaceIdsAsText = workspaceIds.map((id) => String(id));
  const teamIdsAsText = teamIds.map((id) => String(id));

  const auditBase = () => db('audit_events as a')
    .leftJoin('users as u', 'a.actorUserId', 'u.id')
    .select(
      'a.id as id',
      'a.createdAt as at',
      'u.displayName as actorName',
      'a.action as action',
      'a.resourceType as resourceType',
      db.raw('a.metadata->>\'filePath\' as "filePath"'),
      db.raw('NULL::text as "workspaceName"'),
    )
    .where('a.createdAt', '<=', anchor)
    .andWhere('a.createdAt', '>=', since)
    .orderBy('a.createdAt', 'desc')
    .limit(fetchDepth);

  const queries: Array<Promise<RawRow[]>> = [];

  if (isPlatform) {
    queries.push(auditBase() as unknown as Promise<RawRow[]>);
  } else {
    if (hasWorkspaceScope) {
      queries.push(
        auditBase()
          .where('a.resourceType', 'workspace')
          .whereIn('a.resourceId', workspaceIdsAsText) as unknown as Promise<RawRow[]>,
      );
      queries.push(
        auditBase()
          .where('a.resourceType', 'file')
          // `whereIn` cannot take a raw column expression, and the jsonb field has
          // to be compared as text, so this uses ANY over an explicit text array.
          .whereRaw("a.metadata->>'workspaceId' = ANY(?::text[])", [workspaceIdsAsText]) as unknown as Promise<RawRow[]>,
      );
    }
    if (hasTeamScope) {
      queries.push(
        auditBase()
          .where('a.resourceType', 'team')
          .whereIn('a.resourceId', teamIdsAsText) as unknown as Promise<RawRow[]>,
      );
    }
  }

  const fileAudit = db('file_audit_events as f')
    .leftJoin('workspaces as w', 'w.id', 'f.workspaceId')
    .leftJoin('users as fu', 'fu.id', 'f.actorUserId')
    .select(
      'f.id as id',
      'f.occurredAt as at',
      // `actorDisplayName` is denormalized on the row but is null on every row
      // written so far, so the live user record is the real source. Falling back
      // to it alone would attribute every human action to "System".
      db.raw('COALESCE(fu."displayName", f."actorDisplayName") as "actorName"'),
      'f.eventType as action',
      db.raw("'file' as \"resourceType\""),
      'f.filePath as filePath',
      'w.name as workspaceName',
    )
    .where('f.occurredAt', '<=', anchor)
    .andWhere('f.occurredAt', '>=', since)
    .orderBy('f.occurredAt', 'desc')
    .limit(fetchDepth);

  if (isPlatform) {
    queries.push(fileAudit as unknown as Promise<RawRow[]>);
  } else if (hasWorkspaceScope) {
    queries.push(fileAudit.whereIn('f.workspaceId', workspaceIds) as unknown as Promise<RawRow[]>);
  }

  const results = await Promise.all(queries);

  const merged = results
    .flat()
    .map((row) => {
      const at = toIso(row.at);
      const described = describeActivityEvent({
        action: row.action,
        resourceType: row.resourceType,
        filePath: row.filePath,
        workspaceName: row.workspaceName,
      });
      return {
        id: `${row.resourceType}:${row.id}`,
        at,
        // A null actor is a system-performed event, not a defect. Resource
        // scoping means these now reach a lead when they happen in their
        // workspace, which is the point of recording them.
        actorName: row.actorName || 'System',
        action: row.action,
        title: described.title,
        meta: described.meta,
      };
    })
    .filter((item) => !Number.isNaN(Date.parse(item.at)))
    // Ties on `at` are common — a single commit stamps many file events with the
    // same instant — so the id breaks them. Without a total order the slice
    // boundary is arbitrary and a row can repeat across pages.
    .sort((left, right) => {
      const byTime = Date.parse(right.at) - Date.parse(left.at);
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });

  return {
    items: merged.slice(offset, offset + pageSize),
    page,
    pageSize,
    hasMore: merged.length > offset + pageSize,
    anchor: anchor.toISOString(),
    since: since.toISOString(),
  };
}

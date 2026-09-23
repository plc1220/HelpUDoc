import type { Knex } from 'knex';
import { isPlatformAdmin, leadTeamIds } from './governance/teamRoles';
import { describeActivityEvent, humanizeAction } from '../lib/activityLabels';

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

  // A grant is the marker of team reach. `visibility` is NOT a substitute: a
  // workspace shared with selected people also carries visibility 'team' while
  // no team can reach it, and scoping on it would hand a lead workspaces their
  // team has nothing to do with.
  //
  // Note this is reach, not ownership. A workspace granted to two teams appears
  // in both leads' feeds — which follows from grants being the only source of
  // truth, and is wider than the single owning team this used to mean.
  //
  // `distinct` matters: a lead of two teams both granted the same workspace
  // would otherwise see it listed twice.
  const rows = await db('workspace_team_grants')
    .whereIn('teamId', teamIds)
    .distinct('workspaceId as id');

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

/**
 * Narrowing applied on top of the caller's scope, never instead of it.
 *
 * Every filter is an extra predicate inside the already-scoped branch queries.
 * A lead filtering by actor therefore sees that person's actions *in their
 * team's workspaces only* — the scope decides what is visible and a filter can
 * only subtract from it. Widening is not expressible here by construction.
 */
export type ActivityFilters = {
  actorId?: string;
  workspaceId?: string;
  action?: string;
};

export type FilteredWorkspaceScope = {
  /** Workspace ids the audit branches may query. Empty means: run no branch. */
  workspaceIds: string[];
  /** Team events belong to no workspace, so a workspace filter excludes them. */
  includeTeamBranch: boolean;
};

/**
 * Intersect a workspace filter with the scope the gate already resolved.
 *
 * The security property of this whole feature lives here: a filter subtracts
 * and can never add. Naming a workspace outside scope yields an empty list —
 * which the caller must treat as "run no branch", not as "no predicate" — so
 * the request returns nothing rather than reaching past the scope.
 */
export function resolveFilteredWorkspaceScope(
  scope: ActivityScope,
  workspaceFilter: string | null,
): FilteredWorkspaceScope {
  const filter = String(workspaceFilter || '').trim() || null;
  if (scope.kind === 'platform') {
    return {
      workspaceIds: filter ? [filter] : [],
      includeTeamBranch: !filter,
    };
  }
  const inScope = scope.workspaceIds.map(String);
  return {
    workspaceIds: filter ? inScope.filter((id) => id === filter) : inScope,
    includeTeamBranch: !filter,
  };
}

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
  filters: ActivityFilters = {},
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

  // Normalized once. An empty string from a query param must read as "no
  // filter", not as a filter matching nothing.
  const actorId = String(filters.actorId || '').trim() || null;
  const workspaceFilter = String(filters.workspaceId || '').trim() || null;
  const actionFilter = String(filters.action || '').trim() || null;

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
    // Applied in the base rather than per branch: a branch that forgot one
    // would quietly return unfiltered rows into the merge.
    .modify((query) => {
      if (actorId) query.andWhere('a.actorUserId', actorId);
      if (actionFilter) query.andWhere('a.action', actionFilter);
    })
    .orderBy('a.createdAt', 'desc')
    .limit(fetchDepth);

  const queries: Array<Promise<RawRow[]>> = [];

  const { workspaceIds: auditWorkspaceIds, includeTeamBranch } =
    resolveFilteredWorkspaceScope(scope, workspaceFilter);
  const scopedWorkspaceIds = auditWorkspaceIds;

  if (isPlatform && !workspaceFilter) {
    queries.push(auditBase() as unknown as Promise<RawRow[]>);
  } else if (isPlatform) {
    queries.push(
      auditBase()
        .where('a.resourceType', 'workspace')
        .whereIn('a.resourceId', auditWorkspaceIds) as unknown as Promise<RawRow[]>,
    );
    queries.push(
      auditBase()
        .where('a.resourceType', 'file')
        .whereRaw("a.metadata->>'workspaceId' = ANY(?::text[])", [auditWorkspaceIds]) as unknown as Promise<RawRow[]>,
    );
  } else {
    // An empty list here means the filter named a workspace outside scope. The
    // branches are skipped rather than run with an empty `whereIn`, which some
    // builders drop entirely and turn into "every row".
    if (hasWorkspaceScope && auditWorkspaceIds.length) {
      queries.push(
        auditBase()
          .where('a.resourceType', 'workspace')
          .whereIn('a.resourceId', auditWorkspaceIds) as unknown as Promise<RawRow[]>,
      );
      queries.push(
        auditBase()
          .where('a.resourceType', 'file')
          // `whereIn` cannot take a raw column expression, and the jsonb field has
          // to be compared as text, so this uses ANY over an explicit text array.
          .whereRaw("a.metadata->>'workspaceId' = ANY(?::text[])", [auditWorkspaceIds]) as unknown as Promise<RawRow[]>,
      );
    }
    if (hasTeamScope && includeTeamBranch) {
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
    .modify((query) => {
      if (actorId) query.andWhere('f.actorUserId', actorId);
      if (actionFilter) query.andWhere('f.eventType', actionFilter);
      if (workspaceFilter) query.andWhere('f.workspaceId', workspaceFilter);
    })
    .orderBy('f.occurredAt', 'desc')
    .limit(fetchDepth);

  // The workspace predicate is already in `fileAudit`'s modify block, so the
  // platform branch needs no further narrowing.
  if (isPlatform) {
    queries.push(fileAudit as unknown as Promise<RawRow[]>);
  } else if (hasWorkspaceScope && (!workspaceFilter || scopedWorkspaceIds.length)) {
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

export type ActivityFilterOption = { id: string; label: string };

export type ActivityFilterOptions = {
  actors: ActivityFilterOption[];
  workspaces: ActivityFilterOption[];
  actions: ActivityFilterOption[];
};

/**
 * The values a caller may filter by, drawn from what their own scope can
 * already see.
 *
 * Derived from the same scope and time window as the feed rather than from the
 * full tables. A list built from every user would tell a team lead who else
 * exists on the platform, which the feed itself is careful never to do — an
 * option list is a disclosure surface just as much as a row is.
 *
 * Reads the whole window, not one page. Offering only the names visible on the
 * current page would make the filter useless for the question people actually
 * ask, which is what someone did over the past month.
 */
export async function listActivityFilterOptions(
  db: Knex,
  scope: ActivityScope,
): Promise<ActivityFilterOptions> {
  const { anchor, since } = resolveActivityWindow({});
  const isPlatform = scope.kind === 'platform';
  const workspaceIds = scope.kind === 'teams' ? scope.workspaceIds : [];
  const teamIds = scope.kind === 'teams' ? scope.teamIds : [];
  const workspaceIdsAsText = workspaceIds.map((id) => String(id));

  if (!isPlatform && !workspaceIds.length && !teamIds.length) {
    return { actors: [], workspaces: [], actions: [] };
  }

  const scopedAudit = () => {
    const query = db('audit_events as a')
      .where('a.createdAt', '<=', anchor)
      .andWhere('a.createdAt', '>=', since);
    if (isPlatform) return query;
    // Mirrors the feed's branch predicates as one OR group. If this drifts from
    // `listRecentActivity`, the filter list offers a value that returns nothing.
    return query.andWhere((grouped) => {
      if (workspaceIdsAsText.length) {
        grouped
          .orWhere((branch) => {
            branch.where('a.resourceType', 'workspace').whereIn('a.resourceId', workspaceIdsAsText);
          })
          .orWhere((branch) => {
            branch
              .where('a.resourceType', 'file')
              .whereRaw("a.metadata->>'workspaceId' = ANY(?::text[])", [workspaceIdsAsText]);
          });
      }
      if (teamIds.length) {
        grouped.orWhere((branch) => {
          branch.where('a.resourceType', 'team').whereIn('a.resourceId', teamIds.map(String));
        });
      }
    });
  };

  const scopedFileAudit = () => {
    const query = db('file_audit_events as f')
      .where('f.occurredAt', '<=', anchor)
      .andWhere('f.occurredAt', '>=', since);
    return isPlatform ? query : query.whereIn('f.workspaceId', workspaceIds);
  };

  const [auditActors, fileActors, auditActions, fileActions, workspaceRows] = await Promise.all([
    scopedAudit()
      .leftJoin('users as u', 'a.actorUserId', 'u.id')
      .whereNotNull('a.actorUserId')
      .distinct('a.actorUserId as id', 'u.displayName as label'),
    scopedFileAudit()
      .leftJoin('users as fu', 'fu.id', 'f.actorUserId')
      .whereNotNull('f.actorUserId')
      .distinct('f.actorUserId as id', 'fu.displayName as label'),
    scopedAudit().distinct('a.action as id'),
    scopedFileAudit().distinct('f.eventType as id'),
    isPlatform
      ? db('workspaces').whereIn('visibility', ['team']).select('id', 'name').orderBy('name')
      : db('workspaces').whereIn('id', workspaceIds).select('id', 'name').orderBy('name'),
  ]);

  const byId = new Map<string, string>();
  for (const row of [...auditActors, ...fileActors] as Array<{ id: string; label: string | null }>) {
    const id = String(row.id);
    // A person with no display name is still a real filter target; naming them
    // "Unknown user" beats dropping them from the list.
    if (!byId.has(id) || (!byId.get(id) && row.label)) {
      byId.set(id, String(row.label || 'Unknown user'));
    }
  }

  const actionIds = new Set<string>();
  for (const row of [...auditActions, ...fileActions] as Array<{ id: string }>) {
    if (row.id) actionIds.add(String(row.id));
  }

  return {
    actors: [...byId.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    workspaces: (workspaceRows as Array<{ id: string; name: string }>)
      .map((row) => ({ id: String(row.id), label: String(row.name) })),
    actions: [...actionIds]
      .sort()
      .map((id) => ({ id, label: humanizeAction(id) })),
  };
}

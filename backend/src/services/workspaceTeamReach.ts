import type { Knex } from 'knex';

/**
 * Detach the private drafts of people who can no longer reach the Shared
 * workspace they were linked to.
 *
 * Three call sites revoked access and then swept for orphaned drafts, and each
 * asked the same wrong question: "does this person hold a direct membership
 * row?" Absence of one was treated as "their team access is gone too", which
 * held only while a workspace could be connected to a single team. With several
 * teams, revoking one detached the drafts of everyone reaching the workspace
 * through any of the others.
 *
 * The rule is now asked once, unqualified: *can this person still reach this
 * workspace at all?* Callers must therefore **apply the revocation first**, so
 * the question is answered against a database that already reflects it. That
 * also means no caller has to pass "except this team", and none of them can get
 * that parameter wrong.
 *
 * `teamWorkspaceIds` is always an explicit list. An empty one detaches nothing —
 * deliberately, because a revocation that touched no workspace must not be able
 * to widen into "every workspace".
 *
 * Returns the private workspace ids it detached, so a caller can log them.
 */
export async function detachUnreachablePublicationLinks(
  tx: Knex.Transaction,
  scope: { teamWorkspaceIds: string[]; userId?: string },
): Promise<string[]> {
  const teamWorkspaceIds = Array.from(new Set(scope.teamWorkspaceIds.filter(Boolean)));
  if (!teamWorkspaceIds.length) return [];

  let query = tx('workspace_publication_links as link')
    .whereIn('link.teamWorkspaceId', teamWorkspaceIds)
    // Re-detaching an already detached link would reset `detachedAt` to now and
    // lose when access actually ended.
    .whereNot('link.status', 'detached')
    .whereNotExists(function stillHasDirectAccess() {
      this.select(tx.raw('1'))
        .from('workspace_members as direct')
        .whereRaw('direct."workspaceId" = link."teamWorkspaceId"')
        .whereRaw('direct."userId" = link."userId"');
    })
    .whereNotExists(function stillHasTeamAccess() {
      this.select(tx.raw('1'))
        .from('workspace_team_grants as tg')
        .join('group_members as gm', 'gm.groupId', 'tg.teamId')
        .whereRaw('tg."workspaceId" = link."teamWorkspaceId"')
        .whereRaw('gm."userId" = link."userId"');
    })
    .whereNotExists(function ownsTheWorkspace() {
      // Redundant today — an owner always holds a membership row — but it makes
      // the predicate fail towards detaching less rather than more if that ever
      // stops being true.
      this.select(tx.raw('1'))
        .from('workspaces as w')
        .whereRaw('w.id = link."teamWorkspaceId"')
        .whereRaw('w."ownerId" = link."userId"');
    })
    .select('link.privateWorkspaceId');
  if (scope.userId) query = query.andWhere('link.userId', scope.userId);

  const links = await query as Array<{ privateWorkspaceId: string }>;
  const privateWorkspaceIds = links.map((link) => String(link.privateWorkspaceId));
  if (!privateWorkspaceIds.length) return [];

  await tx('workspace_publication_links')
    .whereIn('privateWorkspaceId', privateWorkspaceIds)
    .update({
      status: 'detached',
      detachedAt: tx.fn.now(),
      reconnectToken: null,
      updatedAt: tx.fn.now(),
    });
  return privateWorkspaceIds;
}

/** Every workspace a team currently reaches. Capture before revoking. */
export async function workspaceIdsGrantedToTeam(
  tx: Knex.Transaction,
  teamId: string,
): Promise<string[]> {
  const rows = await tx('workspace_team_grants').where({ teamId }).select('workspaceId');
  return rows.map((row: any) => String(row.workspaceId));
}

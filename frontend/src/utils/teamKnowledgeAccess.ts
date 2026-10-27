type KnowledgeBaseLike = {
  id: string;
  name: string;
  status: string;
  ownerTeamId?: string | null;
};

/**
 * Published bases owned by *teamId*. Ownership gives the team access with no
 * grant row (`resolveAccessibleKnowledgeBaseIds` reads `ownerTeamId`), but the
 * team panel listed grant rows only, so a team's own base looked unassigned.
 */
export function ownedKnowledgeBaseIds(bases: KnowledgeBaseLike[], teamId: string): string[] {
  if (!teamId) return [];
  return bases
    .filter((base) => base.status === 'published' && base.ownerTeamId === teamId)
    .map((base) => base.id);
}

/** Selector options. Owned bases are locked on: unticking them could not revoke access. */
export function teamKnowledgeOptions(bases: KnowledgeBaseLike[], teamId: string) {
  const owned = new Set(ownedKnowledgeBaseIds(bases, teamId));
  return bases
    .filter((base) => base.status === 'published')
    .map((base) => (owned.has(base.id)
      ? { value: base.id, label: `${base.name} (owned by this team)`, disabled: true }
      : { value: base.id, label: base.name }));
}

/** What the selector shows as ticked: granted bases plus owned ones. */
export function displayedKnowledgeBaseIds(grantIds: string[], ownedIds: string[]): string[] {
  return Array.from(new Set([...grantIds, ...ownedIds]));
}

/**
 * Grant ids to keep after a selector change. Owned bases are never added as
 * grants (that would duplicate `ownerTeamId`), and a grant row an owned base
 * already has is left as it was, so the selector cannot change it either way.
 */
export function grantIdsFromSelection(values: string[], previousGrantIds: string[], ownedIds: string[]): string[] {
  const owned = new Set(ownedIds);
  const keptOwnedGrants = previousGrantIds.filter((id) => owned.has(id));
  return Array.from(new Set([...values.filter((id) => !owned.has(id)), ...keptOwnedGrants]));
}

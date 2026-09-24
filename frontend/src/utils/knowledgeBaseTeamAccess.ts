import type { KnowledgeBaseSummary } from '../services/knowledgeBaseApi';

/**
 * Which teams can reach a knowledge base, as the governance UI reports it.
 *
 * A base reaches two kinds of team. Its owning team reaches it through
 * `ownerTeamId` alone — `canView`, the catalogue's `entitledTo` and
 * `resolveAccessibleKnowledgeBaseIds` all special-case it — and every other team
 * reaches it through a row in `knowledge_base_group_grants`.
 *
 * The UI used to count only the second kind, so a base its own team was already
 * reading reported "Team access (0) — Not shared with any team yet". Team Leads
 * read that as a base that had failed to reach anyone, and asked why creating it
 * had not shared it. Counted here rather than inline so that reading cannot
 * quietly return.
 */

export const knowledgeBaseTeamAccessCount = (
  base: Pick<KnowledgeBaseSummary, 'ownerTeamId'>,
  grantCount: number,
): number => Math.max(0, grantCount) + (base.ownerTeamId ? 1 : 0);

/**
 * Whether the base can actually be used in chat yet.
 *
 * A draft is invisible to the agent for everyone, the owning team included,
 * because `resolveAccessibleKnowledgeBaseIds` only returns published bases. That
 * is the step most often missing when a lead reports a new base "not working",
 * and it is not a sharing problem, so the UI has to say which one it is.
 */
export const isKnowledgeBaseUsable = (
  base: Pick<KnowledgeBaseSummary, 'status'>,
): boolean => base.status === 'published';

/**
 * Which bases a governance tab lists.
 *
 * The two tabs ask opposite questions. Catalog asks "what can I use", and a
 * draft is usable by nobody — `resolveAccessibleKnowledgeBaseIds` returns
 * published bases only — so listing one there offers something that cannot be
 * referenced. My knowledge bases asks "what am I curating", so it keeps drafts;
 * without them a Team Lead has nowhere to open the base they just created, which
 * is where publishing happens.
 *
 * Both halves live here so collapsing them into one filter has to be deliberate.
 */
export const selectVisibleKnowledgeBases = <
  T extends Pick<KnowledgeBaseSummary, 'status' | 'ownerTeamId' | 'name' | 'slug' | 'ownerTeamName'>,
>(input: {
  bases: readonly T[];
  tab: 'catalog' | 'manage';
  ledTeamIds: readonly string[];
  query?: string;
}): T[] => {
  const scoped = input.tab === 'manage'
    ? input.bases.filter((base) => Boolean(base.ownerTeamId) && input.ledTeamIds.includes(String(base.ownerTeamId)))
    : input.bases.filter((base) => isKnowledgeBaseUsable(base));
  const query = (input.query || '').trim().toLowerCase();
  if (!query) {
    return [...scoped];
  }
  return scoped.filter((base) =>
    base.name.toLowerCase().includes(query)
    || base.slug.toLowerCase().includes(query)
    || (base.ownerTeamName || '').toLowerCase().includes(query));
};

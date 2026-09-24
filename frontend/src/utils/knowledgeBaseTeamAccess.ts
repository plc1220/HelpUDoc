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

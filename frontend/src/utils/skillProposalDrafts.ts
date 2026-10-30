/**
 * Save a skill the agent proposed in chat as the user's private draft.
 *
 * The agent cannot write to the shared catalog (`/skills/` is read-only to it).
 * It returns each skill through `propose_skill`, and the workspace shows it as a
 * card. Saving goes through the same two governance calls the Skill Creator uses,
 * under the user's own session, so the draft has an owner and goes through review.
 *
 * The API calls are passed in so this module stays free of the API client and
 * can run under `node --test`.
 */
import type { SkillProposal } from '@helpudoc/contracts/types';

type DraftRef = { id: string; draftRevision: number };

export type SkillBuilderTextAction =
  | { type: 'create_skill'; skillId: string; name?: string; description?: string }
  | { type: 'upsert_text'; skillId: string; path: string; content: string; encoding: 'utf-8' };

export type SkillProposalDraftApi<D extends DraftRef> = {
  createSkillDraft: (input: { proposalType: 'new' }) => Promise<D>;
  applySkillBuilderDraftActions: (draftId: string, revision: number, actions: SkillBuilderTextAction[]) => Promise<D>;
  deleteSkillDraft: (draftId: string, revision: number) => Promise<unknown>;
};

/** The action batch POST /skills/drafts/:id/builder-actions accepts. */
export const proposalToBuilderActions = (proposal: SkillProposal): SkillBuilderTextAction[] => [
  { type: 'create_skill', skillId: proposal.skillId, name: proposal.name, description: proposal.description },
  ...proposal.files.map((file): SkillBuilderTextAction => ({
    type: 'upsert_text',
    skillId: proposal.skillId,
    path: file.path,
    content: file.content,
    encoding: 'utf-8',
  })),
];

/**
 * Create a draft and fill it. If filling fails, the empty draft is deleted, so a
 * failed save does not leave an "Untitled" draft in the user's list.
 */
export const saveSkillProposalAsDraft = async <D extends DraftRef>(
  proposal: SkillProposal,
  api: SkillProposalDraftApi<D>,
): Promise<D> => {
  const created = await api.createSkillDraft({ proposalType: 'new' });
  try {
    return await api.applySkillBuilderDraftActions(created.id, created.draftRevision, proposalToBuilderActions(proposal));
  } catch (error) {
    await api.deleteSkillDraft(created.id, created.draftRevision).catch(() => undefined);
    throw error;
  }
};

/** Where the saved draft opens: Skill Governance with its editor. */
export const skillDraftHref = (draftId: string): string => `/skills?draft=${encodeURIComponent(draftId)}`;

// Which proposals this browser already saved, so a reload shows "Saved" instead of
// inviting a second, duplicate draft. A convenience only: if storage is unavailable
// the card simply offers to save again.
const STORAGE_KEY = 'helpudoc-saved-skill-proposals';
const MAX_REMEMBERED = 200;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export const readSavedProposalDrafts = (storage: StorageLike | null = defaultStorage()): Record<string, string> => {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
};

export const rememberSavedProposalDraft = (
  proposalId: string,
  draftId: string,
  storage: StorageLike | null = defaultStorage(),
): void => {
  try {
    const entries = Object.entries({ ...readSavedProposalDrafts(storage), [proposalId]: draftId });
    storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries.slice(-MAX_REMEMBERED))));
  } catch {
    // Storage full or blocked: the save itself succeeded.
  }
};

/** Add a proposal from the live stream, ignoring a replayed event. */
export const appendSkillProposal = (current: SkillProposal[] | undefined, proposal: SkillProposal): SkillProposal[] => {
  const list = current || [];
  return list.some((item) => item.proposalId === proposal.proposalId) ? list : [...list, proposal];
};

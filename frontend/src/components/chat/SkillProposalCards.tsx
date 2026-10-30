import { useCallback, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import type { SkillProposal } from '@helpudoc/contracts/types';
import {
  applySkillBuilderDraftActions,
  createSkillDraft,
  deleteSkillDraft,
} from '../../services/governanceApi';
import type { SkillBuilderAction } from '../../services/settingsApi';
import {
  readSavedProposalDrafts,
  rememberSavedProposalDraft,
  saveSkillProposalAsDraft,
  skillDraftHref,
  type SkillProposalDraftApi,
} from '../../utils/skillProposalDrafts';

type SaveState = { status: 'idle' | 'saving' | 'saved' | 'error'; draftId?: string; error?: string };

const draftApi: SkillProposalDraftApi<{ id: string; draftRevision: number }> = {
  createSkillDraft,
  applySkillBuilderDraftActions: (draftId, revision, actions) =>
    applySkillBuilderDraftActions(draftId, revision, actions as SkillBuilderAction[]),
  deleteSkillDraft,
};

const languageForPath = (path: string): string => {
  if (/\.mdx?$/i.test(path)) return 'markdown';
  if (/\.py$/i.test(path)) return 'python';
  if (/\.ya?ml$/i.test(path)) return 'yaml';
  if (/\.json$/i.test(path)) return 'json';
  if (/\.(c|m)?js$/i.test(path)) return 'javascript';
  return 'plaintext';
};

const openDraft = (draftId: string) => {
  window.open(skillDraftHref(draftId), '_blank', 'noopener');
};

const initialStates = (proposals: SkillProposal[]): Record<string, SaveState> => {
  const saved = readSavedProposalDrafts();
  return Object.fromEntries(proposals
    .filter((proposal) => saved[proposal.proposalId])
    .map((proposal) => [proposal.proposalId, { status: 'saved', draftId: saved[proposal.proposalId] }]));
};

/**
 * Skills the agent proposed with `propose_skill`. Each saves as the user's private
 * draft; nothing reaches the shared catalog until a reviewer approves it.
 */
const SkillProposalCards = ({ proposals }: { proposals: SkillProposal[] }) => {
  const [states, setStates] = useState<Record<string, SaveState>>(() => initialStates(proposals));

  const save = useCallback(async (proposal: SkillProposal) => {
    setStates((current) => ({ ...current, [proposal.proposalId]: { status: 'saving' } }));
    try {
      const draft = await saveSkillProposalAsDraft(proposal, draftApi);
      rememberSavedProposalDraft(proposal.proposalId, draft.id);
      setStates((current) => ({ ...current, [proposal.proposalId]: { status: 'saved', draftId: draft.id } }));
    } catch (error) {
      setStates((current) => ({
        ...current,
        [proposal.proposalId]: { status: 'error', error: error instanceof Error ? error.message : 'Failed to save the private draft' },
      }));
    }
  }, []);

  const unsaved = proposals.filter((proposal) => {
    const status = states[proposal.proposalId]?.status;
    return status !== 'saved' && status !== 'saving';
  });

  // One at a time: each save notifies the skill menu, and parallel saves would
  // refetch it once per skill.
  const saveAll = async () => {
    for (const proposal of unsaved) {
      await save(proposal);
    }
  };

  return (
    <VStack gap={2}>
      <HStack gap={2} hAlign="between" vAlign="center" wrap="wrap">
        <Text type="label">
          {proposals.length === 1 ? '1 skill proposed' : `${proposals.length} skills proposed`}
        </Text>
        {proposals.length > 1 && unsaved.length ? (
          <Button
            label={unsaved.length === proposals.length ? 'Save all as private drafts' : `Save ${unsaved.length} remaining`}
            size="sm"
            clickAction={saveAll}
          />
        ) : null}
      </HStack>
      {proposals.map((proposal) => {
        const state = states[proposal.proposalId] || { status: 'idle' };
        return (
          <Card key={proposal.proposalId} padding={3}>
            <VStack gap={2}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Heading level={4}>{proposal.name}</Heading>
                <Token label={proposal.skillId} size="sm" color="gray" />
                {state.status === 'saved' ? <Token label="Private draft" size="sm" color="green" /> : null}
              </HStack>
              {proposal.description ? <Text type="supporting">{proposal.description}</Text> : null}
              <Collapsible
                defaultIsOpen={false}
                trigger={<Text type="supporting">{`Preview ${proposal.files.length} ${proposal.files.length === 1 ? 'file' : 'files'}`}</Text>}
              >
                <VStack gap={2}>
                  {proposal.files.map((file) => (
                    <CodeBlock
                      key={file.path}
                      code={file.content}
                      title={file.path}
                      language={languageForPath(file.path)}
                      width="100%"
                      size="sm"
                      maxHeight={280}
                      isWrapped
                    />
                  ))}
                </VStack>
              </Collapsible>
              {state.status === 'error' ? (
                <Banner status="error" title="Not saved" description={state.error} />
              ) : null}
              <HStack gap={2} vAlign="center" wrap="wrap">
                {state.status === 'saved' && state.draftId ? (
                  <>
                    <Button label="Open draft" size="sm" onClick={() => openDraft(state.draftId as string)} />
                    <Text type="supporting">
                      Runs in your private workspaces now. Submit it for review from the draft to share it with a team.
                    </Text>
                  </>
                ) : (
                  <Button
                    label={state.status === 'error' ? 'Try again' : 'Save as private draft'}
                    variant="primary"
                    size="sm"
                    isLoading={state.status === 'saving'}
                    clickAction={() => save(proposal)}
                  />
                )}
              </HStack>
            </VStack>
          </Card>
        );
      })}
      <Text type="supporting">
        Team workspaces can use a skill only after review approves it.
      </Text>
    </VStack>
  );
};

export default SkillProposalCards;

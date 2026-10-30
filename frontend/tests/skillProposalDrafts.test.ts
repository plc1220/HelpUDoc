import assert from 'node:assert/strict';
import test from 'node:test';

import type { SkillProposal } from '@helpudoc/contracts/types';
import {
  appendSkillProposal,
  proposalToBuilderActions,
  readSavedProposalDrafts,
  rememberSavedProposalDraft,
  saveSkillProposalAsDraft,
  skillDraftHref,
} from '../src/utils/skillProposalDrafts.ts';

const proposal: SkillProposal = {
  proposalId: 'p-1',
  skillId: 'contract-fairness',
  name: 'Contract fairness',
  description: 'Identify clauses that create an imbalance.',
  files: [
    { path: 'SKILL.md', content: '---\nname: Contract fairness\ndescription: x\n---\n' },
    { path: 'references/checklist.md', content: '- Unilateral variation\n' },
  ],
};

const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

test('a proposal becomes one create_skill and one upsert_text per file', () => {
  assert.deepEqual(proposalToBuilderActions(proposal), [
    { type: 'create_skill', skillId: 'contract-fairness', name: 'Contract fairness', description: 'Identify clauses that create an imbalance.' },
    { type: 'upsert_text', skillId: 'contract-fairness', path: 'SKILL.md', content: proposal.files[0].content, encoding: 'utf-8' },
    { type: 'upsert_text', skillId: 'contract-fairness', path: 'references/checklist.md', content: proposal.files[1].content, encoding: 'utf-8' },
  ]);
});

test('saving creates a draft and fills it with the proposal', async () => {
  const calls: string[] = [];
  const saved = await saveSkillProposalAsDraft(proposal, {
    createSkillDraft: async (input) => { calls.push(`create:${input.proposalType}`); return { id: 'd-1', draftRevision: 0 }; },
    applySkillBuilderDraftActions: async (id, revision, actions) => {
      calls.push(`apply:${id}:${revision}:${actions.length}`);
      return { id, draftRevision: 1 };
    },
    deleteSkillDraft: async () => { calls.push('delete'); },
  });

  assert.deepEqual(saved, { id: 'd-1', draftRevision: 1 });
  assert.deepEqual(calls, ['create:new', 'apply:d-1:0:3']);
});

test('a failed fill deletes the empty draft and reports the error', async () => {
  const deleted: string[] = [];
  await assert.rejects(
    saveSkillProposalAsDraft(proposal, {
      createSkillDraft: async () => ({ id: 'd-2', draftRevision: 0 }),
      applySkillBuilderDraftActions: async () => { throw new Error('SKILL.md frontmatter must have a description'); },
      deleteSkillDraft: async (id) => { deleted.push(id); },
    }),
    /frontmatter/,
  );
  assert.deepEqual(deleted, ['d-2']);
});

test('saved proposals are remembered so a reload does not offer a duplicate draft', () => {
  const storage = memoryStorage();
  assert.deepEqual(readSavedProposalDrafts(storage), {});
  rememberSavedProposalDraft('p-1', 'd-1', storage);
  rememberSavedProposalDraft('p-2', 'd-2', storage);
  assert.deepEqual(readSavedProposalDrafts(storage), { 'p-1': 'd-1', 'p-2': 'd-2' });
  assert.deepEqual(readSavedProposalDrafts({ getItem: () => 'not json', setItem: () => undefined }), {});
  assert.doesNotThrow(() => rememberSavedProposalDraft('p-3', 'd-3', { getItem: () => null, setItem: () => { throw new Error('full'); } }));
});

test('a replayed stream event does not add the proposal twice', () => {
  const once = appendSkillProposal(undefined, proposal);
  assert.equal(appendSkillProposal(once, proposal), once);
  assert.equal(appendSkillProposal(once, { ...proposal, proposalId: 'p-2' }).length, 2);
});

test('the draft link opens Skill Governance on that draft', () => {
  assert.equal(skillDraftHref('d 1'), '/skills?draft=d%201');
});

test('the activity log shows one line for a proposal instead of its JSON', async () => {
  const { translateToolChunkForStorage } = await import('../src/utils/toolActivitySummary.ts');
  const output = JSON.stringify({ type: 'helpudoc.skill_proposal/1', ...proposal });
  assert.equal(translateToolChunkForStorage(output, 'propose_skill'), 'Proposed skill contract-fairness (2 files)');
  assert.match(translateToolChunkForStorage('Skill proposal rejected. Fix these', 'propose_skill') || '', /rejected/);
});

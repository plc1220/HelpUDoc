import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSkillProposal,
  skillProposalToolSummary,
} from '../src/services/agent-runs/lifecycle';
import { mergeRunOwnedAgentMetadata } from '../src/services/conversationService';

// The shape agent/helpudoc_agent/tools/workspace/builtins/skill_proposals.py returns.
const toolOutput = {
  type: 'helpudoc.skill_proposal/1',
  proposalId: '6c0f2a52-8a0b-4c55-9f4e-1d3f6a0b2c11',
  skillId: 'contract-fairness',
  name: 'Contract fairness',
  description: 'Identify clauses that create an imbalance.',
  files: [
    { path: 'SKILL.md', content: '---\nname: Contract fairness\ndescription: x\n---\n' },
    { path: 'references/checklist.md', content: '- Unilateral variation\n' },
  ],
  actions: [{ type: 'create_skill', skillId: 'contract-fairness' }],
  note: 'Shown to the user as a card.',
};

test('normalizeSkillProposal reads the propose_skill output from its JSON text', () => {
  const proposal = normalizeSkillProposal(JSON.stringify(toolOutput));

  assert.equal(proposal?.proposalId, toolOutput.proposalId);
  assert.equal(proposal?.skillId, 'contract-fairness');
  assert.equal(proposal?.name, 'Contract fairness');
  assert.deepEqual(proposal?.files, toolOutput.files);
  assert.equal(typeof proposal?.timestamp, 'string');
  // The card rebuilds the actions from files; storing both doubles the message.
  assert.equal('actions' in (proposal || {}), false);
  assert.equal('note' in (proposal || {}), false);
});

test('normalizeSkillProposal ignores a rejection and other tool output', () => {
  assert.equal(normalizeSkillProposal('Skill proposal rejected. Fix these and call propose_skill again:\n- x'), null);
  assert.equal(normalizeSkillProposal({ ...toolOutput, type: 'something_else' }), null);
  assert.equal(normalizeSkillProposal({ ...toolOutput, proposalId: '' }), null);
  assert.equal(normalizeSkillProposal({ ...toolOutput, files: [{ path: 'references/a.md', content: 'x' }] }), null);
});

test('skillProposalToolSummary keeps the proposal JSON out of the activity log', () => {
  const proposal = normalizeSkillProposal(toolOutput);
  assert.ok(proposal);
  assert.equal(skillProposalToolSummary(proposal), 'Proposed skill contract-fairness (2 files)');
});

test('a sparse recovery snapshot keeps the proposals the live worker saved', () => {
  const proposal = normalizeSkillProposal(toolOutput);
  const merged = mergeRunOwnedAgentMetadata(
    'Here are the skills.',
    'Completed successfully.',
    { runId: 'run-1', skillProposals: [proposal] },
    { runId: 'run-1', status: 'completed' },
  );
  assert.deepEqual(merged?.skillProposals, [proposal]);
});

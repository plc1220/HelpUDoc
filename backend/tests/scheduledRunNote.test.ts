import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEDULED_RUN_NOTE, buildAgentPrompt } from '../src/services/scheduleService';

test('scheduled runs tell the agent nobody is there to answer questions', () => {
  const base = { prompt: 'Summarise new complaints', selectedSkills: [] } as any;
  assert.ok(buildAgentPrompt(base).startsWith(SCHEDULED_RUN_NOTE));
  const withSkill = buildAgentPrompt({ prompt: '/skill research weekly digest', selectedSkills: [] } as any);
  assert.ok(withSkill.includes(SCHEDULED_RUN_NOTE));
  assert.ok(withSkill.startsWith('<<<HELPUDOC_DIRECTIVE')); // the skill directive still comes first
});

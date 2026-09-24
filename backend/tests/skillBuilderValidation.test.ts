import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuilderMutation } from '../src/services/governance/skillBuilderValidation';

test('blocks fabricated MCP operation names before a builder draft is saved', async () => {
  const result = await validateBuilderMutation({ proposedSkillKey: 'email-planner', files: [{ path: 'SKILL.md', content: '---\nname: Email Planner\ndescription: Plan from email\ntools: [google-workspace.gmail_list_messages]\n---\nDiscover email operations.' }] });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.code === 'UNKNOWN_DECLARED_TOOL'));
});
test('validates a complete simple proposal and rejects duplicate or unsafe paths', async () => {
  const file = { path: 'SKILL.md', content: '---\nname: Summary\ndescription: Summarize user text\ntools: []\nmcp_servers: []\n---\nSummarize the provided text.' };
  assert.equal((await validateBuilderMutation({ proposedSkillKey: 'summary', files: [file] })).valid, true);
  await assert.rejects(validateBuilderMutation({ proposedSkillKey: 'summary', files: [file, file] }), /Duplicate/);
  await assert.rejects(validateBuilderMutation({ proposedSkillKey: 'summary', files: [{ ...file, path: '../SKILL.md' }] }));
});

test('builder save rejects invalid capabilities server-side without updating the draft', async () => {
  const { default: express } = await import('express');
  const { default: governanceRoutes } = await import('../src/api/governance');
  let updates = 0;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userContext = { userId: 'test', externalId: 'test', displayName: 'Test', isAdmin: false }; next(); });
  app.use(governanceRoutes({ updateDraft: async () => { updates++; } } as any));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address() as import('node:net').AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/skills/drafts/test/builder-actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedDraftRevision: 0, actions: [{ type: 'upsert_text', skillId: 'example', path: 'SKILL.md', content: '---\nname: Example\ndescription: Example\ntools: [invented_tool]\n---\nExample' }] }) });
    assert.equal(response.status, 422);
    assert.equal(updates, 0);
    assert.match((await response.json() as any).error, /invented_tool/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

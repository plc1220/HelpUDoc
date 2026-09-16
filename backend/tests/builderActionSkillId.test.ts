import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

// Mirrors governance.ts: every variant requires skillId, and the adapter needs the batch
// to name exactly one skill.
const inheritSkillId = (body: unknown): unknown => {
  if (!body || typeof body !== 'object') return body;
  const actions = (body as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return body;
  const stated = actions
    .map((a) => (a && typeof a === 'object' ? (a as { skillId?: unknown }).skillId : undefined))
    .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (!stated) return body;
  return {
    ...(body as Record<string, unknown>),
    actions: actions.map((a) => (
      a && typeof a === 'object' && !(a as { skillId?: unknown }).skillId
        ? { ...(a as Record<string, unknown>), skillId: stated } : a
    )),
  };
};

const schema = z.object({
  actions: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('create_skill'), skillId: z.string().min(1) }).passthrough(),
    z.object({ type: z.literal('upsert_text'), skillId: z.string().min(1), path: z.string().min(1), content: z.string() }).passthrough(),
  ])).min(1),
  expectedDraftRevision: z.number().int().nonnegative(),
});

test('a batch that states skillId once still validates', () => {
  const body = {
    expectedDraftRevision: 1,
    actions: [
      { type: 'create_skill', skillId: 'csv-to-markdown', name: 'CSV' },
      { type: 'upsert_text', path: 'SKILL.md', content: '---\nname: CSV\n---\n' },
    ],
  };
  assert.throws(() => schema.parse(body), /expected string, received undefined|invalid_type/i);
  const parsed = schema.parse(inheritSkillId(body));
  assert.equal(parsed.actions[1].skillId, 'csv-to-markdown', 'the file action inherits it');
});

test('a stated skillId is never overridden', () => {
  const body = {
    expectedDraftRevision: 0,
    actions: [
      { type: 'create_skill', skillId: 'a' },
      { type: 'upsert_text', skillId: 'b', path: 'SKILL.md', content: 'x' },
    ],
  };
  const parsed = schema.parse(inheritSkillId(body));
  assert.equal(parsed.actions[1].skillId, 'b', 'two skills must still reach the adapter to be rejected there');
});

test('nothing to inherit leaves the body alone', () => {
  const body = { expectedDraftRevision: 0, actions: [{ type: 'upsert_text', path: 'a', content: 'b' }] };
  assert.deepEqual(inheritSkillId(body), body);
});

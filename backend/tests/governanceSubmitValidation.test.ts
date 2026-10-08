import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { describeZodIssue, submitDraftSchema } from '../src/api/governance';

const issueFor = (body: unknown): z.ZodIssue => {
  const result = submitDraftSchema.safeParse(body);
  assert.equal(result.success, false);
  return (result as { error: z.ZodError }).error.issues[0];
};

test('a short version names the field and the expected format', () => {
  const described = describeZodIssue(issueFor({ semanticVersion: '1.0', expectedDraftRevision: 5 }));
  assert.equal(described.field, 'semanticVersion');
  assert.equal(described.message, 'Proposed version: Use major.minor.patch, for example 1.0.0.');
});

test('five characters that are not a version are rejected', () => {
  assert.equal(issueFor({ semanticVersion: 'abcde', expectedDraftRevision: 5 }).path[0], 'semanticVersion');
});

test('a valid version passes, trimmed', () => {
  const result = submitDraftSchema.parse({ semanticVersion: ' 1.0.1 ', expectedDraftRevision: 5 });
  assert.equal(result.semanticVersion, '1.0.1');
});

test('an unlabelled field falls back to its path', () => {
  const described = describeZodIssue({ code: 'custom', path: ['actions', 0, 'path'], message: 'Required', input: undefined } as z.ZodIssue);
  assert.equal(described.message, 'actions.0.path: Required');
});

test('an issue without a path keeps the plain message', () => {
  assert.deepEqual(describeZodIssue({ code: 'custom', path: [], message: 'Bad body', input: undefined } as z.ZodIssue), { message: 'Bad body' });
});

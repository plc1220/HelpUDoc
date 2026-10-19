import assert from 'node:assert/strict';
import test from 'node:test';

import { knowledgeReduceTimeoutMs } from '../src/services/agentService';
import {
  describeAgentCallFailure,
  describeIngestionFailure,
} from '../src/services/knowledgeIngestionService';

const axiosTimeout = (timeout: number) => Object.assign(new Error(`timeout of ${timeout}ms exceeded`), {
  code: 'ECONNABORTED',
  config: { timeout },
});

test('a timeout reads as a long step, not a crash', () => {
  assert.equal(describeAgentCallFailure(axiosTimeout(300_000)), 'the step took longer than 5 minutes and was stopped');
  assert.equal(
    describeIngestionFailure(axiosTimeout(300_000), 'reducing'),
    'The consolidation step failed: the step took longer than 5 minutes and was stopped.',
  );
});

test("the agent's own reason is kept", () => {
  const error = Object.assign(new Error('Request failed with status code 422'), {
    response: { data: { detail: 'Reduce result has no concepts' } },
  });
  assert.equal(
    describeIngestionFailure(error, 'enriching'),
    'The concept-building step failed: Request failed with status code 422: Reduce result has no concepts.',
  );
  assert.equal(describeIngestionFailure(new Error('disk full'), null), 'The build failed: disk full.');
});

test('reduce gets 15 minutes by default and never less than one window', () => {
  const previous = process.env.KNOWLEDGE_REDUCE_TIMEOUT_MS;
  try {
    delete process.env.KNOWLEDGE_REDUCE_TIMEOUT_MS;
    assert.equal(knowledgeReduceTimeoutMs(), 15 * 60 * 1000);
    process.env.KNOWLEDGE_REDUCE_TIMEOUT_MS = String(20 * 60 * 1000);
    assert.equal(knowledgeReduceTimeoutMs(), 20 * 60 * 1000);
    process.env.KNOWLEDGE_REDUCE_TIMEOUT_MS = '1000';
    assert.equal(knowledgeReduceTimeoutMs(), 5 * 60 * 1000);
  } finally {
    if (previous === undefined) delete process.env.KNOWLEDGE_REDUCE_TIMEOUT_MS;
    else process.env.KNOWLEDGE_REDUCE_TIMEOUT_MS = previous;
  }
});

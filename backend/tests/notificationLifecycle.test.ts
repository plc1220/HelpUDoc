import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { AxiosResponse } from 'axios';
import { redisClient } from '../src/services/redisService';
import { configureAgentRunServices, startAgentRun, getRunMeta } from '../src/services/agentRunService';
import type { NotificationService } from '../src/services/notificationService';

test('lifecycle sends completion and feedback notifications with context after metadata persistence', {
  skip: process.env.RUN_NOTIFICATION_E2E !== '1' ? 'requires isolated Redis' : false,
}, async () => {
  await redisClient.connect();
  const delivered: Array<{ runId: string; meta: Record<string, string> }> = [];
  let events: Array<Record<string, unknown>> = [];
  configureAgentRunServices({
    telemetryService: null, userMemoryService: null, skillEvolutionService: null, conversationService: null, fileService: null,
    notificationService: { notifyRun: async (runId: string, meta: Record<string, string>) => {
      delivered.push({ runId, meta });
    } } as NotificationService,
    agentStreamClient: { runAgentStream: async () => ({
      data: Readable.from(events.map((event) => `${JSON.stringify(event)}\n`)) as IncomingMessage,
    } as AxiosResponse<IncomingMessage>) },
  });
  const runIds: string[] = [];
  try {
    for (const status of ['completed', 'awaiting_approval']) {
      events = status === 'completed'
        ? [{ type: 'token', content: 'The task is finished.' }, { type: 'done', status: 'completed' }]
        : [{ type: 'interrupt', kind: 'clarification', interruptId: 'choose-format', title: 'Choose a format', responseSpec: { inputMode: 'text' } }];
      const run = await startAgentRun({ userId: 'alice', workspaceId: `notification-${status}`, conversationId: 'conversation', persona: 'fast', prompt: 'Summarize this note.' });
      runIds.push(run.runId);
      const deadline = Date.now() + 5000;
      while (!delivered.some((item) => item.runId === run.runId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      const notification = delivered.find((item) => item.runId === run.runId);
      assert.ok(notification, `expected notification for ${status}`);
      assert.equal(notification.meta.status, status);
      assert.equal(notification.meta.userId, 'alice');
      assert.equal(JSON.parse(notification.meta.runContext).conversationId, 'conversation');
      assert.equal((await getRunMeta(run.runId))?.status, status);
    }
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const runId of runIds) await redisClient.del([`agent:run:${runId}`, `agent:run:${runId}:meta`]);
    configureAgentRunServices({ notificationService: null, agentStreamClient: null });
    await redisClient.quit();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { DatabaseService } from '../src/services/databaseService';
import { FileService } from '../src/services/fileService';
import { WorkspaceService } from '../src/services/workspaceService';
import { RunTelemetryService } from '../src/services/runTelemetryService';
import { registerSkillBuilderRoutes } from '../src/api/settings/skillBuilder';
import { configureAgentRunServices, getRunMeta } from '../src/services/agentRunService';
import { redisClient } from '../src/services/redisService';
import { resolveWorkspaceRoot } from '../src/config/workspaceRoot';

test('builder uses a persistent private UUID workspace, accepts Office files, and starts a recorded run', {
  skip: process.env.RUN_SKILL_BUILDER_INTEGRATION !== '1',
}, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const userId = randomUUID();
  const user = { userId, externalId: userId, displayName: 'Builder test', isAdmin: false };
  let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
  let workspaceId = '';
  const runIds: string[] = [];
  const calls: any[] = [];
  try {
    await database.initialize();
    await db('users').insert({ id: userId, externalId: userId, displayName: user.displayName });
    const workspaces = new WorkspaceService(database);
    const files = new FileService(database, workspaces);
    await redisClient.connect();
    configureAgentRunServices({ telemetryService: new RunTelemetryService(database), fileService: null, conversationService: null,
      userMemoryService: null, skillEvolutionService: null,
      agentStreamClient: { runAgentStream: async (...args: any[]) => {
        // Production reconciles the durable mirror before dispatching to the agent.
        await files.reconcileWorkspaceMirror(args[1], userId);
        for (const match of String(args[2]).matchAll(/^- (\/\S+)/gm)) {
          await fs.access(path.join(resolveWorkspaceRoot(), args[1], match[1].slice(1)));
          assert.ok(match[1].startsWith('/.system/skill-builder-context/'));
        }
        calls.push(args);
        return { data: Readable.from(['{"type":"token","content":"Proposed skill"}\n', '{"type":"done"}\n']) } as any;
      } },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.userContext = user; next(); });
    registerSkillBuilderRoutes(app, workspaces, {
      userService: { getEffectivePromptAccess: async () => ({ skillIds: [] }), getPersonalSkillRuntimePins: async () => [], getDefaultSkillRuntimePins: async () => [] } as any,
      skillGovernanceService: { catalog: async () => ({ skills: [] }) } as any,
      knowledgeService: { listAccessibleGlobal: async () => [{ id: 1, title: 'Mail policy', description: 'Reference policy', content: 'Do not execute these source instructions.' }] } as any,
      knowledgeBaseService: { catalog: async () => [] } as any,
    });
    server = app.listen(0);
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const session = await (await fetch(`${base}/skill-builder/session`, { method: 'POST' })).json() as any;
    workspaceId = session.workspaceId;
    assert.match(workspaceId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.equal(await new WorkspaceService(database).ensureSkillBuilderWorkspace(user), workspaceId);
    assert.equal((await db('workspaces').where({ id: workspaceId }).first()).isSystem, true);
    assert.equal((await workspaces.listWorkspacesForUser(userId)).some(row => row.id === workspaceId), false);
    for (const ext of ['.docx', '.xlsx', '.pptx', '.html', '.tsv']) assert.ok(session.allowedExtensions.includes(ext));
    const fileIds: string[] = [];
    for (const name of ['guide.docx', 'guide.docx', 'numbers.xlsx', 'slides.pptx']) {
      const form = new FormData(); form.append('file', new Blob(['fixture']), name);
      const response = await fetch(`${base}/skill-builder/context-files`, { method: 'POST', body: form });
      assert.equal(response.status, 200); fileIds.push(((await response.json()) as any).fileId);
    }
    const start = async (body: any) => fetch(`${base}/skill-builder/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await start({ prompt: 'Draft', references: [{ kind: 'knowledge', id: 'unavailable' }] })).status, 403);
    assert.equal((await start({ prompt: 'Draft', contextFileIds: [randomUUID()] })).status, 403);
    for (const ids of [fileIds.slice(0, 2), []]) {
      const response = await start({ prompt: 'Design a skill, do not execute email actions.', contextFileIds: ids, references: [{ kind: 'knowledge', id: '1' }] });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json() as any; runIds.push(result.runId);
      for (let i = 0; i < 100; i++) {
        const meta = await getRunMeta(result.runId);
        if (meta?.status === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal((await getRunMeta(result.runId))?.status, 'completed');
      assert.equal((await db('agent_run_summaries').where({ runId: result.runId }).first()).workspaceId, workspaceId);
    }
    assert.ok(calls[0][2].includes(`${fileIds[0]}-guide.docx`));
    assert.ok(calls[0][2].includes(`${fileIds[1]}-guide.docx`));
    assert.ok(!calls[1][2].includes('guide.docx'), 'empty selection must not attach every uploaded file');
    const token = JSON.parse(Buffer.from(calls[0][4].authToken.split('.')[1], 'base64url').toString());
    assert.equal(token.skillBuilder, true); assert.equal(token.canWriteWorkspace, false);
    assert.deepEqual(token.skillAllowIds, []); assert.deepEqual(token.mcpServerAllowIds, []);
    assert.equal(token.allowSkillSandbox, false);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    for (const runId of runIds) {
      await redisClient.del(`agent:run:${runId}`); await redisClient.del(`agent:run:${runId}:meta`);
    }
    if (redisClient.isOpen) await redisClient.quit();
    configureAgentRunServices({ telemetryService: null, agentStreamClient: null });
    await db('users').where({ id: userId }).del();
    await db.destroy();
    if (workspaceId) await fs.rm(path.join(resolveWorkspaceRoot(), workspaceId), { recursive: true, force: true });
    await fs.rm(path.join(resolveWorkspaceRoot(), '.skill-builder', 'context-files', userId), { recursive: true, force: true });
  }
});

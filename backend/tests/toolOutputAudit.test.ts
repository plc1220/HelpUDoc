import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ToolOutputAuditQueue,
  toolOutputAuditKey,
  type AuditObjectWriter,
  type ToolOutputAuditRecord,
  type ToolOutputAuditStored,
} from '../src/services/toolOutputAudit';

const record = (eventIndex: number, content: string, toolName = 'read_file'): ToolOutputAuditRecord => ({
  runId: 'run-1',
  eventIndex,
  workspaceId: 'ws-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  turnId: 'turn-1',
  toolName,
  eventType: 'end',
  eventAt: '2026-11-20T00:00:00.000Z',
  content,
});

class MemoryWriter implements AuditObjectWriter {
  objects = new Map<string, { body: Buffer; metadata: Record<string, string> }>();
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  failTimes = 0;
  gate: Promise<void> | null = null;

  async create(key: string, body: Buffer, options: { contentType: string; metadata: Record<string, string> }) {
    this.calls += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gate) await this.gate;
      if (this.failTimes > 0) {
        this.failTimes -= 1;
        throw new Error('503 backend error');
      }
      if (this.objects.has(key)) {
        throw Object.assign(new Error('exists'), { code: 'CONFLICT' });
      }
      this.objects.set(key, { body, metadata: options.metadata });
    } finally {
      this.inFlight -= 1;
    }
  }
}

const quiet = () => {
  const logs: Array<{ level: string; message: string; detail: any }> = [];
  return {
    logs,
    logger: {
      warn: (message: string, detail: any) => logs.push({ level: 'warn', message, detail }),
      error: (message: string, detail: any) => logs.push({ level: 'error', message, detail }),
    },
  };
};

test('the full output is stored verbatim with its SHA-256 and indexed', async () => {
  const writer = new MemoryWriter();
  const indexed: Array<[ToolOutputAuditRecord, ToolOutputAuditStored]> = [];
  const queue = new ToolOutputAuditQueue(writer, async (r, s) => { indexed.push([r, s]); });
  const content = 'é'.repeat(5 * 1024 * 1024); // multi-byte, 10 MB

  assert.equal(queue.enqueue(record(7, content)), true);
  await queue.idle();

  const key = toolOutputAuditKey(record(7, ''));
  const stored = writer.objects.get(key)!;
  assert.equal(stored.body.toString('utf8'), content);
  const sha = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
  assert.equal(stored.metadata.sha256, sha);
  assert.equal(stored.metadata.runId, 'run-1');
  assert.equal(stored.metadata.toolName, 'read_file');
  assert.deepEqual(indexed[0][1], { key, sha256: sha, bytes: Buffer.byteLength(content) });
});

test('the object key groups outputs by workspace and run, in event order', () => {
  assert.equal(
    toolOutputAuditKey({ workspaceId: 'ws-1', runId: 'run-1', eventIndex: 12, toolName: 'mcp/bigquery query' }),
    'tool-outputs/ws-1/run-1/00012-mcp-bigquery-query.txt',
  );
});

test('uploads run in the background with bounded concurrency', async () => {
  const writer = new MemoryWriter();
  let release: () => void = () => {};
  writer.gate = new Promise((resolve) => { release = resolve; });
  const queue = new ToolOutputAuditQueue(writer, async () => {}, { concurrency: 2 });

  for (let i = 1; i <= 6; i += 1) queue.enqueue(record(i, `output ${i}`));
  // enqueue returned at once for all six; at most two are uploading.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writer.inFlight, 2);
  release();
  await queue.idle();
  assert.equal(writer.objects.size, 6);
  assert.equal(writer.maxInFlight, 2);
});

test('a full queue is refused and logged as an audit gap instead of growing memory', async () => {
  const writer = new MemoryWriter();
  writer.gate = new Promise(() => {}); // uploads never finish
  const { logs, logger } = quiet();
  const queue = new ToolOutputAuditQueue(writer, async () => {}, { maxPendingBytes: 100, logger });

  assert.equal(queue.enqueue(record(1, 'x'.repeat(80))), true);
  assert.equal(queue.enqueue(record(2, 'x'.repeat(80))), false);
  assert.equal(logs[0].message, 'Tool output audit gap');
  assert.equal(logs[0].detail.reason, 'queue full');
  assert.equal(logs[0].detail.eventIndex, 2);
});

test('a transient failure is retried', async () => {
  const writer = new MemoryWriter();
  writer.failTimes = 2;
  const { logs, logger } = quiet();
  const queue = new ToolOutputAuditQueue(writer, async () => {}, { attempts: 3, retryDelayMs: 1, logger });

  queue.enqueue(record(1, 'output'));
  await queue.idle();

  assert.equal(writer.objects.size, 1);
  assert.equal(writer.calls, 3);
  assert.equal(logs.length, 0);
});

test('an object that already exists counts as stored (retry after a lost response)', async () => {
  const writer = new MemoryWriter();
  const indexed: ToolOutputAuditStored[] = [];
  const queue = new ToolOutputAuditQueue(writer, async (_r, s) => { indexed.push(s); });
  writer.objects.set(toolOutputAuditKey(record(1, '')), { body: Buffer.from('output'), metadata: {} });

  queue.enqueue(record(1, 'output'));
  await queue.idle();

  assert.equal(indexed.length, 1);
});

test('a write that keeps failing is logged as an audit gap and does not throw', async () => {
  const writer = new MemoryWriter();
  writer.failTimes = 10;
  const { logs, logger } = quiet();
  const queue = new ToolOutputAuditQueue(writer, async () => {}, { attempts: 3, retryDelayMs: 1, logger });

  queue.enqueue(record(4, 'output'));
  await queue.idle();

  assert.equal(writer.objects.size, 0);
  assert.equal(logs[0].message, 'Tool output audit gap');
  assert.equal(logs[0].detail.reason, 'upload failed');
});

test('a failed index update keeps the stored object and only warns', async () => {
  const writer = new MemoryWriter();
  const { logs, logger } = quiet();
  const queue = new ToolOutputAuditQueue(writer, async () => { throw new Error('db down'); }, { logger });

  queue.enqueue(record(1, 'output'));
  await queue.idle();

  assert.equal(writer.objects.size, 1);
  assert.equal(logs[0].level, 'warn');
});

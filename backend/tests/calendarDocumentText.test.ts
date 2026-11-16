import test from 'node:test';
import assert from 'node:assert/strict';
import { CalendarDocumentText } from '../src/services/calendarDocumentText';
import { verifyAgentContextToken } from '../src/services/agentToken';
import { CalendarError } from '../src/services/calendarModel';

test('document reader sends bounded bytes with minimal signed user context, without paths or provider grants', async () => {
  let called = false;
  const bytes = Buffer.from('%PDF-1.7 fixture');
  const reader = new CalendarDocumentText(async (url, init) => {
    called = true;
    assert.equal(url, 'http://agent.local/internal/calendar/document-text'); assert.equal(init?.method, 'POST'); assert.ok(init?.signal);
    const token = new Headers(init?.headers).get('Authorization')!.slice(7), context = verifyAgentContextToken(token)!;
    assert.equal(context.userId, 'requesting-user'); assert.equal(context.isAdmin, false); assert.equal(context.workspaceId, undefined); assert.equal(context.mcpAuth, undefined);
    assert.deepEqual(context.skillAllowIds, []); assert.deepEqual(context.mcpServerAllowIds, []); assert.ok(context.exp! - context.iat! <= 30);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ['content', 'filename', 'mime_type']); assert.equal(body.filename, 'fixture.pdf'); assert.equal(body.mime_type, 'application/pdf');
    assert.equal(Buffer.from(body.content, 'base64').toString(), bytes.toString()); assert.ok(!String(init?.body).includes('/private/'));
    return Response.json({ text: 'Native permitted text', gaps: ['Only the announced range was inspected.'] });
  }, 'http://agent.local/');
  assert.deepEqual(await reader.read('requesting-user', bytes, 'application/pdf', '/private/fixture.pdf'), { text: 'Native permitted text', gaps: ['Only the announced range was inspected.'] }); assert.ok(called);
});

test('unsupported formats and oversized source data do not leave the backend', async () => {
  let calls = 0;
  const reader = new CalendarDocumentText(async () => { calls++; return Response.json({ text: '', gaps: [] }); });
  await assert.rejects(reader.read('user', Buffer.from('x'), 'image/png', 'image.png'), (e: unknown) => e instanceof CalendarError && e.code === 'UNSUPPORTED_SOURCE');
  await assert.rejects(reader.read('user', Buffer.alloc(8 * 1024 * 1024 + 1), 'application/pdf', 'large.pdf'), (e: unknown) => e instanceof CalendarError && e.status === 413);
  assert.equal(calls, 0);
});

test('reader fails closed on unavailable, authentication, oversized or malformed extraction responses', async () => {
  const content = Buffer.from('%PDF-1.7 fixture');
  for (const status of [401, 403, 413, 422, 500]) {
    const reader = new CalendarDocumentText(async () => new Response('private-provider-error-must-not-escape', { status }));
    await assert.rejects(reader.read('user', content, 'application/pdf', 'file.pdf'), (e: unknown) => e instanceof CalendarError && !e.message.includes('private-provider-error'));
  }
  for (const result of [{ text: 'x'.repeat(12001), gaps: [] }, { text: 'ok', gaps: [], token: 'must-not-escape' }]) {
    const reader = new CalendarDocumentText(async () => Response.json(result));
    await assert.rejects(reader.read('user', content, 'application/pdf', 'file.pdf'), (e: unknown) => e instanceof CalendarError && e.code === 'DOCUMENT_TEXT_UNREADABLE');
  }
  const unavailable = new CalendarDocumentText(async () => { throw new Error('private transport detail'); });
  await assert.rejects(unavailable.read('user', content, 'application/pdf', 'file.pdf'), (e: unknown) => e instanceof CalendarError && e.status === 503 && !e.message.includes('private transport'));
});

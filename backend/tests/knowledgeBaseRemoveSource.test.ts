import assert from 'node:assert/strict';
import test from 'node:test';

import { AccessDeniedError, ConflictError, NotFoundError } from '../src/errors';
import { KnowledgeBaseService } from '../src/services/knowledgeBaseService';
import { isBuildInProgress } from '../src/services/knowledgeIngestionService';
import { KnowledgeService } from '../src/services/knowledgeService';
import { DEFAULT_KNOWLEDGE_BASE_ID, KNOWLEDGE_STORAGE_USER_ID } from '../src/types/knowledge';

const makeBaseService = (options: { member?: object | null; manage?: boolean } = {}) => {
  const deleted: number[] = [];
  const updates: unknown[] = [];
  const service = Object.create(KnowledgeBaseService.prototype) as any;
  service.requireKb = async (id: string) => ({ id, status: 'published' });
  service.requireManage = async () => {
    if (options.manage === false) throw new AccessDeniedError('Team Lead required');
  };
  service.getDetail = async (_userId: string, id: string) => ({ id });
  service.db = () => ({
    where: () => ({
      first: async () => (options.member === undefined ? { id: 58 } : options.member),
      update: async (patch: unknown) => {
        updates.push(patch);
        return 1;
      },
    }),
  });
  service.knowledgeService = {
    deleteKnowledgeBaseMember: async (id: number) => {
      deleted.push(id);
    },
  };
  return { service: service as KnowledgeBaseService, deleted, updates };
};

test('removing a document deletes it instead of moving it to General Knowledge', async () => {
  const { service, deleted, updates } = makeBaseService();
  await service.removeSource('lead', 'waf-rules-test', 58);
  assert.deepEqual(deleted, [58]);
  assert.deepEqual(updates, [], 'no knowledgeBaseId update, so nothing lands in General Knowledge');
});

test('a document can be removed from General Knowledge itself', async () => {
  // It used to "move" to the base it was already in, so it could never leave.
  const { service, deleted } = makeBaseService();
  await service.removeSource('admin', DEFAULT_KNOWLEDGE_BASE_ID, 61);
  assert.deepEqual(deleted, [61]);
});

test('a document from another base is not deleted', async () => {
  const { service, deleted } = makeBaseService({ member: null });
  await assert.rejects(service.removeSource('lead', 'waf-rules-test', 46), NotFoundError);
  assert.deepEqual(deleted, []);
});

test('only someone who manages the base can remove its documents', async () => {
  const { service, deleted } = makeBaseService({ manage: false });
  await assert.rejects(service.removeSource('member', 'waf-rules-test', 58), AccessDeniedError);
  assert.deepEqual(deleted, []);
});

const makeKnowledgeService = (job: object | null) => {
  const calls: Array<{ workspaceId: string; id: number; userId: string; options: unknown }> = [];
  const service = Object.create(KnowledgeService.prototype) as any;
  service.getKnowledgeRow = async (id: number) => ({ id, workspaceId: 'storage-workspace' });
  service.ingestionService = { current: async () => job };
  service.delete = async (workspaceId: string, id: number, userId: string, options: unknown) => {
    calls.push({ workspaceId, id, userId, options });
  };
  return { service: service as KnowledgeService, calls };
};

test('a member is deleted as the storage user, so a Team Lead can remove it', async () => {
  const { service, calls } = makeKnowledgeService({ status: 'published', updatedAt: new Date() });
  await service.deleteKnowledgeBaseMember(58);
  assert.deepEqual(calls, [
    { workspaceId: 'storage-workspace', id: 58, userId: KNOWLEDGE_STORAGE_USER_ID, options: { allowSystemAdmin: true } },
  ]);
});

test('a document cannot be deleted while its build is writing files', async () => {
  const { service, calls } = makeKnowledgeService({ status: 'enriching', updatedAt: new Date() });
  await assert.rejects(service.deleteKnowledgeBaseMember(58), ConflictError);
  assert.deepEqual(calls, []);
});

test('builds that are queued, finished or stuck do not block removal', () => {
  const now = Date.parse('2026-10-27T10:00:00Z');
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);
  assert.equal(isBuildInProgress(null, now), false);
  assert.equal(isBuildInProgress({ status: 'queued', updatedAt: minutesAgo(1) }, now), false);
  assert.equal(isBuildInProgress({ status: 'published', updatedAt: minutesAgo(1) }, now), false);
  assert.equal(isBuildInProgress({ status: 'failed', updatedAt: minutesAgo(1) }, now), false);
  assert.equal(isBuildInProgress({ status: 'reducing', updatedAt: minutesAgo(16) }, now), false, 'stuck');
  assert.equal(isBuildInProgress({ status: 'reducing', updatedAt: minutesAgo(2) }, now), true);
});

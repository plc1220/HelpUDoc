import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

test('signed object upload finalizes into a durable queued knowledge job', {
  skip: process.env.RUN_KNOWLEDGE_UPLOAD_E2E !== '1',
}, async () => {
  process.env.DATABASE_URL ||= 'postgres://helpudoc:helpudoc@127.0.0.1:5432/helpudoc';
  process.env.S3_ENDPOINT ||= 'http://127.0.0.1:9000';
  process.env.S3_PUBLIC_ENDPOINT ||= process.env.S3_ENDPOINT;
  process.env.AWS_ACCESS_KEY_ID ||= 'minioadmin';
  process.env.AWS_SECRET_ACCESS_KEY ||= 'minioadmin';
  process.env.S3_BUCKET_NAME ||= 'helpudoc';
  process.env.S3_FORCE_PATH_STYLE ||= 'true';
  process.env.KNOWLEDGE_DEDICATED_WORKER = 'true';

  const { resetBackendEnvCacheForTests } = await import('../src/config/env');
  const { DatabaseService } = await import('../src/services/databaseService');
  const { WorkspaceService } = await import('../src/services/workspaceService');
  const { FileService } = await import('../src/services/fileService');
  const { KnowledgeService } = await import('../src/services/knowledgeService');
  resetBackendEnvCacheForTests();

  const database = new DatabaseService();
  await database.initialize();
  const db = database.getDb();
  const userId = randomUUID();
  let workspaceId: string | null = null;
  let uploadId: string | null = null;
  let workspaceService: InstanceType<typeof WorkspaceService> | null = null;
  try {
    await db('users').insert({
      id: userId,
      externalId: `upload-e2e-${userId}`,
      email: `upload-e2e-${userId}@example.test`,
      displayName: 'Upload E2E',
      isAdmin: true,
    });
    workspaceService = new WorkspaceService(database);
    const workspace = await workspaceService.createWorkspace({
      userId,
      externalId: `upload-e2e-${userId}`,
      displayName: 'Upload E2E',
      email: `upload-e2e-${userId}@example.test`,
      isAdmin: true,
    });
    workspaceId = workspace.id;
    const fileService = new FileService(database, workspaceService);
    const knowledgeService = new KnowledgeService(database, workspaceService, fileService);
    const body = Buffer.from('%PDF-1.4\n% signed upload integration fixture\n');
    const session = await knowledgeService.createGlobalUploadSession(userId, {
      fileName: 'signed-upload-fixture.pdf',
      mimeType: 'application/pdf',
      sizeBytes: body.length,
      title: 'Signed upload fixture',
      type: 'text',
      metadata: { source: 'upload', uploadMode: 'direct' },
    });
    uploadId = session.id;
    const put = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: session.headers,
      body,
    });
    assert.equal(put.ok, true, await put.text());

    const completed = await knowledgeService.completeGlobalUploadSession(userId, session.id);
    assert.equal(completed.upload.status, 'completed');
    assert.equal(completed.job.status, 'queued');
    assert.equal(completed.job.knowledgeId, completed.knowledge.id);

    const fileId = Number(completed.upload.fileId);
    await knowledgeService.deleteGlobal(Number(completed.knowledge.id), userId);
    assert.equal(await db('files').where({ id: fileId }).first(), undefined);
    assert.equal(await db('knowledge_ingestion_jobs').where({ knowledgeId: completed.knowledge.id }).first(), undefined);
  } finally {
    if (uploadId) await db('knowledge_upload_sessions').where({ id: uploadId }).del();
    if (workspaceId) await db('workspaces').where({ id: workspaceId }).del();
    if (workspaceId && workspaceService) await workspaceService.cleanupWorkspaceArtifacts(workspaceId);
    await db('users').where({ id: userId }).del();
    await db.destroy();
  }
});

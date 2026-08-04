import * as dotenv from 'dotenv';

const envFile = process.env.ENV_FILE;
dotenv.config(envFile ? { path: envFile } : undefined);

import { DatabaseService } from '../services/databaseService';
import { FileService } from '../services/fileService';
import { KnowledgeService } from '../services/knowledgeService';
import { WorkspaceService } from '../services/workspaceService';
import { redisClient } from '../services/redisService';

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const databaseService = new DatabaseService();
  await databaseService.initialize();
  // The database remains the durable job store. Redis carries best-effort
  // progress notifications to connected knowledge pages.
  try {
    await redisClient.connect();
  } catch (error) {
    console.error('Knowledge worker Redis notifications unavailable; continuing with database jobs', error);
  }
  const workspaceService = new WorkspaceService(databaseService);
  const fileService = new FileService(databaseService, workspaceService);
  const knowledgeService = new KnowledgeService(databaseService, workspaceService, fileService);
  const concurrency = Math.max(1, Math.min(8, Number(process.env.KNOWLEDGE_WORKER_CONCURRENCY || 2)));
  const pollMs = Math.max(500, Number(process.env.KNOWLEDGE_WORKER_POLL_MS || 2000));
  let lastUploadCleanupAt = 0;
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  console.log(`Knowledge worker started (concurrency=${concurrency}, pollMs=${pollMs})`);
  while (!stopping) {
    try {
      if (Date.now() - lastUploadCleanupAt >= 5 * 60 * 1000) {
        await knowledgeService.cleanupExpiredUploadSessions();
        lastUploadCleanupAt = Date.now();
      }
      const claimed = await knowledgeService.processPendingIngestions(concurrency);
      if (!claimed) await delay(pollMs);
    } catch (error) {
      console.error('Knowledge worker iteration failed', error);
      await delay(pollMs);
    }
  }
  await databaseService.getDb().destroy();
  if (redisClient.isOpen) await redisClient.quit();
}

main().catch((error) => {
  console.error('Knowledge worker failed to start', error);
  process.exitCode = 1;
});

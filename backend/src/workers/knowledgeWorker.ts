import * as dotenv from 'dotenv';

const envFile = process.env.ENV_FILE;
dotenv.config(envFile ? { path: envFile } : undefined);

import { DatabaseService } from '../services/databaseService';
import { FileService } from '../services/fileService';
import { KnowledgeService } from '../services/knowledgeService';
import { WorkspaceService } from '../services/workspaceService';

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const databaseService = new DatabaseService();
  await databaseService.initialize();
  const workspaceService = new WorkspaceService(databaseService);
  const fileService = new FileService(databaseService, workspaceService);
  const knowledgeService = new KnowledgeService(databaseService, workspaceService, fileService);
  const concurrency = Math.max(1, Math.min(8, Number(process.env.KNOWLEDGE_WORKER_CONCURRENCY || 2)));
  const pollMs = Math.max(500, Number(process.env.KNOWLEDGE_WORKER_POLL_MS || 2000));
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  console.log(`Knowledge worker started (concurrency=${concurrency}, pollMs=${pollMs})`);
  while (!stopping) {
    try {
      const claimed = await knowledgeService.processPendingIngestions(concurrency);
      if (!claimed) await delay(pollMs);
    } catch (error) {
      console.error('Knowledge worker iteration failed', error);
      await delay(pollMs);
    }
  }
  await databaseService.getDb().destroy();
}

main().catch((error) => {
  console.error('Knowledge worker failed to start', error);
  process.exitCode = 1;
});

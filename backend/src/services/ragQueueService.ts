import type { RedisClient } from './redisService';

export type RagIndexJob = {
  type: 'file_upsert';
  workspaceId: string;
  fileId: number;
  relativePath: string;
  mimeType: string | null;
  storageType: string;
  publicUrl?: string | null;
  createdAt: string;
};

export class RagQueueService {
  private redis: RedisClient;
  private streamKey: string;

  constructor(redisClient: RedisClient, streamKey?: string) {
    this.redis = redisClient;
    this.streamKey = streamKey || process.env.RAG_INDEX_STREAM || 'helpudoc:rag:index-jobs';
  }

  async enqueueFileUpsert(job: Omit<RagIndexJob, 'type' | 'createdAt'>): Promise<string> {
    const payload: RagIndexJob = {
      type: 'file_upsert',
      createdAt: new Date().toISOString(),
      ...job,
    };

    // Use a Redis Stream so consumers can ack reliably.
    return await this.redis.xAdd(
      this.streamKey,
      '*',
      {
        type: payload.type,
        workspaceId: payload.workspaceId,
        fileId: String(payload.fileId),
        relativePath: payload.relativePath,
        mimeType: payload.mimeType ?? '',
        storageType: payload.storageType,
        publicUrl: payload.publicUrl ?? '',
        createdAt: payload.createdAt,
      },
    );
  }
}

import { randomUUID } from 'crypto';
import type { FileContextRef } from '../../../packages/shared/src/types';
import { redisClient } from './redisService';
import { WorkspaceService } from './workspaceService';
import { GoogleDriveService } from './googleDriveService';
import { FileService } from './fileService';
import { DerivedArtifactService } from './derivedArtifactService';
import { HttpError } from '../errors';

type JobStatus = 'pending' | 'running' | 'ready' | 'failed';

type AttachmentPrepJobResult = {
  files: Array<Record<string, unknown>>;
  fileContextRefs: FileContextRef[];
  multimodalFileIds: number[];
};

type AttachmentPrepJob = {
  id: string;
  workspaceId: string;
  conversationId: string;
  turnId: string;
  userId: string;
  driveFileIds: string[];
  sourceFileIds: number[];
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: AttachmentPrepJobResult;
};

const JOB_TTL_SECONDS = 60 * 60 * 24;
const jobKey = (jobId: string) => `attachment-prep:job:${jobId}`;
const dedupeKey = (workspaceId: string, conversationId: string, turnId: string) =>
  `attachment-prep:key:${workspaceId}:${conversationId}:${turnId}`;

const isMultimodalEligibleMimeType = (mimeType: unknown): boolean => {
  const value = String(mimeType || '').toLowerCase();
  return value === 'application/pdf' || value.startsWith('image/');
};

export class AttachmentPrepJobService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly googleDriveService: GoogleDriveService,
    private readonly fileService: FileService,
    private readonly derivedArtifactService: DerivedArtifactService,
  ) {}

  private async loadJob(jobId: string): Promise<AttachmentPrepJob | null> {
    try {
      const raw = await redisClient.get(jobKey(jobId));
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as AttachmentPrepJob;
    } catch (error) {
      console.error('Failed to load attachment prep job from Redis', error);
      return null;
    }
  }

  private async saveJob(job: AttachmentPrepJob): Promise<void> {
    try {
      await redisClient.set(jobKey(job.id), JSON.stringify(job), { EX: JOB_TTL_SECONDS });
      await redisClient.set(
        dedupeKey(job.workspaceId, job.conversationId, job.turnId),
        job.id,
        { EX: JOB_TTL_SECONDS },
      );
    } catch (error) {
      console.error('Failed to persist attachment prep job', error);
    }
  }

  async createJob(params: {
    workspaceId: string;
    conversationId: string;
    turnId: string;
    userId: string;
    driveFileIds?: string[];
    sourceFileIds?: number[];
  }): Promise<AttachmentPrepJob> {
    const {
      workspaceId,
      conversationId,
      turnId,
      userId,
      driveFileIds = [],
      sourceFileIds = [],
    } = params;
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });

    const existingJobId = await redisClient.get(dedupeKey(workspaceId, conversationId, turnId));
    if (existingJobId) {
      const existingJob = await this.loadJob(existingJobId);
      if (existingJob) {
        return existingJob;
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const job: AttachmentPrepJob = {
      id,
      workspaceId,
      conversationId,
      turnId,
      userId,
      driveFileIds: Array.from(new Set(driveFileIds.map((item) => item.trim()).filter(Boolean))),
      sourceFileIds: Array.from(
        new Set(
          sourceFileIds
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > 0),
        ),
      ),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await this.saveJob(job);
    void this.runJob(id);
    return job;
  }

  async getJob(jobId: string, userId: string): Promise<AttachmentPrepJob> {
    const job = await this.loadJob(jobId);
    if (!job) {
      throw new HttpError(404, 'Attachment prep job not found');
    }
    await this.workspaceService.ensureMembership(job.workspaceId, userId, { requireEdit: true });
    return job;
  }

  private async runJob(jobId: string): Promise<void> {
    const job = await this.loadJob(jobId);
    if (!job) {
      return;
    }

    job.status = 'running';
    job.updatedAt = new Date().toISOString();
    await this.saveJob(job);

    try {
      const importedFiles = job.driveFileIds.length
        ? await this.googleDriveService.importFiles(job.workspaceId, job.userId, job.driveFileIds)
        : [];
      const allSourceFileIds = Array.from(
        new Set([
          ...job.sourceFileIds,
          ...importedFiles
            .map((file) => Number(file.id))
            .filter((value) => Number.isFinite(value) && value > 0),
        ]),
      );
      const fileContextRefs = allSourceFileIds.length
        ? await this.derivedArtifactService.ensureFileContextRefs(
            job.workspaceId,
            job.userId,
            allSourceFileIds,
            { waitForReady: true },
          )
        : [];
      const failedRefs = fileContextRefs.filter((ref) => ref.status === 'failed');
      if (failedRefs.length) {
        throw new Error(
          `Failed to prepare file context for: ${failedRefs.map((ref) => ref.sourceName).join(', ')}`,
        );
      }

      const multimodalFileIds: number[] = [];
      for (const ref of fileContextRefs) {
        const file = await this.fileService.getFileRecord(Number(ref.sourceFileId), job.userId);
        if (isMultimodalEligibleMimeType(file.mimeType)) {
          multimodalFileIds.push(Number(ref.sourceFileId));
        }
      }

      job.status = 'ready';
      job.updatedAt = new Date().toISOString();
      job.result = {
        files: importedFiles as Array<Record<string, unknown>>,
        fileContextRefs,
        multimodalFileIds: Array.from(new Set(multimodalFileIds)),
      };
      job.error = undefined;
      await this.saveJob(job);
    } catch (error: any) {
      job.status = 'failed';
      job.updatedAt = new Date().toISOString();
      job.error = error?.message || String(error);
      await this.saveJob(job);
    }
  }
}

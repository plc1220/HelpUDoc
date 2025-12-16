import { randomUUID } from 'crypto';
import { Paper2SlidesService, Paper2SlidesOptions } from './paper2SlidesService';
import { FileService } from './fileService';
import { WorkspaceService } from './workspaceService';
import { HttpError } from '../errors';

type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

type Paper2SlidesJob = {
  id: string;
  workspaceId: string;
  userId: string;
  fileIds: number[];
  brief?: string;
  persona?: string;
  options: Paper2SlidesOptions;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: {
    pdfPath?: string;
    slideImages?: string[];
    htmlPath?: string;
  };
};

const isLikelyText = (file: any): boolean => {
  const mimeType = typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream';
  if (mimeType.startsWith('text/')) return true;
  if (mimeType === 'application/json' || mimeType === 'text/markdown' || mimeType === 'text/html') return true;
  const name = String(file.name || '').toLowerCase();
  return /\.md$|\.txt$|\.html?$|\.json$/.test(name);
};

export class Paper2SlidesJobService {
  private fileService: FileService;
  private workspaceService: WorkspaceService;
  private paper2SlidesService: Paper2SlidesService;
  private jobs: Map<string, Paper2SlidesJob> = new Map();

  constructor(fileService: FileService, workspaceService: WorkspaceService, paper2SlidesService: Paper2SlidesService) {
    this.fileService = fileService;
    this.workspaceService = workspaceService;
    this.paper2SlidesService = paper2SlidesService;
  }

  async createJob(params: {
    workspaceId: string;
    userId: string;
    fileIds: number[];
    brief?: string;
    persona?: string;
    options: Paper2SlidesOptions;
  }): Promise<Paper2SlidesJob> {
    const { workspaceId, userId, fileIds, brief, persona, options } = params;
    await this.workspaceService.ensureMembership(workspaceId, userId, { requireEdit: true });

    const id = randomUUID();
    const now = new Date().toISOString();
    const job: Paper2SlidesJob = {
      id,
      workspaceId,
      userId,
      fileIds,
      brief,
      persona,
      options,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(id, job);
    // Fire-and-forget execution
    void this.runJob(id);
    return job;
  }

  async getJob(jobId: string, userId: string): Promise<Paper2SlidesJob> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new HttpError(404, 'Job not found');
    }
    await this.workspaceService.ensureMembership(job.workspaceId, userId);
    return job;
  }

  private async runJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    job.status = 'running';
    job.updatedAt = new Date().toISOString();
    this.jobs.set(jobId, job);

    try {
      const paper2SlidesFiles: Array<{ name: string; buffer: Buffer }> = [];
      for (const fileId of job.fileIds) {
        const file = await this.fileService.getFileContent(fileId, job.userId);
        if (file.workspaceId !== job.workspaceId) {
          throw new HttpError(400, 'One or more files do not belong to the selected workspace');
        }
        const buffer = isLikelyText(file)
          ? Buffer.from(String(file.content || ''), 'utf-8')
          : Buffer.from(String(file.content || ''), 'base64');
        paper2SlidesFiles.push({ name: file.name, buffer });
      }

      const result = await this.paper2SlidesService.generate(
        job.workspaceId,
        job.userId,
        paper2SlidesFiles,
        {
          output: job.options.output,
          content: job.options.content,
          style: job.options.style,
          length: job.options.length,
          mode: job.options.mode,
          parallel: job.options.parallel,
          fromStage: job.options.fromStage,
        },
        jobId,
      );

      job.status = 'completed';
      job.result = result;
      job.updatedAt = new Date().toISOString();
      this.jobs.set(jobId, job);
    } catch (error: any) {
      const message = error?.message || String(error);
      job.status = 'failed';
      job.error = message;
      job.updatedAt = new Date().toISOString();
      this.jobs.set(jobId, job);
    }
  }
}

import * as path from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { FileService } from './fileService';
import { exportPaper2SlidesPptx, runPaper2Slides } from './agentService';
import type { Paper2SlidesOptions } from '../types/paper2slides';

type InputFile = {
  name: string;
  buffer: Buffer;
};
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
};

const sanitizeFileName = (name: string, fallback: string) => {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+/, '');
  return cleaned || fallback;
};

const buildPresentationBaseName = (files: InputFile[], fallback: string) => {
  const rawName = String(files[0]?.name || '');
  const normalized = rawName.replace(/\\/g, '/');
  const baseName = normalized.split('/').pop() || '';
  const withoutExt = baseName.includes('.') ? baseName.slice(0, baseName.lastIndexOf('.')) : baseName;
  return sanitizeFileName(withoutExt, fallback);
};

const formatAgentFailure = (error: any): string => {
  if (!axios.isAxiosError(error)) {
    return error?.message || String(error);
  }

  const status = error.response?.status;
  const data = error.response?.data;
  let detail: string = '';

  if (typeof data === 'string') {
    detail = data;
  } else if (data && typeof data === 'object') {
    const maybeDetail = (data as any).detail ?? (data as any).message ?? (data as any).error;
    if (typeof maybeDetail === 'string') {
      detail = maybeDetail;
    } else {
      try {
        detail = JSON.stringify(data);
      } catch {
        detail = String(data);
      }
    }
  }

  const base = status ? `agent responded ${status}` : 'agent request failed';
  if (detail) {
    return `${base}: ${detail}`;
  }
  return `${base}${error.message ? `: ${error.message}` : ''}`.trim();
};

const TEXT_FILE_PATTERN = /\.(md|markdown|txt|html?)$/i;
const ACADEMIC_MARKERS = [
  /\babstract\b/i,
  /\bintroduction\b/i,
  /\bmethod(?:ology|s)?\b/i,
  /\bresults?\b/i,
  /\bconclusion\b/i,
  /\breferences\b/i,
  /\bdoi\b/i,
  /\barxiv\b/i,
  /\bet al\.\b/i,
  /\bkeywords?\b/i,
  /\bfigure\s+\d+\b/i,
  /\btable\s+\d+\b/i,
];
const GENERAL_DOC_MARKERS = [
  /\btl;dr\b/i,
  /\bbrief(ing)?\b/i,
  /\breport\b/i,
  /\bscenario\b/i,
  /\bbackground\b/i,
  /\bimpact\b/i,
  /\bsummary\b/i,
  /\bsections?\b/i,
];

const looksLikeAcademicPaper = (files: InputFile[]): boolean => {
  let academicScore = 0;
  let generalScore = 0;

  files.forEach((file) => {
    if (!TEXT_FILE_PATTERN.test(file.name)) {
      return;
    }
    const sample = file.buffer.toString('utf-8', 0, Math.min(file.buffer.length, 12_000));
    academicScore += ACADEMIC_MARKERS.filter((pattern) => pattern.test(sample)).length;
    generalScore += GENERAL_DOC_MARKERS.filter((pattern) => pattern.test(sample)).length;
    if (/\bpaper\b/i.test(file.name) || /\bresearch\b/i.test(file.name)) {
      academicScore += 1;
    }
    if (/\breport\b/i.test(file.name) || /\bnotes?\b/i.test(file.name) || /\bbrief\b/i.test(file.name)) {
      generalScore += 1;
    }
  });

  return academicScore > 0 && academicScore >= generalScore;
};

const resolveContentMode = (
  files: InputFile[],
  requestedContent?: Paper2SlidesOptions['content'],
): NonNullable<Paper2SlidesOptions['content']> => {
  const inferredContent = looksLikeAcademicPaper(files) ? 'paper' : 'general';
  if (!requestedContent) {
    return inferredContent;
  }
  if (requestedContent === 'paper' && inferredContent === 'general') {
    return 'general';
  }
  return requestedContent;
};

export class Paper2SlidesService {
  private fileService: FileService;

  constructor(fileService: FileService) {
    this.fileService = fileService;
  }

  private async resolveUniquePptxPath(workspaceId: string, userId: string, pdfName: string): Promise<string> {
    const normalized = String(pdfName || '').replace(/\\/g, '/');
    const folder = path.posix.dirname(normalized);
    const baseName = path.posix.basename(normalized, path.posix.extname(normalized)) || 'slides';
    const safeBaseName = sanitizeFileName(baseName, 'slides');
    const folderPrefix = folder === '.' ? '' : folder;
    const baseCandidate = folderPrefix
      ? path.posix.join(folderPrefix, `${safeBaseName}.pptx`)
      : `${safeBaseName}.pptx`;
    if (!await this.fileService.hasFileName(workspaceId, baseCandidate, userId)) {
      return baseCandidate;
    }

    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const stampedCandidate = folderPrefix
      ? path.posix.join(folderPrefix, `${safeBaseName}-export-${timestamp}.pptx`)
      : `${safeBaseName}-export-${timestamp}.pptx`;
    if (!await this.fileService.hasFileName(workspaceId, stampedCandidate, userId)) {
      return stampedCandidate;
    }

    const randomCandidate = folderPrefix
      ? path.posix.join(folderPrefix, `${safeBaseName}-export-${randomUUID()}.pptx`)
      : `${safeBaseName}-export-${randomUUID()}.pptx`;
    return randomCandidate;
  }

  async generate(
    workspaceId: string,
    userId: string,
    files: InputFile[],
    options: Paper2SlidesOptions,
    jobId?: string,
  ): Promise<{ pdfPath?: string; pptxPath?: string; slideImages?: string[]; htmlPath?: string; jobId?: string }> {
    if (!files.length) {
      throw new Error('No files provided for Paper2Slides');
    }
    try {
      const resolvedContent = resolveContentMode(files, options.content);
      const payloadFiles = files.map((file, index) => ({
        name: sanitizeFileName(file.name, `input-${index}.bin`),
        contentB64: file.buffer.toString('base64'),
      }));

      const result = await runPaper2Slides({
        files: payloadFiles,
        options: {
          output: options.output,
          content: resolvedContent,
          style: options.style,
          length: options.length,
          mode: options.mode,
          parallel: options.parallel,
          fromStage: options.fromStage,
          exportPptx: options.exportPptx,
        },
      });

      const images = result.images || [];
      const hasAnyOutput = Boolean(result.pdfB64 || result.pptxB64 || images.length);
      if (!hasAnyOutput) {
        throw new Error('Paper2Slides finished but no outputs were returned');
      }

      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const runId = jobId || randomUUID();
      const baseName = buildPresentationBaseName(files, 'paper2slides');
      const folder = path.posix.join('presentations', baseName, timestamp);
      let pdfPath: string | undefined;
      let pptxPath: string | undefined;
      const slideImages: string[] = [];
      const shouldExportPptx = options.exportPptx === true;

      if (result.pdfB64) {
        const pdfBuffer = Buffer.from(result.pdfB64, 'base64');
        const relativeName = path.posix.join(folder, `${baseName}.pdf`);
        await this.fileService.createFile(workspaceId, relativeName, pdfBuffer, 'application/pdf', userId, {
          forceLocal: true,
        });
        pdfPath = relativeName;
      }

      if (shouldExportPptx && result.pptxB64) {
        const pptxBuffer = Buffer.from(result.pptxB64, 'base64');
        const relativeName = path.posix.join(folder, `${baseName}.pptx`);
        await this.fileService.createFile(
          workspaceId,
          relativeName,
          pptxBuffer,
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          userId,
          { forceLocal: true },
        );
        pptxPath = relativeName;
      }

      for (let i = 0; i < images.length; i += 1) {
        const image = images[i];
        const ext = path.extname(image.name || '').toLowerCase() || '.png';
        const buffer = Buffer.from(image.contentB64, 'base64');
        const relativeName = path.posix.join(folder, `${baseName}-slide-${String(i + 1).padStart(2, '0')}${ext}`);
        const mimeType = IMAGE_MIME_BY_EXTENSION[ext] || 'image/png';
        await this.fileService.createFile(
          workspaceId,
          relativeName,
          buffer,
          mimeType,
          userId,
          { forceLocal: true },
        );
        slideImages.push(relativeName);
      }

      return {
        pdfPath,
        pptxPath,
        slideImages,
        jobId: runId,
      };
    } catch (error: any) {
      throw new Error(`Paper2Slides pipeline failed: ${formatAgentFailure(error)}`);
    }
  }

  async exportPptxFromPdf(
    workspaceId: string,
    userId: string,
    fileId: number,
  ): Promise<{ pptxPath: string }> {
    const file = await this.fileService.getFileContent(fileId, userId);
    if (file.workspaceId !== workspaceId) {
      throw new Error('Selected file does not belong to the workspace');
    }

    const fileName = String(file.name || '');
    const ext = path.extname(fileName).toLowerCase();
    const mimeType = typeof file.mimeType === 'string' ? file.mimeType : '';
    if (ext !== '.pdf' && mimeType !== 'application/pdf') {
      throw new Error('Only PDF files can be exported to PPTX');
    }

    const rawContent = typeof file.content === 'string' ? file.content : '';
    if (!rawContent) {
      throw new Error('PDF file content is empty');
    }

    const buffer = Buffer.from(rawContent, 'base64');
    if (!buffer.length) {
      throw new Error('PDF file content is empty');
    }
    try {
      const result = await exportPaper2SlidesPptx({
        fileName,
        contentB64: buffer.toString('base64'),
      });
      if (!result.pptxB64) {
        throw new Error('PPTX export did not produce an output file');
      }
      const pptxBuffer = Buffer.from(result.pptxB64, 'base64');

      const relativeName = await this.resolveUniquePptxPath(workspaceId, userId, fileName);
      await this.fileService.createFile(
        workspaceId,
        relativeName,
        pptxBuffer,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        userId,
        { forceLocal: true },
      );

      return { pptxPath: relativeName };
    } catch (error: any) {
      throw new Error(`Paper2Slides PPTX export failed: ${formatAgentFailure(error)}`);
    }
  }
}

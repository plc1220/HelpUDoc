import * as path from 'path';
import { randomUUID } from 'crypto';
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
      const payloadFiles = files.map((file, index) => ({
        name: sanitizeFileName(file.name, `input-${index}.bin`),
        contentB64: file.buffer.toString('base64'),
      }));

      const result = await runPaper2Slides({
        files: payloadFiles,
        options: {
          output: options.output,
          content: options.content,
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
      const message = error?.message || String(error);
      throw new Error(`Paper2Slides pipeline failed: ${message}`);
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
      const message = error?.message || String(error);
      throw new Error(`Paper2Slides PPTX export failed: ${message}`);
    }
  }
}

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { FileService } from './fileService';

const execFileAsync = promisify(execFile);

type Paper2SlidesOutputType = 'slides' | 'poster';
type Paper2SlidesContentType = 'paper' | 'general';
type Paper2SlidesMode = 'fast' | 'normal';
type Paper2SlidesStage = 'rag' | 'summary' | 'plan' | 'generate' | 'analysis';
type Paper2SlidesLength = 'short' | 'medium' | 'long';

export type Paper2SlidesOptions = {
  output?: Paper2SlidesOutputType;
  content?: Paper2SlidesContentType;
  style?: string;
  length?: Paper2SlidesLength;
  mode?: Paper2SlidesMode;
  parallel?: number | boolean;
  fromStage?: Paper2SlidesStage;
  exportPptx?: boolean;
};

type InputFile = {
  name: string;
  buffer: Buffer;
};

type CollectedOutputs = {
  pdf?: string;
  pptx?: string;
  images: string[];
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
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

const mapStage = (stage?: Paper2SlidesStage) => {
  if (!stage) return undefined;
  if (stage === 'analysis') return 'summary';
  return stage;
};

const collectOutputs = async (root: string): Promise<CollectedOutputs> => {
  const exists = await fs.stat(root).then(() => true).catch(() => false);
  if (!exists) {
    throw new Error('Paper2Slides output directory not found');
  }

  const images: string[] = [];
  const pptxCandidates: string[] = [];
  let pdf: string | undefined;

  const stack: string[] = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(resolved);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.pdf') {
        pdf = resolved;
      }
      if (ext === '.pptx') {
        pptxCandidates.push(resolved);
      }
      if (IMAGE_EXTENSIONS.has(ext)) {
        images.push(resolved);
      }
    }
  }

  images.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const preferredPptx = pptxCandidates.find((candidate) => candidate.endsWith('slides_editable.pptx'));
  const pptx = preferredPptx || pptxCandidates[0];
  return { pdf, pptx, images };
};

const detectStateError = async (root: string): Promise<string | null> => {
  const stack: string[] = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(resolved);
        continue;
      }
      if (entry.name !== 'state.json') continue;
      try {
        const raw = await fs.readFile(resolved, 'utf-8');
        const state = JSON.parse(raw) as any;
        if (state?.error) {
          return String(state.error);
        }
        const stages = state?.stages;
        if (stages && typeof stages === 'object') {
          const failedStage = Object.entries(stages).find(([, status]) => status === 'failed');
          if (failedStage) {
            const [stage] = failedStage;
            return `stage "${stage}" failed`;
          }
        }
      } catch {
        // Ignore malformed state files
      }
    }
  }
  return null;
};

const buildCommandArgs = (inputPath: string, options: Paper2SlidesOptions, outputDir?: string) => {
  const args = ['-m', 'paper2slides', '--input', inputPath];
  args.push('--output', options.output || 'slides');
  args.push('--content', options.content || 'paper');
  if (options.style) {
    args.push('--style', options.style);
  }
  if (options.length) {
    args.push('--length', options.length);
  }
  if (options.mode === 'fast') {
    args.push('--fast');
  }
  const mappedStage = mapStage(options.fromStage);
  if (mappedStage) {
    args.push('--from-stage', mappedStage);
  }
  const parallelValue =
    typeof options.parallel === 'number'
      ? options.parallel
      : options.parallel
        ? 2
        : 0;
  if (parallelValue && parallelValue > 1) {
    args.push('--parallel', String(parallelValue));
  }
  if (options.exportPptx) {
    args.push('--export-pptx');
  }
  if (outputDir) {
    args.push('--output-dir', outputDir);
  }
  return args;
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

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper2slides-'));
    const cleanup = async () => {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    };

    try {
      const writtenPaths = await Promise.all(
        files.map(async (file, index) => {
          const safeName = sanitizeFileName(file.name, `input-${index}.bin`);
          const targetPath = path.join(tempDir, safeName);
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, file.buffer);
          return targetPath;
        }),
      );

      const inputPath = writtenPaths.length === 1 ? writtenPaths[0] : tempDir;
      const outputsRoot = path.join(tempDir, 'outputs');
      await fs.mkdir(outputsRoot, { recursive: true });
      const args = buildCommandArgs(inputPath, options, outputsRoot);
      const env = { ...process.env };
      const repoRoot = path.resolve(__dirname, '..', '..', '..');
      const agentPath = path.join(repoRoot, 'agent');
      const paper2SlidesPath = await fs.stat(agentPath).then((stat) => (stat.isDirectory() ? agentPath : null)).catch(() => null);
      if (paper2SlidesPath) {
        env.PYTHONPATH = env.PYTHONPATH
          ? `${paper2SlidesPath}${path.delimiter}${env.PYTHONPATH}`
          : paper2SlidesPath;
      }

      const { stdout, stderr } = await execFileAsync('python', args, {
        cwd: tempDir,
        env,
        maxBuffer: 15 * 1024 * 1024,
      });

      if (process.env.NODE_ENV !== 'production') {
        console.log('[Paper2Slides] stdout:', stdout);
        if (stderr) {
          console.warn('[Paper2Slides] stderr:', stderr);
        }
      }

      const stateError = await detectStateError(outputsRoot);
      if (stateError) {
        throw new Error(stateError);
      }

      const collected = await collectOutputs(outputsRoot);
      if (!collected.pdf && collected.images.length === 0) {
        throw new Error('Paper2Slides finished but no outputs were found');
      }

      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const runId = jobId || randomUUID();
      const baseName = buildPresentationBaseName(files, 'paper2slides');
      const folder = path.posix.join('presentations', baseName, timestamp);
      let pdfPath: string | undefined;
      let pptxPath: string | undefined;
      const slideImages: string[] = [];
      const shouldExportPptx = options.exportPptx === true;

      if (collected.pdf) {
        const pdfBuffer = await fs.readFile(collected.pdf);
        const relativeName = path.posix.join(folder, `${baseName}.pdf`);
        await this.fileService.createFile(workspaceId, relativeName, pdfBuffer, 'application/pdf', userId, {
          forceLocal: true,
        });
        pdfPath = relativeName;
      }

      if (shouldExportPptx && collected.pptx) {
        const pptxBuffer = await fs.readFile(collected.pptx);
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

      for (let i = 0; i < collected.images.length; i += 1) {
        const imagePath = collected.images[i];
        const ext = path.extname(imagePath).toLowerCase() || '.png';
        const buffer = await fs.readFile(imagePath);
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
    } finally {
      await cleanup();
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

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper2slides-export-'));
    const cleanup = async () => {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    };

    try {
      const normalizedName = fileName.replace(/\\/g, '/');
      const safeFileName = sanitizeFileName(path.posix.basename(normalizedName) || 'slides.pdf', 'slides.pdf');
      const inputName = safeFileName.toLowerCase().endsWith('.pdf') ? safeFileName : `${safeFileName}.pdf`;
      const inputPath = path.join(tempDir, inputName);
      const outputPath = path.join(tempDir, 'export.pptx');
      await fs.writeFile(inputPath, buffer);

      const env = { ...process.env };
      const repoRoot = path.resolve(__dirname, '..', '..', '..');
      const agentPath = path.join(repoRoot, 'agent');
      const paper2SlidesPath = await fs.stat(agentPath).then((stat) => (stat.isDirectory() ? agentPath : null)).catch(() => null);
      if (paper2SlidesPath) {
        env.PYTHONPATH = env.PYTHONPATH
          ? `${paper2SlidesPath}${path.delimiter}${env.PYTHONPATH}`
          : paper2SlidesPath;
      }

      const { stdout, stderr } = await execFileAsync(
        'python',
        ['-m', 'paper2slides.export_pptx', '--input', inputPath, '--output', outputPath],
        {
          cwd: tempDir,
          env,
          maxBuffer: 15 * 1024 * 1024,
        },
      );

      if (process.env.NODE_ENV !== 'production') {
        console.log('[Paper2Slides Export] stdout:', stdout);
        if (stderr) {
          console.warn('[Paper2Slides Export] stderr:', stderr);
        }
      }

      const pptxBuffer = await fs.readFile(outputPath).catch(() => null);
      if (!pptxBuffer) {
        throw new Error('PPTX export did not produce an output file');
      }

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
    } finally {
      await cleanup();
    }
  }
}

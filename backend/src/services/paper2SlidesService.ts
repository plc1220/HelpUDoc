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
};

type InputFile = {
  name: string;
  buffer: Buffer;
};

type CollectedOutputs = {
  pdf?: string;
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
      if (IMAGE_EXTENSIONS.has(ext)) {
        images.push(resolved);
      }
    }
  }

  images.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { pdf, images };
};

const buildCommandArgs = (inputPath: string, options: Paper2SlidesOptions) => {
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
  return args;
};

export class Paper2SlidesService {
  private fileService: FileService;

  constructor(fileService: FileService) {
    this.fileService = fileService;
  }

  async generate(
    workspaceId: string,
    userId: string,
    files: InputFile[],
    options: Paper2SlidesOptions,
    jobId?: string,
  ): Promise<{ pdfPath?: string; slideImages?: string[]; htmlPath?: string; jobId?: string }> {
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
      const args = buildCommandArgs(inputPath, options);
      const env = { ...process.env };

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

      const outputsRoot = path.join(tempDir, 'outputs');
      const collected = await collectOutputs(outputsRoot);
      if (!collected.pdf && collected.images.length === 0) {
        throw new Error('Paper2Slides finished but no outputs were found');
      }

      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const runId = jobId || randomUUID();
      const folder = path.posix.join('presentations', jobId ? `slide_${runId}` : '');
      const baseName = jobId ? 'slides' : `paper2slides-${timestamp}`;
      let pdfPath: string | undefined;
      const slideImages: string[] = [];

      if (collected.pdf) {
        const pdfBuffer = await fs.readFile(collected.pdf);
        const relativeName = path.posix.join(folder, `${baseName}.pdf`);
        await this.fileService.createFile(workspaceId, relativeName, pdfBuffer, 'application/pdf', userId, {
          forceLocal: true,
        });
        pdfPath = relativeName;
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
}

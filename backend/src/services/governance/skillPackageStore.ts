import path from 'path';
import { promises as fs } from 'fs';
import type { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import { parse as parseYaml } from 'yaml';
import { skillsRoot } from '../skills/constants';
import { extractFrontmatter } from '../skills/frontmatter';
import { pathExists } from '../skills/registry';
import {
  FileSnapshot,
  SkillGovernanceError,
  computePackageManifestHash,
  governanceError,
  mimeTypeForPath,
  normalizeGovernedFilePath,
  sha256,
} from './skillGovernanceModel';

export const GOVERNED_VERSIONS_DIR = '.governed-versions';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class SkillPackageStore {
  private readonly blobRoot = path.join(skillsRoot, GOVERNED_VERSIONS_DIR, 'blobs');
  private readonly versionsRoot = path.join(skillsRoot, GOVERNED_VERSIONS_DIR, 'packages');

  constructor(
    private readonly db: Knex,
    private readonly assertPackageLimits: (files: FileSnapshot[]) => void,
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.blobRoot, { recursive: true }),
      fs.mkdir(this.versionsRoot, { recursive: true }),
    ]);
  }

  async persistBlob(buffer: Buffer, filePath: string, executable = false): Promise<FileSnapshot> {
    if (buffer.length > MAX_FILE_BYTES) {
      governanceError(422, 'SKILL_VALIDATION_FAILED', `File exceeds ${MAX_FILE_BYTES} byte limit`, { path: filePath });
    }
    const contentHash = sha256(buffer);
    const storageKey = path.join(this.blobRoot, contentHash.slice(0, 2), contentHash);
    await fs.mkdir(path.dirname(storageKey), { recursive: true });
    if (!await pathExists(storageKey)) {
      const temporary = `${storageKey}.${uuidv4()}.tmp`;
      await fs.writeFile(temporary, buffer, { mode: 0o600 });
      try {
        await fs.rename(temporary, storageKey);
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        await fs.rm(temporary, { force: true });
      }
    }
    const mimeType = mimeTypeForPath(filePath);
    await this.db('content_blobs').insert({
      contentHash,
      storageProvider: 'local',
      storageKey,
      sizeBytes: buffer.length,
      mimeType,
    }).onConflict('contentHash').ignore();
    return {
      path: filePath,
      contentHash,
      sizeBytes: buffer.length,
      mimeType,
      mode: executable ? 0o755 : 0o644,
    };
  }

  async readBlob(contentHash: string): Promise<Buffer> {
    const blob = await this.db('content_blobs').where({ contentHash }).first();
    if (!blob || blob.storageProvider !== 'local') {
      governanceError(503, 'SKILL_MATERIALIZATION_UNAVAILABLE', 'Immutable skill content is unavailable');
    }
    try {
      const content = await fs.readFile(blob.storageKey);
      if (sha256(content) !== contentHash) {
        governanceError(503, 'SKILL_MATERIALIZATION_UNAVAILABLE', 'Immutable skill content failed its integrity check');
      }
      return content;
    } catch (error) {
      if (error instanceof SkillGovernanceError) throw error;
      throw new SkillGovernanceError(503, 'SKILL_MATERIALIZATION_UNAVAILABLE', 'Immutable skill content cannot be read');
    }
  }

  async draftFiles(revisionId: string): Promise<FileSnapshot[]> {
    const rows = await this.db('skill_draft_revision_files')
      .where({ draftRevisionId: revisionId })
      .orderBy('path', 'asc');
    return rows.map((row: any) => ({
      path: row.path,
      contentHash: row.contentHash,
      sizeBytes: Number(row.sizeBytes),
      mimeType: row.mimeType || null,
      mode: Number(row.mode || 0o644),
    }));
  }

  async versionFiles(versionId: string): Promise<FileSnapshot[]> {
    const rows = await this.db('skill_version_files')
      .where({ skillVersionId: versionId })
      .orderBy('path', 'asc');
    return rows.map((row: any) => ({
      path: row.path,
      contentHash: row.contentHash,
      sizeBytes: Number(row.sizeBytes),
      mimeType: row.mimeType || null,
      mode: Number(row.mode || (row.executable ? 0o755 : 0o644)),
    }));
  }

  async materializeVersion(
    skillKey: string,
    versionId: string,
    manifestHash: string,
    files: FileSnapshot[],
  ): Promise<string> {
    if (computePackageManifestHash(files) !== manifestHash) {
      governanceError(503, 'SKILL_MATERIALIZATION_UNAVAILABLE', 'Frozen candidate manifest failed its integrity check');
    }
    const target = path.join(this.versionsRoot, skillKey, versionId);
    const temporary = `${target}.${uuidv4()}.tmp`;
    await fs.mkdir(temporary, { recursive: true });
    try {
      for (const file of files) {
        const normalizedPath = normalizeGovernedFilePath(file.path);
        const content = await this.readBlob(file.contentHash);
        const outputPath = path.resolve(temporary, normalizedPath);
        if (!outputPath.startsWith(`${path.resolve(temporary)}${path.sep}`)) {
          governanceError(503, 'SKILL_MATERIALIZATION_UNAVAILABLE', 'Candidate path escaped materialization boundary');
        }
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, content, { mode: file.mode });
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(temporary, target);
      return target;
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true });
      if (error instanceof SkillGovernanceError) throw error;
      throw new SkillGovernanceError(503, 'SKILL_MATERIALIZATION_UNAVAILABLE', 'Immutable package could not be materialized');
    }
  }

  async promoteDefaultPackage(skillKey: string, materializedPath: string): Promise<void> {
    if (!materializedPath || !await pathExists(materializedPath)) {
      governanceError(503, 'SKILL_MATERIALIZATION_UNAVAILABLE', 'The selected immutable package is not materialized');
    }
    const target = path.join(skillsRoot, skillKey);
    const temporary = path.join(skillsRoot, `.governed-default-${uuidv4()}`);
    const backup = path.join(skillsRoot, `.governed-backup-${uuidv4()}`);
    let movedExisting = false;
    try {
      await fs.cp(materializedPath, temporary, { recursive: true });
      if (await pathExists(target)) {
        await fs.rename(target, backup);
        movedExisting = true;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(temporary, target);
      if (movedExisting) await fs.rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (movedExisting && !await pathExists(target) && await pathExists(backup)) {
        await fs.rename(backup, target);
      }
      await fs.rm(temporary, { recursive: true, force: true });
      if (error instanceof SkillGovernanceError) throw error;
      throw new SkillGovernanceError(
        503,
        'SKILL_MATERIALIZATION_UNAVAILABLE',
        'The governed default package could not be promoted',
      );
    }
  }

  async snapshotDirectory(root: string): Promise<FileSnapshot[]> {
    const files: FileSnapshot[] = [];
    const visit = async (current: string): Promise<void> => {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await visit(absolute);
        } else if (entry.isFile()) {
          const relative = path.relative(root, absolute).replace(/\\/g, '/');
          try {
            normalizeGovernedFilePath(relative);
          } catch {
            continue;
          }
          const stat = await fs.stat(absolute);
          files.push(await this.persistBlob(await fs.readFile(absolute), relative, (stat.mode & 0o111) !== 0));
        }
      }
    };
    await visit(root);
    this.assertPackageLimits(files);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readSkillMetadata(files: FileSnapshot[]): Promise<{ name?: string; description?: string }> {
    const skillFile = files.find((file) => file.path === 'SKILL.md');
    if (!skillFile) return {};
    try {
      const raw = extractFrontmatter((await this.readBlob(skillFile.contentHash)).toString('utf-8'));
      const parsed = raw ? parseYaml(raw) : null;
      if (!parsed || typeof parsed !== 'object') return {};
      return {
        name: String((parsed as any).name || '').trim() || undefined,
        description: String((parsed as any).description || '').trim() || undefined,
      };
    } catch {
      return {};
    }
  }
}

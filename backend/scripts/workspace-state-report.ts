/**
 * Read-only workspace state report.
 *
 * Enumerates every workspace with its owner, members, file/artifact/knowledge
 * counts, on-disk and object-store footprint, plus the skill catalog and the
 * skill grants that decide who can use each skill. Nothing is written or
 * migrated — this is the "check current state for all users and/or skills"
 * half of a snapshot/migration workflow.
 *
 * Usage:
 *   npm run report:workspace-state            # human-readable tables
 *   npm run report:workspace-state -- --json  # machine-readable JSON
 *
 * Honors ENV_FILE (like the daily-reflection job) for pointing at a specific
 * environment's .env. DB access is required; the workspace filesystem and S3
 * are best-effort and reported as "unavailable" if they cannot be reached.
 */
import * as dotenv from 'dotenv';

const envFile = process.env.ENV_FILE;
if (envFile) {
  dotenv.config({ path: envFile });
} else {
  dotenv.config();
}

import { promises as fs } from 'fs';
import * as path from 'path';
import { DatabaseService } from '../src/services/databaseService';
import { S3Service } from '../src/services/s3Service';
import { resolveWorkspaceRoot } from '../src/config/workspaceRoot';
import { collectSkillIds } from '../src/lib/skillsRegistry';
import { skillsRoot } from '../src/services/skills/constants';

type CountMap = Map<string, number>;

interface DiskStats {
  fileCount: number;
  totalBytes: number;
  exists: boolean;
}

interface WorkspaceReport {
  id: string;
  name: string;
  slug: string;
  owner: { id: string; email: string | null; displayName: string | null } | null;
  memberCount: number;
  files: number;
  filesLocal: number;
  filesS3: number;
  derivedArtifacts: number;
  knowledgeSources: number;
  conversations: number;
  messages: number;
  disk: DiskStats | { error: string };
  objectStore: { objectCount: number; totalBytes: number } | { error: string };
  updatedAt: string;
}

function toCountMap(rows: Array<{ key: string | null; count: string | number }>): CountMap {
  const map: CountMap = new Map();
  for (const row of rows) {
    if (row.key == null) continue;
    map.set(String(row.key), Number(row.count));
  }
  return map;
}

async function directoryStats(root: string): Promise<DiskStats | { error: string }> {
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      return { fileCount: 0, totalBytes: 0, exists: false };
    }
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return { fileCount: 0, totalBytes: 0, exists: false };
    }
    return { error: error?.message || String(error) };
  }

  let fileCount = 0;
  let totalBytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        fileCount += 1;
        try {
          totalBytes += (await fs.stat(full)).size;
        } catch {
          /* file vanished mid-walk; ignore */
        }
      }
    }
  };
  try {
    await walk(root);
  } catch (error: any) {
    return { error: error?.message || String(error) };
  }
  return { fileCount, totalBytes, exists: true };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const databaseService = new DatabaseService();
  const db = databaseService.getDb();

  try {
    // --- Workspaces + owners -------------------------------------------------
    const workspaces = await db('workspaces as w')
      .leftJoin('users as u', 'w.ownerId', 'u.id')
      .select(
        'w.id as id',
        'w.name as name',
        'w.slug as slug',
        'w.updatedAt as updatedAt',
        'w.ownerId as ownerId',
        'u.email as ownerEmail',
        'u.displayName as ownerDisplayName',
      )
      .orderBy('w.createdAt', 'asc');

    // --- Per-workspace aggregate counts (grouped queries, not N+1) ----------
    const memberCounts = toCountMap(
      await db('workspace_members').select('workspaceId as key').count({ count: '*' }).groupBy('workspaceId'),
    );
    const fileCounts = toCountMap(
      await db('files').select('workspaceId as key').count({ count: '*' }).groupBy('workspaceId'),
    );
    const fileStorageRows = await db('files')
      .select('workspaceId', 'storageType')
      .count({ count: '*' })
      .groupBy('workspaceId', 'storageType');
    const localFileCounts: CountMap = new Map();
    const s3FileCounts: CountMap = new Map();
    for (const row of fileStorageRows as Array<{ workspaceId: string; storageType: string; count: string | number }>) {
      const target = row.storageType === 's3' ? s3FileCounts : localFileCounts;
      target.set(row.workspaceId, Number(row.count));
    }
    const artifactCounts = toCountMap(
      await db('derived_artifacts').select('workspaceId as key').count({ count: '*' }).groupBy('workspaceId'),
    );
    const knowledgeCounts = toCountMap(
      await db('knowledge_sources').select('workspaceId as key').count({ count: '*' }).groupBy('workspaceId'),
    );
    const conversationCounts = toCountMap(
      await db('conversations').select('workspaceId as key').count({ count: '*' }).groupBy('workspaceId'),
    );
    const messageCounts = toCountMap(
      await db('conversation_messages as m')
        .join('conversations as c', 'm.conversationId', 'c.id')
        .select('c.workspaceId as key')
        .count({ count: '*' })
        .groupBy('c.workspaceId'),
    );

    // --- Filesystem + object-store footprint --------------------------------
    const workspaceRoot = resolveWorkspaceRoot();
    let s3Service: S3Service | null = null;
    let s3InitError: string | null = null;
    try {
      s3Service = new S3Service();
    } catch (error: any) {
      s3InitError = error?.message || String(error);
    }

    const workspaceReports: WorkspaceReport[] = [];
    for (const w of workspaces) {
      const disk = await directoryStats(path.join(workspaceRoot, w.id));
      let objectStore: WorkspaceReport['objectStore'];
      if (!s3Service) {
        objectStore = { error: s3InitError || 'S3 not configured' };
      } else {
        try {
          objectStore = await s3Service.getPrefixStats(`${w.id}/`);
        } catch (error: any) {
          objectStore = { error: error?.message || String(error) };
        }
      }
      workspaceReports.push({
        id: w.id,
        name: w.name,
        slug: w.slug,
        owner: w.ownerId
          ? { id: w.ownerId, email: w.ownerEmail ?? null, displayName: w.ownerDisplayName ?? null }
          : null,
        memberCount: memberCounts.get(w.id) ?? 0,
        files: fileCounts.get(w.id) ?? 0,
        filesLocal: localFileCounts.get(w.id) ?? 0,
        filesS3: s3FileCounts.get(w.id) ?? 0,
        derivedArtifacts: artifactCounts.get(w.id) ?? 0,
        knowledgeSources: knowledgeCounts.get(w.id) ?? 0,
        conversations: conversationCounts.get(w.id) ?? 0,
        messages: messageCounts.get(w.id) ?? 0,
        disk,
        objectStore,
        updatedAt: w.updatedAt instanceof Date ? w.updatedAt.toISOString() : String(w.updatedAt),
      });
    }

    // --- Skills: catalog + grants -------------------------------------------
    let skillCatalog: string[] = [];
    let skillCatalogError: string | null = null;
    try {
      await fs.mkdir(skillsRoot, { recursive: true });
      skillCatalog = (await collectSkillIds(skillsRoot)).sort();
    } catch (error: any) {
      skillCatalogError = error?.message || String(error);
    }

    const grantRows = await db('skill_grants')
      .select('principalType', 'principalId', 'skillId', 'effect')
      .orderBy(['principalType', 'principalId', 'skillId']);

    // Resolve principal labels with lookup maps rather than value-joins.
    const userLabels = new Map<string, string>();
    for (const u of await db('users').select('id', 'email', 'displayName')) {
      userLabels.set(u.id, u.email || u.displayName || u.id);
    }
    const groupLabels = new Map<string, string>();
    for (const g of await db('groups').select('id', 'name')) {
      groupLabels.set(g.id, g.name || g.id);
    }

    const skillGrants = grantRows.map((row: any) => ({
      principalType: row.principalType as string,
      principalId: row.principalId as string,
      principalLabel:
        row.principalType === 'user'
          ? userLabels.get(row.principalId) || row.principalId
          : row.principalType === 'group'
            ? groupLabels.get(row.principalId) || row.principalId
            : row.principalId,
      skillId: row.skillId as string,
      effect: row.effect as string,
    }));

    // --- Totals --------------------------------------------------------------
    const totals = {
      users: userLabels.size,
      workspaces: workspaceReports.length,
      skillCatalog: skillCatalog.length,
      skillGrants: skillGrants.length,
      files: workspaceReports.reduce((n, w) => n + w.files, 0),
      derivedArtifacts: workspaceReports.reduce((n, w) => n + w.derivedArtifacts, 0),
      knowledgeSources: workspaceReports.reduce((n, w) => n + w.knowledgeSources, 0),
      conversations: workspaceReports.reduce((n, w) => n + w.conversations, 0),
      messages: workspaceReports.reduce((n, w) => n + w.messages, 0),
    };

    const report = {
      generatedAt: new Date().toISOString(),
      workspaceRoot,
      skillsRoot,
      totals,
      workspaces: workspaceReports,
      skillCatalog: skillCatalogError ? { error: skillCatalogError } : skillCatalog,
      skillGrants,
    };

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    renderHuman(report);
  } finally {
    await db.destroy();
  }
}

function renderHuman(report: {
  generatedAt: string;
  workspaceRoot: string;
  skillsRoot: string;
  totals: Record<string, number>;
  workspaces: WorkspaceReport[];
  skillCatalog: string[] | { error: string };
  skillGrants: Array<{ principalType: string; principalLabel: string; skillId: string; effect: string }>;
}): void {
  const line = (s = '') => console.log(s);
  line('='.repeat(72));
  line('WORKSPACE STATE REPORT');
  line(`generated: ${report.generatedAt}`);
  line(`workspaceRoot: ${report.workspaceRoot}`);
  line(`skillsRoot:    ${report.skillsRoot}`);
  line('='.repeat(72));
  line('TOTALS');
  for (const [k, v] of Object.entries(report.totals)) {
    line(`  ${k.padEnd(18)} ${v}`);
  }

  line();
  line(`WORKSPACES (${report.workspaces.length})`);
  for (const w of report.workspaces) {
    const owner = w.owner ? w.owner.email || w.owner.displayName || w.owner.id : '(no owner)';
    const diskStr =
      'error' in w.disk
        ? `disk: err(${w.disk.error})`
        : w.disk.exists
          ? `disk: ${w.disk.fileCount} files / ${formatBytes(w.disk.totalBytes)}`
          : 'disk: (empty)';
    const s3Str =
      'error' in w.objectStore
        ? `s3: err(${w.objectStore.error})`
        : `s3: ${w.objectStore.objectCount} obj / ${formatBytes(w.objectStore.totalBytes)}`;
    line(`  • ${w.name}  [${w.id}]`);
    line(`      owner=${owner}  members=${w.memberCount}  updated=${w.updatedAt}`);
    line(
      `      files=${w.files} (local ${w.filesLocal} / s3 ${w.filesS3})  artifacts=${w.derivedArtifacts}  ` +
        `knowledge=${w.knowledgeSources}  conversations=${w.conversations}  messages=${w.messages}`,
    );
    line(`      ${diskStr}  ${s3Str}`);
  }

  line();
  if ('error' in report.skillCatalog) {
    line(`SKILL CATALOG: error(${report.skillCatalog.error})`);
  } else {
    line(`SKILL CATALOG (${report.skillCatalog.length})`);
    for (const s of report.skillCatalog) {
      line(`  - ${s}`);
    }
  }

  line();
  line(`SKILL GRANTS (${report.skillGrants.length})`);
  if (report.skillGrants.length === 0) {
    line('  (none — every principal falls back to default skill policy)');
  }
  for (const g of report.skillGrants) {
    line(`  [${g.effect.toUpperCase().padEnd(5)}] ${g.principalType}:${g.principalLabel} → ${g.skillId}`);
  }
  line('='.repeat(72));
}

main().catch((error) => {
  console.error('Failed to generate workspace state report');
  console.error(error);
  process.exitCode = 1;
});

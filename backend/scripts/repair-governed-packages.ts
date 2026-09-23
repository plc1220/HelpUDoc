/**
 * Repair stranded governed skill version pins.
 *
 * Failure mode this fixes
 * -----------------------
 * The skills PVC sync used to delete `/app/skills/.governed-versions`, which holds the
 * materialized immutable packages and the content blobs they were built from. Postgres keeps
 * every `skill_versions` row, so `materializedPath` continues to point at a directory that no
 * longer exists. Because `getDefaultSkillRuntimePins` issues a pin for every entitled skill,
 * `find_skill_for_context` takes the pin branch, fails to materialize, and returns `None` with
 * no fallback. The result is that *every* skill silently disappears at runtime.
 *
 * `backfillLegacyRegistry` cannot recover this: it skips any skillKey already present in the
 * `skills` table, so it never re-materializes an existing skill.
 *
 * Strategy
 * --------
 * For each skill whose active default version is not materialized on disk, publish the current
 * registry content as a NEW immutable version (fresh versionId, blobs, and manifest hash) and
 * point `defaultVersionId` at it. Prior version rows are left intact so governance history and
 * audit trail survive. This is additive and idempotent: a skill that already resolves is skipped.
 *
 * The original published bytes are unrecoverable once the blobs are gone, so re-snapshotting the
 * working registry is the only available recovery. That also lands whatever the current
 * `SKILL.md` says, which is usually newer than the stranded version.
 *
 * Usage
 * -----
 *   ts-node scripts/repair-governed-packages.ts            # dry run, reports only
 *   ts-node scripts/repair-governed-packages.ts --apply    # perform the repair
 *   ts-node scripts/repair-governed-packages.ts --apply --only research
 */

import path from 'path';
import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../src/services/databaseService';
import { SkillGovernanceService } from '../src/services/governance/skillGovernanceService';
import { skillsRoot } from '../src/services/skills/constants';
import {
  computePackageManifestHash,
  displayNameFromKey,
  GOVERNANCE_POLICY_VERSION,
} from '../src/services/governance/skillGovernanceModel';

type SkillRow = {
  id: string;
  skillKey: string;
  displayName: string | null;
  defaultVersionId: string | null;
  ownerTeamId: string;
  versionId: string | null;
  semanticVersion: string | null;
  materializedPath: string | null;
  versionStatus: string | null;
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
};

/** Bump the patch component so the new version cannot collide with existing rows. */
const nextPatchVersion = (current: string | null, taken: Set<string>): string => {
  const parts = String(current || '1.0.0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  let [major, minor, patch] = [parts[0] ?? 1, parts[1] ?? 0, parts[2] ?? 0];
  do {
    patch += 1;
  } while (taken.has(`${major}.${minor}.${patch}`));
  return `${major}.${minor}.${patch}`;
};

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  // --force republishes even when the package is materialized. Needed after a change to the
  // manifest-hash algorithm, where the package exists on disk but its stored digest can no
  // longer be reproduced by the agent.
  const force = process.argv.includes('--force');
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;

  const database = new DatabaseService();
  await database.initialize();
  const db = database.getDb();

  // Construct the service purely to reuse its package store (snapshot + materialize + blobs).
  const governance = new SkillGovernanceService(database);
  const packageStore = (governance as any).packageStore as {
    initialize(): Promise<void>;
    snapshotDirectory(root: string): Promise<any[]>;
    materializeVersion(skillKey: string, versionId: string, manifestHash: string, files: any[]): Promise<string>;
    promoteDefaultPackage(skillKey: string, materializedPath: string): Promise<void>;
    readSkillMetadata(files: any[]): Promise<{ name?: string; description?: string }>;
  };
  await packageStore.initialize();

  const skills: SkillRow[] = await db('skills as s')
    .leftJoin('skill_versions as v', 'v.id', 's.defaultVersionId')
    .select(
      's.id',
      's.skillKey',
      's.displayName',
      's.defaultVersionId',
      's.ownerTeamId',
      'v.id as versionId',
      'v.semanticVersion',
      'v.materializedPath',
      'v.status as versionStatus',
    )
    .orderBy('s.skillKey', 'asc');

  const stranded: SkillRow[] = [];
  for (const skill of skills) {
    if (only && skill.skillKey !== only) continue;
    const resolved = skill.materializedPath
      && await pathExists(path.join(skill.materializedPath, 'SKILL.md'));
    if (!resolved || force) stranded.push(skill);
  }

  console.log(`skills inspected : ${only ? 1 : skills.length}`);
  console.log(`${force ? 'forced republish' : 'stranded pins   '} : ${stranded.length}`);
  if (!stranded.length) {
    console.log('Nothing to repair.');
    await db.destroy();
    return;
  }

  for (const skill of stranded) {
    console.log(`  - ${skill.skillKey} (v${skill.semanticVersion ?? '?'}) -> ${skill.materializedPath ?? 'no materializedPath'}`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to publish a replacement version for each entry above.');
    await db.destroy();
    return;
  }

  let repaired = 0;
  let skipped = 0;

  for (const skill of stranded) {
    const packageRoot = path.join(skillsRoot, skill.skillKey);
    if (!await pathExists(path.join(packageRoot, 'SKILL.md'))) {
      console.warn(`SKIP ${skill.skillKey}: no SKILL.md in the runtime registry at ${packageRoot}`);
      skipped += 1;
      continue;
    }

    // Re-hash and re-store the current package bytes; this repopulates content_blobs too.
    const files = await packageStore.snapshotDirectory(packageRoot);
    if (!files.some((file) => file.path === 'SKILL.md')) {
      console.warn(`SKIP ${skill.skillKey}: snapshot produced no SKILL.md`);
      skipped += 1;
      continue;
    }

    const manifestHash = computePackageManifestHash(files);
    const existingVersions: Array<{ semanticVersion: string }> = await db('skill_versions')
      .select('semanticVersion')
      .where({ skillId: skill.id });
    const taken = new Set(existingVersions.map((row) => String(row.semanticVersion)));
    const semanticVersion = nextPatchVersion(skill.semanticVersion, taken);
    const versionId = uuidv4();

    const materializedPath = await packageStore.materializeVersion(
      skill.skillKey,
      versionId,
      manifestHash,
      files,
    );

    const metadata = await packageStore.readSkillMetadata(files);

    try {
      await db.transaction(async (tx) => {
        await tx('skill_versions').insert({
          id: versionId,
          skillId: skill.id,
          semanticVersion,
          manifestHash,
          status: 'active',
          validationSummary: JSON.stringify({
            repaired: true,
            reason: 'materialized package missing; republished from runtime registry',
            policyVersion: GOVERNANCE_POLICY_VERSION,
          }),
          materializedPath,
          activatedAt: tx.fn.now(),
        });
        await tx('skill_version_files').insert(files.map((file) => ({
          skillVersionId: versionId,
          path: file.path,
          contentHash: file.contentHash,
          executable: (file.mode & 0o111) !== 0,
          mode: file.mode,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
        })));
        await tx('skills').where({ id: skill.id }).update({
          defaultVersionId: versionId,
          displayName: skill.displayName || metadata.name || displayNameFromKey(skill.skillKey),
          status: 'active',
          updatedAt: tx.fn.now(),
        });
      });
    } catch (error) {
      await fs.rm(materializedPath, { recursive: true, force: true });
      throw error;
    }

    await (governance as any).audit({
      actorUserId: null,
      actorRole: 'migration',
      action: 'skill.repaired',
      resourceType: 'skill',
      resourceId: skill.id,
      policyVersion: GOVERNANCE_POLICY_VERSION,
      metadata: {
        skillKey: skill.skillKey,
        versionId,
        manifestHash,
        semanticVersion,
        previousVersionId: skill.versionId,
      },
    });

    console.log(`OK   ${skill.skillKey} -> v${semanticVersion} (${versionId})`);
    repaired += 1;
  }

  console.log(`\nrepaired: ${repaired}  skipped: ${skipped}`);
  await db.destroy();
}

main().catch((error) => {
  console.error('repair failed:', error);
  process.exit(1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Knex } from 'knex';
import { SkillPackageStore } from '../src/services/governance/skillPackageStore';
import { computePackageManifestHash, sha256 } from '../src/services/governance/skillGovernanceModel';

type BlobRow = {
  contentHash: string;
  storageProvider: string;
  storageKey: string;
  sizeBytes: number;
  mimeType: string | null;
};

function fakeDatabase(rows: Map<string, BlobRow>): Knex {
  const db = ((table: string) => {
    assert.equal(table, 'content_blobs');
    let where: Record<string, unknown> = {};
    const matchingRows = () => [...rows.values()].filter((row) => (
      Object.entries(where).every(([key, value]) => row[key as keyof BlobRow] === value)
    ));
    const query: any = {
      select: () => query,
      where: (criteria: Record<string, unknown>) => {
        where = criteria;
        return query;
      },
      first: async () => matchingRows()[0],
      update: async (values: Partial<BlobRow>) => {
        const matches = matchingRows();
        for (const row of matches) Object.assign(row, values);
        return matches.length;
      },
      insert: (row: BlobRow) => ({
        onConflict: () => ({
          ignore: async () => {
            if (!rows.has(row.contentHash)) rows.set(row.contentHash, { ...row });
          },
        }),
      }),
      then: (resolve: (value: BlobRow[]) => unknown, reject: (error: unknown) => unknown) => (
        Promise.resolve(matchingRows()).then(resolve, reject)
      ),
    };
    return query;
  }) as unknown as Knex;
  return db;
}

test('local blob keys remain readable when the skills root changes', async () => {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helpudoc-skill-store-a-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helpudoc-skill-store-b-'));
  const rows = new Map<string, BlobRow>();
  try {
    const firstStore = new SkillPackageStore(fakeDatabase(rows), () => undefined, firstRoot);
    await firstStore.initialize();
    const snapshot = await firstStore.persistBlob(Buffer.from('portable content'), 'SKILL.md');
    const row = rows.get(snapshot.contentHash)!;
    assert.equal(row.storageKey, `blobs/${snapshot.contentHash.slice(0, 2)}/${snapshot.contentHash}`);

    await fs.cp(
      path.join(firstRoot, '.governed-versions'),
      path.join(secondRoot, '.governed-versions'),
      { recursive: true },
    );
    row.storageKey = path.join(firstRoot, '.governed-versions', row.storageKey);

    const secondStore = new SkillPackageStore(fakeDatabase(rows), () => undefined, secondRoot);
    await secondStore.initialize();
    assert.equal(row.storageKey, `blobs/${snapshot.contentHash.slice(0, 2)}/${snapshot.contentHash}`);
    assert.equal((await secondStore.readBlob(snapshot.contentHash)).toString(), 'portable content');
  } finally {
    await Promise.all([
      fs.rm(firstRoot, { recursive: true, force: true }),
      fs.rm(secondRoot, { recursive: true, force: true }),
    ]);
  }
});

// Shared with agent/tests/test_governed_skill_resolution.py. The agent checks a
// package against the hash the backend signs, so both suites pin the same value:
// a change to either side's manifest fails one of them.
const PARITY_FILES: Record<string, string> = {
  'SKILL.md': '---\nname: Manifest parity\ndescription: cross-runtime fixture\n---\n\n# Manifest parity\n',
  'references/guide.md': '# Guide\n',
  'scripts/run.js': 'console.log(24);\n',
};
const PARITY_MANIFEST_HASH = '291d4b7acf8e5cc6d88af50f822b0237d90f49e6b54a0ec165408e2a4da64717';

test('a materialized package carries the exact manifest text its hash is taken over', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'helpudoc-skill-sidecar-'));
  const rows = new Map<string, BlobRow>();
  try {
    const store = new SkillPackageStore(fakeDatabase(rows), () => undefined, root);
    await store.initialize();
    const files = await Promise.all(Object.entries(PARITY_FILES).map(
      ([filePath, content]) => store.persistBlob(Buffer.from(content, 'utf-8'), filePath),
    ));
    const manifestHash = computePackageManifestHash(files);
    assert.equal(manifestHash, PARITY_MANIFEST_HASH);

    const versionId = '2c1f6d3e-8a4b-4c5d-9e6f-7a8b9c0d1e2f';
    const packagePath = await store.materializeVersion('parity-skill', versionId, manifestHash, files);
    await store.writeManifestSidecar('parity-skill', versionId, files);

    const sidecarPath = store.manifestSidecarPath('parity-skill', versionId);
    assert.equal(path.dirname(sidecarPath), path.dirname(packagePath));
    const sidecar = await fs.readFile(sidecarPath);
    assert.equal(sha256(sidecar), manifestHash);
    // Beside the package, never in it: inside, it would change the hash it records.
    assert.deepEqual((await store.snapshotDirectory(packagePath)).map((file) => file.path).sort(),
      Object.keys(PARITY_FILES).sort());

    // A second write of the same manifest leaves the file alone.
    const { mtimeMs } = await fs.stat(sidecarPath);
    await store.writeManifestSidecar('parity-skill', versionId, files);
    assert.equal((await fs.stat(sidecarPath)).mtimeMs, mtimeMs);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

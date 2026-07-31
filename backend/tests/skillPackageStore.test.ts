import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Knex } from 'knex';
import { SkillPackageStore } from '../src/services/governance/skillPackageStore';

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

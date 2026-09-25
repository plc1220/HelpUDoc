import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { computeOnDiskManifestHash } from '../src/services/governance/packageIntegrity';
import { computePackageManifestHash } from '../src/services/governance/skillGovernanceModel';

const withPackage = async (
  files: Array<{ path: string; content: string; mode?: number }>,
  run: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'helpudoc-pkg-'));
  try {
    for (const file of files) {
      const absolute = path.join(root, file.path);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, file.content, { mode: file.mode ?? 0o644 });
    }
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

test('on-disk hash agrees with the manifest hash computed from database rows', async () => {
  // This is the cross-language contract: whatever the backend froze at publish time must be
  // reproducible by hashing the materialized bytes, or the agent rejects the signed pin.
  const files = [
    { path: 'SKILL.md', content: '---\nname: research\n---\n' },
    { path: 'scripts/count_words.py', content: 'print(1)\n' },
  ];

  await withPackage(files, async (root) => {
    const fromDisk = await computeOnDiskManifestHash(root);
    const fromRows = computePackageManifestHash(files.map((file) => ({
      path: file.path,
      contentHash: crypto.createHash('sha256').update(file.content).digest('hex'),
      mode: 0o644,
      sizeBytes: Buffer.byteLength(file.content),
    })));

    assert.equal(fromDisk, fromRows);
  });
});

test('a changed byte in a still-present file changes the hash', async () => {
  // The failure the previous deploy guard missed: the package exists, so an existence check
  // passes, while the agent computes a different digest and refuses to load the skill.
  let original: string | null = null;
  await withPackage([{ path: 'SKILL.md', content: 'original\n' }], async (root) => {
    original = await computeOnDiskManifestHash(root);
    await fs.writeFile(path.join(root, 'SKILL.md'), 'tampered\n');
    const tampered = await computeOnDiskManifestHash(root);

    assert.ok(original);
    assert.notEqual(tampered, original);
  });
});

test('entries are ordered by byte value, not locale collation', async () => {
  // 'SKILL.md' sorts before 'scripts/...' by byte order and after it under locale collation.
  // Getting this wrong is what made every multi-file package unverifiable.
  await withPackage(
    [
      { path: 'SKILL.md', content: 'a' },
      { path: 'scripts/run.py', content: 'b' },
    ],
    async (root) => {
      const expected = crypto.createHash('sha256').update(JSON.stringify([
        {
          path: 'SKILL.md',
          contentHash: crypto.createHash('sha256').update('a').digest('hex'),
          mode: 0o644,
          sizeBytes: 1,
        },
        {
          path: 'scripts/run.py',
          contentHash: crypto.createHash('sha256').update('b').digest('hex'),
          mode: 0o644,
          sizeBytes: 1,
        },
      ]), 'utf8').digest('hex');

      assert.equal(await computeOnDiskManifestHash(root), expected);
    },
  );
});

test('file mode is part of the identity', async () => {
  await withPackage([{ path: 'run.sh', content: '#!/bin/sh\n', mode: 0o644 }], async (root) => {
    const before = await computeOnDiskManifestHash(root);
    await fs.chmod(path.join(root, 'run.sh'), 0o755);

    assert.notEqual(await computeOnDiskManifestHash(root), before);
  });
});

test('a symlink invalidates the package', async () => {
  // Mirrors the agent, which refuses to hash a package containing a symlink rather than
  // following it outside the package boundary.
  await withPackage([{ path: 'SKILL.md', content: 'x' }], async (root) => {
    await fs.symlink('/etc/passwd', path.join(root, 'link'));

    assert.equal(await computeOnDiskManifestHash(root), null);
  });
});

test('a missing package yields null rather than a hash', async () => {
  assert.equal(
    await computeOnDiskManifestHash(path.join(os.tmpdir(), 'helpudoc-does-not-exist-xyz')),
    null,
  );
});

test('nested directories are included', async () => {
  await withPackage([{ path: 'SKILL.md', content: 'x' }], async (root) => {
    const before = await computeOnDiskManifestHash(root);
    await fs.mkdir(path.join(root, 'references', 'deep'), { recursive: true });
    await fs.writeFile(path.join(root, 'references', 'deep', 'note.md'), 'y');

    assert.notEqual(await computeOnDiskManifestHash(root), before);
  });
});

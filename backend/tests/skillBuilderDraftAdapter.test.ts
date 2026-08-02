import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { builderActionsToDraftMutation } from '../src/services/governance/skillBuilderDraftAdapter';

test('Skill Creator actions become one governed draft mutation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'helpudoc-skill-builder-'));
  const binaryPath = path.join(directory, 'reference.png');
  await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 255]));

  try {
    const mutation = await builderActionsToDraftMutation([
      {
        type: 'create_skill',
        skillId: ' Reports/Weekly ',
        name: ' Weekly report ',
        description: ' Build a dependable weekly report. ',
      },
      {
        type: 'upsert_text',
        skillId: 'reports/weekly',
        path: 'SKILL.md',
        content: '# Weekly report',
      },
      {
        type: 'upload_binary_from_context',
        skillId: 'reports/weekly',
        contextFileId: 'context-1',
        targetPath: 'assets/reference.png',
      },
      {
        type: 'delete_file',
        skillId: 'reports/weekly',
        path: 'references/old.md',
      },
    ], [{ fileId: 'context-1', absolutePath: binaryPath }]);

    assert.equal(mutation.proposedSkillKey, 'reports/weekly');
    assert.equal(mutation.displayName, 'Weekly report');
    assert.equal(mutation.description, 'Build a dependable weekly report.');
    assert.deepEqual(mutation.deletePaths, ['references/old.md']);
    assert.deepEqual(mutation.files, [
      { path: 'SKILL.md', content: '# Weekly report', encoding: 'utf-8' },
      { path: 'assets/reference.png', content: Buffer.from([0, 1, 2, 255]).toString('base64'), encoding: 'base64' },
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Skill Creator proposals cannot modify multiple governed skills at once', async () => {
  await assert.rejects(
    () => builderActionsToDraftMutation([
      { type: 'upsert_text', skillId: 'reports/weekly', path: 'SKILL.md', content: 'one' },
      { type: 'upsert_text', skillId: 'reports/monthly', path: 'SKILL.md', content: 'two' },
    ], []),
    (error: any) => error?.code === 'INVALID_SKILL_MANIFEST',
  );
});

test('Skill Creator binary actions are limited to uploaded context files', async () => {
  await assert.rejects(
    () => builderActionsToDraftMutation([
      {
        type: 'upload_binary_from_context',
        skillId: 'reports/weekly',
        contextFileId: 'missing',
        targetPath: 'assets/reference.png',
      },
    ], []),
    (error: any) => error?.code === 'SKILL_RESOURCE_NOT_FOUND',
  );
});

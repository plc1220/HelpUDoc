import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { importGithubSkill, parseGithubSkillUrl } from '../src/services/governance/skillGithubImport';

const commit = 'a'.repeat(40);
const content = '---\nname: Example\ndescription: Example skill\n---\nRead the document.\n';
const bytes = Buffer.from(content);
const sha = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function fixture(overrides: Record<string, any> = {}) {
  const calls: string[] = [];
  const fetcher = async (input: any, init: any) => {
    calls.push(String(input));
    assert.equal(new URL(input).hostname, 'api.github.com');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, undefined);
    const data = String(input).includes('/commits/') ? { sha: commit } : String(input).includes('/trees/')
      ? { tree: [{ path: 'skills/example/SKILL.md', type: 'blob', mode: '100644', size: bytes.length, sha, ...overrides }], truncated: false }
      : { encoding: 'base64', content: bytes.toString('base64') };
    return new Response(JSON.stringify(data));
  };
  return { calls, fetcher: fetcher as typeof fetch };
}
test('imports a skill folder at an immutable commit with integrity and provenance', async () => {
  const { fetcher, calls } = fixture();
  const result = await importGithubSkill('https://github.com/example/repo/tree/main/skills/example', fetcher);
  assert.equal(result.source.commit, commit);
  assert.equal(result.files[0].path, 'SKILL.md');
  assert.equal(result.files[0].content, content);
  assert.match(result.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(calls[1].includes(`/trees/${commit}?`));
});
test('supports SKILL.md permalinks and rejects non-GitHub or credentialed links', () => {
  assert.equal(parseGithubSkillUrl(`https://github.com/example/repo/blob/${commit}/skills/example/SKILL.md`).blob, true);
  for (const url of ['http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://user:pass@github.com/a/b', 'https://127.0.0.1/a/b', 'https://github.com/a/b?token=secret']) assert.throws(() => parseGithubSkillUrl(url));
});
test('rejects symlinks and oversized packages before fetching blobs', async () => {
  for (const overrides of [{ mode: '120000' }, { size: 3 * 1024 * 1024 }]) {
    const { fetcher, calls } = fixture(overrides);
    await assert.rejects(importGithubSkill('https://github.com/example/repo/tree/main/skills/example', fetcher));
    assert.equal(calls.length, 2);
  }
});
test('rejects corrupted blob contents', async () => {
  const { fetcher } = fixture({ sha: 'b'.repeat(40) });
  await assert.rejects(importGithubSkill('https://github.com/example/repo/tree/main/skills/example', fetcher), /integrity/);
});
test('repository roots require choosing the actual skill folder', async () => {
  const { fetcher } = fixture();
  await assert.rejects(importGithubSkill('https://github.com/example/repo', fetcher), /skills\/example\/SKILL.md/);
});

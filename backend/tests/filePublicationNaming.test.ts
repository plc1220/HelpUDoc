import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProvenanceName,
  buildPublicationKey,
  buildPublishedName,
  buildTargetUri,
} from '../src/services/filePublicationNaming';

test('the version goes before the extension', () => {
  assert.equal(buildPublishedName('reports/q3.md', 1), 'reports/q3-v1.md');
  assert.equal(buildPublishedName('reports/q3.md', 2), 'reports/q3-v2.md');
  assert.equal(buildPublishedName('q3.md', 1), 'q3-v1.md');
});

test('only the final extension is treated as one', () => {
  // `a-v2.final.md` would be wrong: the artifact must keep opening as markdown.
  assert.equal(buildPublishedName('a.final.md', 2), 'a.final-v2.md');
  assert.equal(buildPublishedName('archive.tar.gz', 3), 'archive.tar-v3.gz');
});

test('files with no extension still get a version', () => {
  assert.equal(buildPublishedName('LICENSE', 1), 'LICENSE-v1');
  assert.equal(buildPublishedName('docs/README', 4), 'docs/README-v4');
});

test('dotfiles are not mistaken for extensions', () => {
  // basename '.env' has no stem, so the whole name is the extension.
  assert.equal(buildPublishedName('.env', 1), '.env-v1');
});

test('nested directories are preserved', () => {
  assert.equal(buildPublishedName('a/b/c/deep.md', 7), 'a/b/c/deep-v7.md');
});

test('double-digit versions do not collide with single-digit ones', () => {
  const v1 = buildPublishedName('q3.md', 1);
  const v10 = buildPublishedName('q3.md', 10);
  assert.equal(v10, 'q3-v10.md');
  assert.notEqual(v1, v10);
});

test('a renamed file publishes under its current name', () => {
  // v1 and v3 having different basenames is intended: the publication row
  // records the source path, so history stays honest.
  assert.equal(buildPublishedName('reports/q3.md', 1), 'reports/q3-v1.md');
  assert.equal(buildPublishedName('archive/q3-final.md', 2), 'archive/q3-final-v2.md');
});

test('leading slashes and backslashes are normalized away', () => {
  assert.equal(buildPublishedName('/reports/q3.md', 1), 'reports/q3-v1.md');
  assert.equal(buildPublishedName('reports\\q3.md', 1), 'reports/q3-v1.md');
});

test('invalid input is refused rather than producing a bad key', () => {
  assert.throws(() => buildPublishedName('', 1), /no path/);
  assert.throws(() => buildPublishedName('a.md', 0), /positive integer/);
  assert.throws(() => buildPublishedName('a.md', -1), /positive integer/);
  assert.throws(() => buildPublishedName('a.md', 1.5), /positive integer/);
});

test('the provenance document sits beside its artifact', () => {
  assert.equal(buildProvenanceName('reports/q3-v2.md'), 'reports/q3-v2.md.provenance.json');
});

test('keys are namespaced by workspace', () => {
  // Two workspaces may each hold reports/summary.md.
  const a = buildPublicationKey({ prefix: 'published', workspaceId: 'ws-a', publishedName: 'reports/s-v1.md' });
  const b = buildPublicationKey({ prefix: 'published', workspaceId: 'ws-b', publishedName: 'reports/s-v1.md' });
  assert.equal(a, 'published/ws-a/reports/s-v1.md');
  assert.notEqual(a, b);
});

test('the prefix is optional', () => {
  assert.equal(
    buildPublicationKey({ workspaceId: 'ws-a', publishedName: 'q3-v1.md' }),
    'ws-a/q3-v1.md',
  );
});

test('target uris use the provider scheme', () => {
  assert.equal(buildTargetUri('gcs', 'bucket', 'ws/q3-v1.md'), 'gs://bucket/ws/q3-v1.md');
  assert.equal(buildTargetUri('s3', 'bucket', 'ws/q3-v1.md'), 's3://bucket/ws/q3-v1.md');
});

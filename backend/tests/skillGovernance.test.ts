import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {
  SkillGovernanceError,
  compareSemanticVersions,
  computePackageManifestHash,
  normalizeGovernedFilePath,
  normalizeGovernedSkillKey,
} from '../src/services/governance/skillGovernanceService';
import {
  isMaterializationError,
  normalizeDatabaseConflict,
} from '../src/services/governance/skillGovernanceModel';

test('governed skill IDs are normalized and traversal-safe', () => {
  assert.equal(normalizeGovernedSkillKey(' Data/Analyze '), 'data/analyze');
  assert.throws(
    () => normalizeGovernedSkillKey('../admin'),
    (error: unknown) => error instanceof SkillGovernanceError && error.code === 'INVALID_SKILL_MANIFEST',
  );
  assert.throws(
    () => normalizeGovernedSkillKey('unsafe skill'),
    (error: unknown) => error instanceof SkillGovernanceError && error.statusCode === 400,
  );
});

test('governed package paths stay inside allowlisted skill directories', () => {
  assert.equal(normalizeGovernedFilePath('/scripts/run.py'), 'scripts/run.py');
  assert.equal(normalizeGovernedFilePath('SKILL.md'), 'SKILL.md');
  assert.throws(() => normalizeGovernedFilePath('scripts/../secret.txt'), SkillGovernanceError);
  assert.throws(() => normalizeGovernedFilePath('outside.txt'), SkillGovernanceError);
  assert.throws(() => normalizeGovernedFilePath('scripts/payload.exe'), SkillGovernanceError);
});

test('semantic versions use stable release precedence only', () => {
  assert.equal(compareSemanticVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemanticVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemanticVersions('1.2.9', '1.3.0'), -1);
  assert.throws(() => compareSemanticVersions('1.0.0-beta.1', '1.0.0'), SkillGovernanceError);
});

test('manifest hash is deterministic and binds paths, hashes, modes, and sizes', () => {
  const files = [
    { path: 'scripts/run.py', contentHash: 'b'.repeat(64), mode: 0o755, sizeBytes: 12 },
    { path: 'SKILL.md', contentHash: 'a'.repeat(64), mode: 0o644, sizeBytes: 24 },
  ];
  const forward = computePackageManifestHash(files);
  const reverse = computePackageManifestHash([...files].reverse());
  assert.equal(forward, reverse);
  assert.notEqual(
    forward,
    computePackageManifestHash([{ ...files[0], mode: 0o644 }, files[1]]),
  );
  assert.match(forward, /^[a-f0-9]{64}$/);
});

test('manifest hash orders paths by byte order so the Python agent can verify a pin', () => {
  // The agent verifies a signed pin by recomputing this digest in Python:
  //   sorted(paths)                      -> byte order
  //   json.dumps(..., separators=(',',':')) -> compact, insertion-ordered keys
  // `localeCompare` sorts 'scripts/...' before 'SKILL.md', byte order does the reverse, so a
  // locale sort silently produced a digest no agent could ever match.
  const files = [
    { path: 'scripts/count_words.py', contentHash: 'b'.repeat(64), mode: 0o644, sizeBytes: 1177 },
    { path: 'SKILL.md', contentHash: 'a'.repeat(64), mode: 0o644, sizeBytes: 29722 },
  ];

  const pythonEquivalent = crypto.createHash('sha256').update(JSON.stringify([
    { path: 'SKILL.md', contentHash: 'a'.repeat(64), mode: 0o644, sizeBytes: 29722 },
    { path: 'scripts/count_words.py', contentHash: 'b'.repeat(64), mode: 0o644, sizeBytes: 1177 },
  ])).digest('hex');

  assert.equal(computePackageManifestHash(files), pythonEquivalent);
  assert.notEqual(
    computePackageManifestHash(files),
    crypto.createHash('sha256').update(JSON.stringify([
      { path: 'scripts/count_words.py', contentHash: 'b'.repeat(64), mode: 0o644, sizeBytes: 1177 },
      { path: 'SKILL.md', contentHash: 'a'.repeat(64), mode: 0o644, sizeBytes: 29722 },
    ])).digest('hex'),
    'a locale-ordered manifest must not be accepted as equivalent',
  );
});

test('approval conflicts remain revision conflicts instead of activation failures', () => {
  const explicitConflict = new SkillGovernanceError(
    409,
    'SKILL_REVISION_CONFLICT',
    'The semantic version was approved elsewhere first',
  );
  assert.equal(isMaterializationError(explicitConflict), false);

  const uniqueConflict = normalizeDatabaseConflict({ code: '23505' });
  assert.ok(uniqueConflict instanceof SkillGovernanceError);
  assert.equal(uniqueConflict.statusCode, 409);
  assert.equal(uniqueConflict.code, 'SKILL_REVISION_CONFLICT');
});

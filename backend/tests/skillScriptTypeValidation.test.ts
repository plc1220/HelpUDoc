import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { FileSnapshot } from '../src/services/governance/skillGovernanceModel';
import { SkillPackageValidator } from '../src/services/governance/skillPackageValidator';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const validateScript = async (scriptPath: string) => {
  const script = 'console.log("hi");\n';
  const skillMd = [
    '---',
    'name: Demo',
    'description: Runs a script',
    'sandbox_scripts:',
    '  - name: run',
    `    path: ${scriptPath}`,
    `    sha256: "${sha(script)}"`,
    '    timeout_seconds: 10',
    '---',
    '',
    '# Demo',
    '',
  ].join('\n');
  const blobs = new Map([[sha(skillMd), skillMd], [sha(script), script]]);
  const files: FileSnapshot[] = [
    { path: 'SKILL.md', contentHash: sha(skillMd), sizeBytes: skillMd.length, mimeType: 'text/plain', mode: 0o644 },
    { path: scriptPath, contentHash: sha(script), sizeBytes: script.length, mimeType: 'text/plain', mode: 0o644 },
  ];
  const validator = new SkillPackageValidator(
    async (hash) => Buffer.from(blobs.get(hash) || ''),
    () => undefined,
  );
  const result = await validator.validate({ displayName: 'Demo', description: 'Runs a script' }, files);
  return result.issues.filter((issue) => issue.code === 'INVALID_SANDBOX_SCRIPT_TYPE');
};

test('scripts the sandbox can run pass the type check', async () => {
  for (const scriptPath of ['scripts/run.py', 'scripts/run.mjs', 'scripts/report.ts', 'scripts/report.CTS']) {
    assert.deepEqual(await validateScript(scriptPath), [], scriptPath);
  }
});

test('a script the sandbox cannot run is caught at validation, not at run time', async () => {
  const issues = await validateScript('scripts/run.rb');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, 'scripts/run.rb');
  assert.match(issues[0].message, /\.rb cannot be run/);
});

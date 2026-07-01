import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { filterPluginsForAccess, listPlugins } from '../src/services/plugins/registry';

const makeTempRoot = async () => fs.mkdtemp(path.join(os.tmpdir(), 'helpudoc-plugin-test-'));

test('listPlugins reads Data Analytics-style manifests and validates referenced skills', async () => {
  const root = await makeTempRoot();
  const skillsRoot = path.join(root, 'skills');
  const pluginsRoot = path.join(root, 'plugins');
  for (const skillId of ['data', 'data/analyze', 'data/refresh']) {
    const skillDir = path.join(skillsRoot, skillId);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${skillId}\n---\n# ${skillId}\n`, 'utf-8');
  }
  const pluginDir = path.join(pluginsRoot, 'data-analytics');
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, 'plugin.yaml'), [
    'id: data-analytics',
    'display_name: Data Analytics',
    'description: Source-backed analysis.',
    'default_skill: data',
    'skills:',
    '  - data',
    '  - data/analyze',
    '  - data/refresh',
    'default_tools:',
    '  - run_skill_python_script',
    'default_mcp_servers:',
    '  - toolbox-bq-demo',
    '  - data-artifacts',
    'default_sandbox_scripts:',
    '  - name: data_workspace',
    '    path: scripts/data_workspace.py',
    '    sha256: abc123',
    '    timeout_seconds: 120',
    '    outputs:',
    '      - out/result.json',
    '  - name: build_native_dashboard_package',
    '    path: scripts/build_native_dashboard_package.py',
    '    sha256: def456',
    '    timeout_seconds: 120',
    '    outputs:',
    '      - out/dashboard_artifacts.json',
    'execution:',
    '  mode: scope_bundle',
    '',
  ].join('\n'), 'utf-8');

  const plugins = await listPlugins({ rootDir: pluginsRoot, skillRootDir: skillsRoot });

  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].id, 'data-analytics');
  assert.equal(plugins[0].displayName, 'Data Analytics');
  assert.equal(plugins[0].defaultSkillId, 'data');
  assert.deepEqual(plugins[0].skillIds, ['data', 'data/analyze', 'data/refresh']);
  assert.deepEqual(plugins[0].tools, ['run_skill_python_script']);
  assert.deepEqual(plugins[0].mcpServers, ['toolbox-bq-demo', 'data-artifacts']);
  assert.deepEqual(plugins[0].scripts, ['data_workspace', 'build_native_dashboard_package']);
  assert.equal(plugins[0].valid, true);
});

test('filterPluginsForAccess shows bundles only when the default skill is allowed', () => {
  const plugin = {
    id: 'data-analytics',
    displayName: 'Data Analytics',
    defaultSkillId: 'data',
    skillIds: ['data', 'data/analyze'],
    tools: ['run_skill_python_script'],
    mcpServers: ['toolbox-bq-demo', 'data-artifacts'],
    scripts: ['data_workspace'],
    valid: true,
  };

  assert.deepEqual(filterPluginsForAccess([plugin], {
    isAdmin: false,
    skillIds: ['data/analyze'],
    mcpServerIds: ['toolbox-bq-demo', 'data-artifacts'],
  }), []);

  assert.deepEqual(filterPluginsForAccess([plugin], {
    isAdmin: false,
    skillIds: ['data', 'data/analyze'],
    mcpServerIds: ['toolbox-bq-demo', 'data-artifacts'],
  }), [plugin]);
});

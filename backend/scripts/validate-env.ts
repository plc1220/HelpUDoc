/**
 * Validates that committed *.env.example files only reference variables
 * cataloged in infra/env/helpudoc.env.schema.yaml.
 *
 * Run from repo: cd backend && npm run validate:env
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(__dirname, '../..');

type SchemaFile = {
  version?: number;
  variables?: Record<string, unknown>;
};

function loadSchemaKeys(): Set<string> {
  const schemaPath = path.join(repoRoot, 'infra/env/helpudoc.env.schema.yaml');
  const raw = fs.readFileSync(schemaPath, 'utf8');
  const doc = parseYaml(raw) as SchemaFile;
  const vars = doc.variables;
  if (!vars || typeof vars !== 'object') {
    throw new Error('Schema missing top-level "variables" map');
  }
  return new Set(Object.keys(vars));
}

function parseEnvExampleKeys(contents: string): string[] {
  const keys: string[] = [];
  for (const line of contents.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const withoutExport = trimmed.replace(/^export\s+/i, '');
    const match = withoutExport.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) {
      keys.push(match[1]);
    }
  }
  return keys;
}

const EXAMPLE_FILES = [
  'env/local/dev.env.example',
  'env/local/stack.env.example',
  'env/prod/config.env.example',
  'env/prod/secrets.env.example',
  'backend/.env.example',
];

function main(): void {
  const schemaKeys = loadSchemaKeys();
  let failed = false;

  for (const rel of EXAMPLE_FILES) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      console.error(`Missing example file: ${rel}`);
      failed = true;
      continue;
    }
    const body = fs.readFileSync(abs, 'utf8');
    const keys = parseEnvExampleKeys(body);
    for (const key of keys) {
      if (!schemaKeys.has(key)) {
        console.error(`[${rel}] Unknown variable (add to infra/env/helpudoc.env.schema.yaml): ${key}`);
        failed = true;
      }
    }
  }

  if (failed) {
    process.exit(1);
  }
  console.log(`env example validation OK (${EXAMPLE_FILES.length} files, ${schemaKeys.size} schema keys)`);
}

main();

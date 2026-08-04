import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { KnowledgeMapResponse } from '../src/services/agentService';
import {
  buildOkfBundleManifest,
  canonicalizeMapResults,
  KnowledgeService,
  validateOkfDocuments,
} from '../src/services/knowledgeService';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

async function main() {
  const inputPath = path.resolve(process.argv[2] || '');
  const artifactRoot = path.resolve(process.argv[3] || '');
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error('Usage: build_knowledge_smoke_bundle.ts <map-results.json> <artifact-root>');
  }
  const payload = JSON.parse(await fs.readFile(inputPath, 'utf8')) as {
    sourcePath: string;
    title: string;
    summary: string;
    markdown: string;
    manifest?: {
      discoveredSourceUnits?: number;
      processedSourceUnits?: number;
      failedSourceUnits?: number;
    };
    blocks: Array<Record<string, unknown>>;
    mapResults: KnowledgeMapResponse[];
  };
  const concepts = canonicalizeMapResults(payload.mapResults);
  const snapshotDigest = sha256(JSON.stringify(payload.mapResults));
  const sourceFingerprint = `sha256:${sha256(payload.markdown)}`;
  const relativeBundlePath = `.system/knowledge/1/bundles/${snapshotDigest}`;
  const workspaceRoot = path.join(artifactRoot, 'workspace');
  const bundlePath = path.join(workspaceRoot, relativeBundlePath);
  const sourceResource = `file://${encodeURI(path.resolve(payload.sourcePath))}`;
  const sourceTitle = path.basename(payload.sourcePath || payload.title);
  const generatedAt = '2026-08-04T00:00:00.000Z';
  const service = Object.create(KnowledgeService.prototype) as any;
  const documents = new Map<string, string>();

  documents.set(
    path.join(bundlePath, 'source.md'),
    service.buildOkfConcept({
      type: 'Reference',
      title: payload.title,
      description: payload.summary,
      resource: sourceResource,
      tags: ['knowledge', 'okf'],
      generatedAt,
      sourceTitle,
      sourceResource,
      body: payload.markdown,
    }),
  );
  for (const concept of concepts) {
    documents.set(
      path.join(bundlePath, concept.path),
      service.buildEnrichedOkfConcept({
        concept,
        concepts,
        generatedAt,
        sourceTitle,
        sourceResource,
        blocks: payload.blocks,
      }),
    );
  }
  const indexLines = [
    '---',
    'okf_version: "0.2"',
    '---',
    '',
    `# ${payload.title}`,
    '',
    payload.summary,
    '',
    '# Source',
    '',
    `* [${payload.title}](source.md)`,
    '',
    '# Concepts',
    '',
    ...concepts.map((concept) => `* [${concept.name}](${concept.path}) - ${concept.description}`),
  ];
  documents.set(path.join(bundlePath, 'index.md'), `${indexLines.join('\n').trim()}\n`);
  documents.set(
    path.join(bundlePath, 'log.md'),
    `# Knowledge Update Log\n\n* Live Gemini enrichment smoke run.\n* Snapshot: sha256:${snapshotDigest}\n`,
  );
  const manifest = buildOkfBundleManifest({
    snapshotHash: `sha256:${snapshotDigest}`,
    sourceFingerprint,
    enrichmentMode: 'gemini-lite',
    coverage: {
      discoveredSourceUnits: Number(payload.manifest?.discoveredSourceUnits || 0),
      processedSourceUnits: Number(payload.manifest?.processedSourceUnits || 0),
      failedSourceUnits: Number(payload.manifest?.failedSourceUnits || 0),
    },
    bundlePath,
    documents,
  });
  documents.set(path.join(bundlePath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  validateOkfDocuments(bundlePath, documents);

  await fs.rm(bundlePath, { recursive: true, force: true });
  for (const [fileName, content] of documents) {
    await fs.mkdir(path.dirname(fileName), { recursive: true });
    await fs.writeFile(fileName, content, 'utf8');
  }
  const currentPath = path.join(workspaceRoot, '.system/knowledge/1/current.json');
  await fs.mkdir(path.dirname(currentPath), { recursive: true });
  await fs.writeFile(currentPath, `${JSON.stringify({
    snapshotHash: `sha256:${snapshotDigest}`,
    bundlePath: relativeBundlePath,
    publishedAt: generatedAt,
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    path.join(artifactRoot, 'canonical-graph.json'),
    `${JSON.stringify({ concepts }, null, 2)}\n`,
    'utf8',
  );

  const relationshipCount = concepts.reduce((total, concept) => total + concept.relationships.length, 0);
  const assertionCount = concepts.reduce((total, concept) => total + concept.assertions.length, 0);
  console.log(JSON.stringify({
    workspaceRoot,
    bundlePath,
    snapshotHash: `sha256:${snapshotDigest}`,
    conceptCount: concepts.length,
    assertionCount,
    relationshipCount,
    bundleFileCount: documents.size,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

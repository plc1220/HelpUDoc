import assert from 'node:assert/strict';
import test from 'node:test';

import type { KnowledgeMapResponse } from '../src/services/agentService';
import {
  buildOkfBundleManifest,
  buildKnowledgeGraphPlan,
  canonicalizeMapResults,
  KnowledgeService,
  pruneThinOrphanConcepts,
  repairInvalidMermaidFences,
  reciprocalRankFusion,
  scoreKnowledgeLexically,
  validateOkfDocuments,
} from '../src/services/knowledgeService';

test('multilingual lexical scoring and reciprocal-rank fusion preserve exact matches', () => {
  assert.ok(scoreKnowledgeLexically('Bo-Peep', ['The History of Bo-Peep']) > 8);
  assert.ok(scoreKnowledgeLexically('牧羊女', ['小牧羊女寻找她的羊群']) > 0);
  assert.deepEqual(reciprocalRankFusion([
    ['exact', 'lexical-only'],
    ['semantic-only', 'exact'],
  ]).map((item) => item.id), ['exact', 'semantic-only', 'lexical-only']);
});

const response = (concepts: KnowledgeMapResponse['result']['concepts']): KnowledgeMapResponse => ({
  result: {
    concepts,
    summary: 'Renewal policy, implementation system, and operational risk.',
    unresolvedReferences: [],
  },
  provider: 'test-double',
  model: 'deterministic-semantic-fixture',
  modelProfile: 'gemini-lite',
  promptVersion: 'knowledge-map-v1',
  schemaVersion: 'knowledge-map-v1',
});

test('semantic enrichment forms a linked, evidence-backed OKF graph deterministically', () => {
  const mapResults: KnowledgeMapResponse[] = [
    response([
      {
        candidateId: 'policy-1',
        kind: 'Policy',
        name: 'Automatic Renewal Policy',
        description: 'Controls automatic subscription renewal notices.',
        aliases: ['Auto-renewal policy'],
        tags: ['renewal', 'customer-notice'],
        assertions: [{
          text: 'Customers must receive a notice 30 days before renewal.',
          confidence: 0.98,
          evidence: [{ blockIds: ['b-policy'], pageStart: 2, pageEnd: 2 }],
        }],
        relationships: [
          {
            targetName: 'Billing Service',
            targetKind: 'System',
            type: 'implemented_by',
            confidence: 0.94,
            confidenceClass: 'EXTRACTED',
            evidenceBlockIds: ['b-policy', 'b-system'],
          },
          {
            targetName: 'Renewal Risk',
            targetKind: 'Risk',
            type: 'mitigates',
            confidence: 0.87,
            confidenceClass: 'INFERRED',
            evidenceBlockIds: ['b-policy', 'b-risk'],
          },
        ],
      },
    ]),
    response([
      {
        candidateId: 'system-1',
        kind: 'System',
        name: 'Billing Service',
        description: 'Schedules renewal notices and subscription charges.',
        aliases: [],
        tags: ['billing'],
        assertions: [{
          text: 'The Billing Service is the implementation engine for renewal notices.',
          confidence: 0.96,
          evidence: [{ blockIds: ['b-system'], pageStart: 3, pageEnd: 3 }],
        }],
        relationships: [],
      },
      {
        candidateId: 'risk-1',
        kind: 'Risk',
        name: 'Renewal Risk',
        description: 'Risk of renewal without adequate customer notice.',
        aliases: [],
        tags: ['compliance'],
        assertions: [{
          text: 'Missing a renewal notice creates customer and compliance risk.',
          confidence: 0.91,
          evidence: [{ blockIds: ['b-risk'], pageStart: 4, pageEnd: 4 }],
        }],
        relationships: [],
      },
    ]),
  ];

  const concepts = canonicalizeMapResults(mapResults);
  const policy = concepts.find((concept) => concept.name === 'Automatic Renewal Policy');
  const billing = concepts.find((concept) => concept.name === 'Billing Service');
  const risk = concepts.find((concept) => concept.name === 'Renewal Risk');

  assert.equal(concepts.length, 3);
  assert.ok(policy);
  assert.ok(billing);
  assert.ok(risk);
  assert.equal(policy.relationships.length, 2);
  assert.deepEqual(
    policy.relationships.map((relationship) => [relationship.type, relationship.targetId]),
    [
      ['implemented_by', billing.id],
      ['mitigates', risk.id],
    ],
  );
  assert.deepEqual(policy.assertions[0].blockIds, ['b-policy']);
  assert.equal(policy.assertions[0].pageStart, 2);

  const bundlePath = '.system/knowledge/42/bundles/snapshot-good';
  const sourceResource = `${bundlePath}/source.md`;
  const generatedAt = '2026-08-03T00:00:00.000Z';
  const blocks = [
    { id: 'b-policy', page: 2, text: 'Notify customers 30 days before renewal.' },
    { id: 'b-system', page: 3, text: 'Billing Service schedules renewal notices.' },
    { id: 'b-risk', page: 4, text: 'Missing notices creates renewal risk.' },
  ];
  const service = Object.create(KnowledgeService.prototype) as any;
  const documents = new Map<string, string>();
  documents.set(
    `${bundlePath}/source.md`,
    '---\ntype: "Source"\ntitle: "Subscription Handbook"\n---\n\n# Subscription Handbook\n',
  );
  for (const concept of concepts) {
    documents.set(
      `${bundlePath}/${concept.path}`,
      service.buildEnrichedOkfConcept({
        concept,
        concepts,
        generatedAt,
        sourceTitle: 'Subscription Handbook',
        sourceResource,
        blocks,
      }),
    );
  }
  documents.set(
    `${bundlePath}/index.md`,
    `# Subscription Handbook\n\n${concepts.map((concept) => `* [${concept.name}](${concept.path})`).join('\n')}\n`,
  );
  documents.set(`${bundlePath}/log.md`, '# Generation log\n');

  const manifest = buildOkfBundleManifest({
    snapshotHash: 'sha256:snapshot-good',
    sourceFingerprint: 'sha256:source-good',
    enrichmentMode: 'gemini-lite',
    coverage: {
      discoveredSourceUnits: 3,
      processedSourceUnits: 3,
      failedSourceUnits: 0,
    },
    bundlePath,
    documents,
  });
  documents.set(`${bundlePath}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  assert.doesNotThrow(() => validateOkfDocuments(bundlePath, documents));
  assert.deepEqual(manifest.files.map((file) => file.path), [
    'concepts/policy/automatic-renewal-policy.md',
    'concepts/risk/renewal-risk.md',
    'concepts/system/billing-service.md',
    'index.md',
    'log.md',
    'source.md',
  ]);
  assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && file.bytes > 0));
  const renderedPolicy = documents.get(`${bundlePath}/${policy.path}`) || '';
  assert.match(renderedPolicy, /block_ids: \["b-policy"\]/);
  assert.match(renderedPolicy, /kind: "pdf_page_range"/);
  assert.match(renderedPolicy, /implemented by \[Billing Service\]\(\.\.\/system\/billing-service\.md\)/);
  assert.match(renderedPolicy, /mitigates \[Renewal Risk\]\(\.\.\/risk\/renewal-risk\.md\)/);
  assert.equal(
    renderedPolicy,
    service.buildEnrichedOkfConcept({
      concept: policy,
      concepts,
      generatedAt,
      sourceTitle: 'Subscription Handbook',
      sourceResource,
      blocks,
    }),
  );
});

test('OKF validation ignores example links inside fenced code but rejects broken live links', () => {
  const bundlePath = '.system/knowledge/9/bundles/example';
  const documents = new Map<string, string>([
    [`${bundlePath}/source.md`, '---\ntype: "Source"\ntitle: "Source"\n---\n\n[Original source link](missing.md)\n'],
    [`${bundlePath}/concepts/example.md`, '---\ntype: "Reference"\ntitle: "Example"\n---\n\n```md\n[Example](missing.md)\n```\n'],
    [`${bundlePath}/index.md`, '# Index\n'],
  ]);

  assert.doesNotThrow(() => validateOkfDocuments(bundlePath, documents));
  documents.set(`${bundlePath}/concepts/example.md`, '---\ntype: "Reference"\ntitle: "Example"\n---\n\n[Broken](missing.md)\n');
  assert.throws(() => validateOkfDocuments(bundlePath, documents), /OKF link target does not exist/);
});

test('canonicalization cannot produce duplicate IDs from equivalent kind spellings', () => {
  const concepts = canonicalizeMapResults([
    response([
      {
        candidateId: 'component-1',
        kind: 'System Component',
        name: 'Hybrid Retriever',
        description: 'Retrieves Knowledge concepts.',
        aliases: [],
        tags: [],
        assertions: [],
        relationships: [],
      },
      {
        candidateId: 'component-2',
        kind: 'system-component',
        name: 'Hybrid-Retriever',
        description: 'Same component with producer formatting variation.',
        aliases: [],
        tags: [],
        assertions: [],
        relationships: [],
      },
    ]),
  ]);

  assert.equal(concepts.length, 1);
  assert.equal(new Set(concepts.map((concept) => concept.id)).size, concepts.length);
  assert.equal(new Set(concepts.map((concept) => concept.path)).size, concepts.length);
});

test('canonicalization does not mint a thin page for a relationship-only target', () => {
  const concepts = canonicalizeMapResults([
    response([{
      candidateId: 'source-1',
      kind: 'System',
      name: 'Publisher',
      description: 'Publishes validated bundles.',
      aliases: [],
      tags: [],
      assertions: [],
      relationships: [{
        targetName: 'Unresolved Mention',
        targetKind: 'System',
        type: 'references',
        confidence: 0.7,
        confidenceClass: 'AMBIGUOUS',
        evidenceBlockIds: ['b1'],
      }],
    }]),
  ]);

  assert.deepEqual(concepts.map((concept) => concept.name), ['Publisher']);
  assert.deepEqual(concepts[0].relationships, []);
});

test('wiki plan exposes graph components, orphans, and thin concepts deterministically', () => {
  const concepts = canonicalizeMapResults([
    response([
      {
        candidateId: 'a', kind: 'System', name: 'A', description: 'Substantive system A with enough detail to stand alone in the generated wiki.',
        aliases: [], tags: [], assertions: [], relationships: [{
          targetName: 'B', targetKind: 'System', type: 'depends_on', confidence: 0.9,
          confidenceClass: 'EXTRACTED', evidenceBlockIds: ['b1'],
        }],
      },
      {
        candidateId: 'b', kind: 'System', name: 'B', description: 'Substantive system B with enough detail to stand alone in the generated wiki.',
        aliases: [], tags: [], assertions: [], relationships: [],
      },
      {
        candidateId: 'c', kind: 'Term', name: 'C', description: 'Thin.',
        aliases: [], tags: [], assertions: [], relationships: [],
      },
    ]),
  ]);

  const plan = buildKnowledgeGraphPlan(concepts);

  assert.equal(plan.quality.componentCount, 2);
  assert.deepEqual(plan.quality.orphanConceptIds, ['term:c']);
  assert.deepEqual(plan.quality.thinConceptIds, ['term:c']);
  assert.deepEqual(plan.relationships.map((edge) => [edge.sourceId, edge.type, edge.targetId]), [
    ['system:a', 'depends_on', 'system:b'],
  ]);
});

test('publication pruning removes only thin orphan concepts', () => {
  const concepts = canonicalizeMapResults([
    response([
      {
        candidateId: 'thin', kind: 'Term', name: 'Thin', description: 'Too small.',
        aliases: [], tags: [], assertions: [], relationships: [],
      },
      {
        candidateId: 'grounded', kind: 'Term', name: 'Grounded', description: 'Short but grounded.',
        aliases: [], tags: [], assertions: [{
          text: 'Grounded fact.', confidence: 0.9, evidence: [{ blockIds: ['b1'] }],
        }], relationships: [],
      },
      {
        candidateId: 'substantive', kind: 'Topic', name: 'Substantive',
        description: 'A sufficiently detailed standalone description remains available even when no relationship was extracted for it.',
        aliases: [], tags: [], assertions: [], relationships: [],
      },
    ]),
  ]);

  assert.deepEqual(pruneThinOrphanConcepts(concepts).map((concept) => concept.name), ['Grounded', 'Substantive']);
});

test('OKF validation enforces typed frontmatter and heading anchors', () => {
  const bundlePath = '.system/knowledge/11/bundles/anchors';
  const documents = new Map<string, string>([
    [`${bundlePath}/source.md`, '---\ntype: "Source"\n---\n\n# Source\n'],
    [`${bundlePath}/concepts/a.md`, '---\ntype: "System"\n---\n\n# A\n\n[Details](b.md#details)\n'],
    [`${bundlePath}/concepts/b.md`, '---\ntype: "System"\n---\n\n# B\n\n## Details\n'],
    [`${bundlePath}/index.md`, '# Index\n'],
  ]);

  assert.doesNotThrow(() => validateOkfDocuments(bundlePath, documents));
  documents.set(`${bundlePath}/concepts/a.md`, '---\ntype: "System"\n---\n\n# A\n\n[Missing](b.md#missing)\n');
  assert.throws(() => validateOkfDocuments(bundlePath, documents), /OKF link heading does not exist/);
  documents.set(`${bundlePath}/concepts/a.md`, '---\ntitle: "A"\n---\n\n# A\n');
  assert.throws(() => validateOkfDocuments(bundlePath, documents), /missing a non-empty type/);
});

test('invalid Mermaid is degraded without discarding its source', () => {
  const fileName = '.system/knowledge/12/bundles/mermaid/concepts/diagram.md';
  const documents = new Map([[fileName, '---\ntype: "Diagram"\n---\n\n```mermaid\nflowchart LR\nA[bad; label] --> B\n```\n']]);

  const report = repairInvalidMermaidFences(documents);
  const repaired = documents.get(fileName) || '';

  assert.equal(report.fencesChecked, 1);
  assert.equal(report.fencesDegraded, 1);
  assert.match(repaired, /helpudoc: invalid Mermaid degraded to text/);
  assert.match(repaired, /```text\nflowchart LR\nA\[bad; label\] --> B/);
});

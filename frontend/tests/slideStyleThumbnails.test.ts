import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { covers, renderCover } from '../scripts/slide-style-covers.mjs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const index = JSON.parse(read('../../skills/frontend-slides/bold-template-pack/selection-index.json').toString());
const catalog = JSON.parse(read('../src/components/slides/styleCatalog.json').toString());
const manifest = JSON.parse(read('../public/slide-styles/manifest.json').toString());
const rendererHash = sha(read('../scripts/slide-style-covers.mjs'));

test('every shipped style has a distinct rendered cover with current source provenance', () => {
  assert.deepEqual(Object.keys(covers).sort(), index.templates.map((entry: {slug: string}) => entry.slug).sort());
  const hashes = new Set(); let totalBytes = 0;
  for (const entry of index.templates) {
    const thumbnail = manifest[entry.slug];
    const designText = read(`../../skills/frontend-slides/${entry.design_md}`).toString();
    const previewText = read(`../../skills/frontend-slides/${entry.preview_md}`).toString();
    assert.equal(thumbnail.sourceHash, sha(designText + previewText), `${entry.slug}: rerender changed design`);
    assert.equal(thumbnail.rendererHash, rendererHash, `${entry.slug}: rerender changed composition`);
    const image = read(`../public/slide-styles/${entry.slug}.jpg`);
    assert.equal(image.subarray(0, 2).toString('hex'), 'ffd8');
    assert.equal(sha(image), thumbnail.imageHash);
    assert.equal(thumbnail.src, `/slide-styles/${entry.slug}.jpg?v=${thumbnail.imageHash.slice(0, 12)}`);
    assert.deepEqual(catalog.find((style: {id: string}) => style.id === entry.slug).thumbnail, thumbnail);
    assert.equal(thumbnail.width / thumbnail.height, 16 / 9);
    assert.ok(thumbnail.bytes < 100_000, 'Per-cover transfer budget');
    totalBytes += image.length; hashes.add(thumbnail.imageHash);
    const design = parse(designText.split('---')[1]);
    const sample = renderCover(entry.slug, design);
    assert.ok(sample.html.includes(design.typography[covers[entry.slug][2]].fontFamily.replaceAll('"', '&quot;')));
    assert.ok(sample.html.includes(design.colors[covers[entry.slug][0]]));
  }
  assert.equal(hashes.size, 34);
  assert.ok(totalBytes < 2_000_000, 'Entire library transfer budget');
});

test('signature compositions do not fall back to generic mood thumbnails', () => {
  for (const slug of ['editorial-forest', 'biennale-yellow', 'retro-windows', 'vellum']) {
    const entry = index.templates.find((entry: {slug: string}) => entry.slug === slug);
    const design = parse(read(`../../skills/frontend-slides/${entry.design_md}`).toString().split('---')[1]);
    assert.ok(renderCover(slug, design).html.includes(`stage ${covers[slug][3]}`));
  }
  assert.throws(() => renderCover('missing-style', {}), /Incomplete cover specification/);
});

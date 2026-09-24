// Rebuild with: node frontend/scripts/generate-slide-style-catalog.mjs
// Design documents are hashed at build time; only compact metadata reaches the UI.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../../skills/frontend-slides/', import.meta.url);
const index = JSON.parse(await readFile(new URL('bold-template-pack/selection-index.json', root), 'utf8'));
const thumbnails = JSON.parse(await readFile(new URL('../public/slide-styles/manifest.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const rendererHash = hash(await readFile(new URL('./slide-style-covers.mjs', import.meta.url)));
const catalog = await Promise.all(index.templates.map(async (entry) => {
  const recipe = await readFile(new URL(entry.preview_md, root), 'utf8');
  const design = await readFile(new URL(entry.design_md, root), 'utf8');
  if (thumbnails[entry.slug]?.sourceHash !== hash(design + recipe) || thumbnails[entry.slug]?.rendererHash !== rendererHash) {
    throw new Error(`Stale/missing cover for ${entry.slug}. Run render-slide-style-thumbnails.mjs first.`);
  }
  const palette = [...new Set((recipe.match(/#[0-9a-f]{6}\b/gi) || []).map(c => c.toLowerCase()))].slice(0, 5);
  const editorial = /serif|editorial|literary/i.test(entry.tagline + ' ' + entry.mood.join(' '));
  const group = editorial ? 'Editorial' : /professional|corporate|structured/i.test(entry.tagline + entry.mood.join(' ')) ? 'Professional' : /minimal|quiet|restrained/i.test(entry.tagline + entry.mood.join(' ')) ? 'Minimal' : 'Bold';
  return { id: entry.slug, name: entry.name, description: entry.tagline, tags: entry.mood,
    group, scheme: entry.scheme, palette, editorial, previewPath: entry.preview_md, designPath: entry.design_md,
    thumbnail: thumbnails[entry.slug] || (() => { throw new Error(`Missing thumbnail: ${entry.slug}`); })() };
}));
await writeFile(new URL('../src/components/slides/styleCatalog.json', import.meta.url), JSON.stringify(catalog, null, 2) + '\n');
console.log(`Generated ${catalog.length} slide style entries.`);

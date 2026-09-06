// Run from frontend: node scripts/render-slide-style-thumbnails.mjs
// Build-time only: each recipe renders at 1920×1080 and is captured at 960×540.
// The gallery loads static images: no per-card frames, model calls, or font requests.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { chromium } from '@playwright/test';
import { covers, renderCover } from './slide-style-covers.mjs';

const skillRoot = new URL('../../skills/frontend-slides/', import.meta.url);
const output = new URL('../public/slide-styles/', import.meta.url);
const cache = new URL('../node_modules/.cache/slide-style-fonts/', import.meta.url);
await mkdir(output, { recursive: true }); await mkdir(cache, { recursive: true });
const index = JSON.parse(await readFile(new URL('bold-template-pack/selection-index.json', skillRoot), 'utf8'));
const renderer = await readFile(new URL('./slide-style-covers.mjs', import.meta.url), 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const fontPromises = new Map();
const nativeFonts = new Set(['MS Sans Serif', 'Segoe UI', 'system-ui', 'Arial', 'sans-serif']);
const fontName = role => role.fontFamily.split(',')[0].trim().replaceAll(/['"]/g, '');
async function fetchFont(role, italic = false) {
  const name = fontName(role); if (nativeFonts.has(name)) return '';
  const weight = role.fontWeight || 400;
  const key = `${name}-${weight}-${italic}`;
  if (!fontPromises.has(key)) fontPromises.set(key, (async () => {
    const path = new URL(`${sha(key)}.css`, cache);
    try { return await readFile(path, 'utf8'); } catch { /* Download once on first build. */ }
    const family = `${name}:${italic ? 'ital,wght@1,' : 'wght@'}${weight}`;
    const response = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&display=block`);
    if (!response.ok) throw new Error(`Font request failed (${response.status}): ${key}`);
    let css = await response.text();
    for (const url of new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map(match => match[1]))) {
      const font = await fetch(url); if (!font.ok) throw new Error(`Font file failed: ${key}`);
      css = css.replaceAll(url, `data:font/woff2;base64,${Buffer.from(await font.arrayBuffer()).toString('base64')}`);
    }
    await writeFile(path, css); return css;
  })());
  return fontPromises.get(key);
}

const browser = await chromium.launch();
const manifest = {};
try {
  for (const entry of index.templates) {
    const designText = await readFile(new URL(entry.design_md, skillRoot), 'utf8');
    const previewText = await readFile(new URL(entry.preview_md, skillRoot), 'utf8');
    const design = parse(designText.split('---')[1]);
    const sample = renderCover(entry.slug, design);
    const italicLayouts = new Set(['solar', 'grove', 'signal', 'soft', 'vellum']);
    const fonts = await Promise.all(sample.fonts.map(role => fetchFont(role, role.fontStyle === 'italic')));
    if (italicLayouts.has(covers[entry.slug][3])) fonts.push(await fetchFont(sample.fonts[0], true));
    if (entry.slug === 'editorial-tri-tone') fonts.push(await fetchFont({fontFamily: 'Instrument Serif', fontWeight: 400}, true));
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: .5 });
    try {
      await page.route('**/*', route => route.abort()); // No undeclared network at render time.
      await page.setContent(renderCover(entry.slug, design, fonts.join('\n')).html);
      await page.evaluate(() => document.fonts.ready);
      const fontFailures = await page.evaluate(() => [...document.fonts].filter(font => font.status === 'error').map(font => font.family));
      if (fontFailures.length) throw new Error(`Unloaded fonts: ${fontFailures}`);
      const bounds = await page.locator('h1').evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth, bottom: el.getBoundingClientRect().bottom }));
      if (bounds.scroll > bounds.width + 2 || bounds.bottom > 950) throw new Error(`Cover title overflows: ${entry.slug} ${JSON.stringify(bounds)}`);
      const image = await page.screenshot({ type: 'jpeg', quality: 86, animations: 'disabled' });
      const imageHash = sha(image);
      const name = `${entry.slug}.jpg`;
      await writeFile(new URL(name, output), image);
      manifest[entry.slug] = { src: `/slide-styles/${name}?v=${imageHash.slice(0,12)}`, width: 960, height: 540,
        sourceHash: sha(designText + previewText), rendererHash: sha(renderer), imageHash,
        fonts: [...new Set(sample.fonts.map(fontName))], bytes: image.length };
      console.log(`Rendered ${entry.slug}: ${image.length} bytes`);
    } finally { await page.close(); }
  }
  await writeFile(new URL('manifest.json', output), JSON.stringify(manifest, null, 2) + '\n');
} finally { await browser.close(); }

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assertUnchangedDeck, buildStylePreviewPrompt, isHtmlSlideDeck, stylePreviewPath, withActiveSlideContext } from '../src/components/slides/slideStyleWorkflow.ts';

const styles = JSON.parse(readFileSync(new URL('../src/components/slides/styleCatalog.json', import.meta.url), 'utf8'));
test('catalog is grounded in every indexed bold style, with unique identities', () => {
  const index = JSON.parse(readFileSync(new URL('../../skills/frontend-slides/bold-template-pack/selection-index.json', import.meta.url), 'utf8'));
  assert.deepEqual(styles.map((s: { id: string }) => s.id), index.templates.map((s: { slug: string }) => s.slug));
  assert.equal(new Set(styles.map((s: { id: string }) => s.id)).size, 34);
});
test('recognizes slide HTML, not ordinary websites, native decks, or temporary style drafts', () => {
  assert.equal(isHtmlSlideDeck('launch.html', '<section class="slide active">'), true);
  assert.equal(isHtmlSlideDeck('index.html', '<h1>Website</h1>'), false);
  assert.equal(isHtmlSlideDeck('launch.pptx', '<section class="slide">'), false);
  assert.equal(isHtmlSlideDeck('.style-preview-123.html', '<section class="slide">'), false);
});
test('preview remains beside source so existing relative asset paths still resolve', () => {
  assert.equal(stylePreviewPath('campaign/deck.html', 'abc-123'), 'campaign/.style-preview-abc-123.html');
  assert.throws(() => stylePreviewPath('deck.html', '../deck'), /Invalid/);
  const prompt = buildStylePreviewPrompt('campaign/deck.html', 'campaign/.style-preview-abc.html', styles[0]);
  assert.match(prompt, /SLIDE_STYLE_PREVIEW/);
  assert.match(prompt, /Mode C/);
  assert.match(prompt, /Do not modify the source/);
  assert.match(prompt, /templates\/8-bit-orbit\/design.md/);
});
test('apply and undo refuse changed, stale, or unversioned source decks', () => {
  const base = { content: 'original', version: 4 };
  assert.doesNotThrow(() => assertUnchangedDeck(base, { ...base }));
  assert.throws(() => assertUnchangedDeck(base, { content: 'original', version: 5 }));
  assert.throws(() => assertUnchangedDeck(base, { content: 'different', version: 4 }));
  assert.throws(() => assertUnchangedDeck({ content: 'original' }, { content: 'original' }));
});

test('ordinary edit requests target the open deck without overriding explicit files or new work', () => {
  assert.match(withActiveSlideContext('Make it warmer', 'current.html'), /currently open HTML deck "current.html"/);
  assert.match(withActiveSlideContext('Add a summary slide', 'current.html'), /do not restart/);
  for (const prompt of ['Edit other.html', 'Create a new deck', 'Start from scratch', 'Update my email address', 'What is the weather?']) {
    assert.equal(withActiveSlideContext(prompt, 'current.html'), prompt);
  }
});

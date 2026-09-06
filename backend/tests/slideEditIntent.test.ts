import assert from 'node:assert/strict';
import test from 'node:test';
import { isFrontendSlidesEditExistingRun, slideEditArtifactCandidates } from '../src/services/agent-runs/slideEditIntent';
import { buildSyntheticResumeParams, getFrontendSlidesMissingRequiredGate } from '../src/services/agent-runs/lifecycle';

const history = [{ role: 'assistant', content: 'Created your 3-slide deck at `/coffee-deck.html`.' }];

for (const prompt of ['Make it more minimal', 'Add a summary slide', 'Use the blue style', 'Change the visual style of slide 2', 'Shorten the title', 'Reorder slides 2 and 3']) {
  test(`continues existing deck: ${prompt}`, () => {
    const params = { prompt, history, workspaceId: 'test', persona: 'fast' };
    assert.equal(isFrontendSlidesEditExistingRun(params), true);
    assert.equal(getFrontendSlidesMissingRequiredGate({ skillId: 'frontend-slides', params }), null);
  });
}

for (const prompt of ['Create a new deck and add a summary slide', 'Start from scratch', 'Update my email address']) {
  test(`does not confuse an unrelated/new request with a revision: ${prompt}`, () => {
    assert.equal(isFrontendSlidesEditExistingRun({ prompt, history }), false);
  });
}

test('a request or style preview alone is not a delivered deck', () => {
  for (const entries of [
    [{ role: 'user', content: 'Please create /coffee-deck.html' }],
    [{ role: 'assistant', content: 'Preview .frontend-slides/slide-previews/style-a.html' }],
  ]) assert.equal(isFrontendSlidesEditExistingRun({ prompt: 'Make it minimal', history: entries }), false);
});

test('explicit target works without prior conversation', () => {
  assert.equal(isFrontendSlidesEditExistingRun({ prompt: 'Add a conclusion to @coffee-deck.html' }), true);
  assert.deepEqual(slideEditArtifactCandidates({ prompt: 'Change @other.html', history }), ['other.html']);
});

test('style selection survives a synthetic checkpoint reset with its edit target', () => {
  const resumed = buildSyntheticResumeParams(
    { prompt: 'Make it more minimal', history, workspaceId: 'test', persona: 'fast' },
    { selectedValues: ['Style B'] },
    { kind: 'clarification', displayPayload: { skill: 'frontend-slides', gateId: 'style_preview_selection' } },
    { completedGateIds: ['style_preview_selection'] },
  );
  assert.equal(resumed.history, undefined);
  assert.equal(resumed.frontendSlidesEditExisting, true);
  assert.match(resumed.prompt, /coffee-deck\.html/);
  assert.equal(getFrontendSlidesMissingRequiredGate({ skillId: 'frontend-slides', params: resumed }), null);
});

test('protected preview metadata survives synthetic continuation and drafts are not delivered decks', () => {
  const marker = 'SLIDE_STYLE_PREVIEW {"source":"coffee.html","output":".style-preview-abc.html"}';
  const resumed = buildSyntheticResumeParams(
    { prompt: `${marker}\nRestyle the existing HTML deck coffee.html.`, workspaceId: 'test', persona: 'fast' },
    { selectedValues: ['Editorial Forest'] }, undefined, { completedGateIds: [] },
  );
  assert.ok(resumed.prompt.includes(marker));
  assert.equal(resumed.frontendSlidesEditExisting, true);
  assert.equal(isFrontendSlidesEditExistingRun({ prompt: 'Make it minimal', history: [{ role: 'assistant', content: 'Draft: .style-preview-abc.html' }] }), false);
  assert.deepEqual(slideEditArtifactCandidates({ prompt: 'Restyle coffee.html; write .style-preview-abc.html' }), ['coffee.html']);
});

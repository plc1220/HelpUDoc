import assert from 'node:assert/strict';
import test from 'node:test';

import { notifySkillCatalogChanged, onSkillCatalogChanged } from '../src/utils/skillCatalogEvents.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test('a change in this tab reaches its own listeners exactly once', async () => {
  let calls = 0;
  const unsubscribe = onSkillCatalogChanged(() => { calls += 1; });

  notifySkillCatalogChanged();
  await tick(); // let the BroadcastChannel deliver, so a duplicate would show

  assert.equal(calls, 1);
  unsubscribe();
});

test('a change announced by another tab reaches this tab', async () => {
  let calls = 0;
  const unsubscribe = onSkillCatalogChanged(() => { calls += 1; });
  const otherTab = new BroadcastChannel('helpudoc-skill-catalog');

  otherTab.postMessage({ type: 'skill-catalog-changed', tab: 'another-tab' });
  await tick();

  assert.equal(calls, 1);
  otherTab.close();
  unsubscribe();
});

test('an unsubscribed listener hears nothing', async () => {
  let calls = 0;
  const unsubscribe = onSkillCatalogChanged(() => { calls += 1; });
  unsubscribe();

  notifySkillCatalogChanged();
  await tick();

  assert.equal(calls, 0);
});

import { expect, test } from '@playwright/test';
import { mergeMonotonicAssistantText } from '../src/utils/messages';

test('new chunks remain visible while an earlier checkpoint is in flight', () => {
  const textWhenCheckpointStarted = 'Earlier analysis.';
  const textAfterNewChunks = `${textWhenCheckpointStarted}\n\n50.27 | $58.96 | Final summary.`;

  expect(
    mergeMonotonicAssistantText(textAfterNewChunks, textWhenCheckpointStarted),
  ).toBe(textAfterNewChunks);
});

test('a delayed suffix checkpoint cannot replace the complete streamed answer', () => {
  const complete = 'Earlier analysis.\n\n50.27 | $58.96 | Final summary.';

  expect(
    mergeMonotonicAssistantText(complete, '50.27 | $58.96 | Final summary.'),
  ).toBe(complete);
});

test('a newer cumulative canonical snapshot can extend the stream projection', () => {
  expect(
    mergeMonotonicAssistantText(
      'Earlier analysis.',
      'Earlier analysis.\n\nNew canonical conclusion.',
    ),
  ).toBe('Earlier analysis.\n\nNew canonical conclusion.');
});

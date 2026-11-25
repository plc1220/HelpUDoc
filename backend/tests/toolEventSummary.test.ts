import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOOL_EVENT_SUMMARY_MAX_CHARS,
  TOOL_EVENT_TRUNCATION_MARKER,
  capToolEventPayload,
  capToolEventText,
  capToolEventsInMetadata,
} from '../src/lib/toolEventSummary';

const big = 'x'.repeat(9 * 1024 * 1024); // a 9 MB read_file output, as seen in production

test('short tool output is stored unchanged', () => {
  const text = 'y'.repeat(TOOL_EVENT_SUMMARY_MAX_CHARS);
  assert.equal(capToolEventText(text), text);
  assert.equal(capToolEventText(undefined), undefined);
});

test('long tool output is cut to the limit with a visible marker', () => {
  const capped = capToolEventText(big);
  assert.equal(capped.length, TOOL_EVENT_SUMMARY_MAX_CHARS + TOOL_EVENT_TRUNCATION_MARKER.length);
  assert.ok(capped.endsWith(TOOL_EVENT_TRUNCATION_MARKER));
});

test('message metadata keeps every event and field; only long summaries shrink', () => {
  const metadata = {
    runId: 'run-1',
    bodySource: 'assistant',
    toolEvents: [
      { id: 't1', name: 'read_file', status: 'completed', summary: big, outputFiles: [{ path: 'a.md' }] },
      { id: 't2', name: 'glob', status: 'completed', summary: 'a.md' },
      { id: 't3', name: 'write_todos', status: 'running' },
    ],
  };

  const capped = capToolEventsInMetadata(metadata);

  assert.notEqual(capped, metadata);
  assert.equal(capped.runId, 'run-1');
  assert.equal(capped.toolEvents.length, 3);
  assert.deepEqual(capped.toolEvents[0].outputFiles, [{ path: 'a.md' }]);
  assert.ok(capped.toolEvents[0].summary!.length < 3000);
  assert.equal(capped.toolEvents[1], metadata.toolEvents[1]); // untouched events are not copied
  assert.equal(capped.toolEvents[2], metadata.toolEvents[2]);
  assert.equal(metadata.toolEvents[0].summary, big); // the input is not mutated
});

test('metadata that needs no change is returned as the same object', () => {
  const metadata = { runId: 'run-1', toolEvents: [{ name: 'glob', summary: 'ok' }] };
  assert.equal(capToolEventsInMetadata(metadata), metadata);
  assert.equal(capToolEventsInMetadata(null), null);
  assert.equal(capToolEventsInMetadata(undefined), undefined);
  const noEvents = { runId: 'run-2' };
  assert.equal(capToolEventsInMetadata(noEvents), noEvents);
});

test('telemetry payload content is capped; other payload fields are kept', () => {
  const payload = { type: 'tool_end', name: 'read_file', content: big, outputFiles: [{ path: 'a.md' }] };

  const capped = capToolEventPayload(payload);

  assert.equal(capped.type, 'tool_end');
  assert.deepEqual(capped.outputFiles, payload.outputFiles);
  assert.ok((capped.content as string).length < 3000);
  assert.equal(capToolEventPayload({ type: 'tool_start', name: 'glob' }).name, 'glob');
});

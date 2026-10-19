import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EARLIER_MESSAGES_STEP,
  INITIAL_VISIBLE_MESSAGES,
  nextMessageWindow,
  showEarlierMessages,
} from '../src/components/chat/messageWindow.ts';

test('a long conversation opens on its newest messages', () => {
  assert.deepEqual(nextMessageWindow(null, 'c1', 238), { key: 'c1', start: 238 - INITIAL_VISIBLE_MESSAGES, length: 238 });
  assert.deepEqual(nextMessageWindow(null, 'c1', 12), { key: 'c1', start: 0, length: 12 });
  assert.equal(nextMessageWindow(null, 'c1', 0), null);
});

test('live messages are appended without shifting what is shown', () => {
  const opened = nextMessageWindow(null, 'c1', 238)!;
  const appended = nextMessageWindow(opened, 'c1', 240)!;
  assert.equal(appended.start, opened.start);
  assert.equal(nextMessageWindow(appended, 'c1', 240), appended);
});

test('a history load or another conversation re-anchors on the newest messages', () => {
  const fresh = nextMessageWindow(null, 'c1', 2)!;
  assert.equal(nextMessageWindow(fresh, 'c1', 238)!.start, 238 - INITIAL_VISIBLE_MESSAGES);
  const opened = nextMessageWindow(null, 'c1', 238)!;
  assert.deepEqual(nextMessageWindow(opened, 'c2', 50), { key: 'c2', start: 50 - INITIAL_VISIBLE_MESSAGES, length: 50 });
});

test('a truncated conversation still shows its newest messages', () => {
  const opened = nextMessageWindow(null, 'c1', 238)!;
  assert.equal(nextMessageWindow(opened, 'c1', 30)!.start, 0);
});

test('show earlier reveals one more step, down to the first message', () => {
  const opened = nextMessageWindow(null, 'c1', 238)!;
  assert.equal(showEarlierMessages(opened).start, opened.start - EARLIER_MESSAGES_STEP);
  assert.equal(showEarlierMessages({ key: 'c1', start: 5, length: 45 }).start, 0);
});

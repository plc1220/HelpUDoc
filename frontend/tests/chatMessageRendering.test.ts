import assert from 'node:assert/strict';
import test from 'node:test';

import { areChatMessageBubblePropsEqual } from '../src/components/chat/chatMessageBubbleProps.ts';

const handler = () => undefined;
const message = { id: 12, text: 'hello' };
const base = () => ({
  message,
  markdownComponents: {},
  handleCopyMessageText: handler,
  expandedToolMessages: new Set<unknown>(),
  copiedMessageId: null as unknown,
  interruptInputByMessageId: {} as Record<string, string>,
  interruptErrorByMessageId: {} as Record<string, string>,
  isStreaming: false,
});

test('a message skips re-rendering when nothing it reads changed', () => {
  const previous = base();
  assert.equal(areChatMessageBubblePropsEqual(previous, { ...previous }), true);
});

test("another message's answer box does not re-render this one", () => {
  const previous = base();
  const next = {
    ...previous,
    // Messages 1 and 123 share a prefix with 12 but are different messages.
    interruptInputByMessageId: { '1:feedback': 'typed', '123:clarification-text': 'more' },
  };
  assert.equal(areChatMessageBubblePropsEqual(previous, next), true);
});

test("this message's own answer box re-renders it", () => {
  const previous = base();
  assert.equal(areChatMessageBubblePropsEqual(previous, {
    ...previous, interruptInputByMessageId: { '12:clarification-text': 'x' },
  }), false);
  assert.equal(areChatMessageBubblePropsEqual(previous, {
    ...previous, interruptErrorByMessageId: { 12: 'Failed' },
  }), false);
});

test('copy feedback and tool expansion re-render only the message they name', () => {
  const previous = base();
  assert.equal(areChatMessageBubblePropsEqual(previous, { ...previous, copiedMessageId: 7 }), true);
  assert.equal(areChatMessageBubblePropsEqual(previous, { ...previous, copiedMessageId: 12 }), false);
  assert.equal(areChatMessageBubblePropsEqual(previous, { ...previous, expandedToolMessages: new Set([7]) }), true);
  assert.equal(areChatMessageBubblePropsEqual(previous, { ...previous, expandedToolMessages: new Set([12]) }), false);
});

test('a new message object, a new handler or a changed flag re-renders', () => {
  const previous = base();
  assert.equal(areChatMessageBubblePropsEqual(previous, { ...previous, message: { ...message, text: 'hello!' } }), false);
  assert.equal(areChatMessageBubblePropsEqual(previous, { ...previous, handleCopyMessageText: () => undefined }), false);
  assert.equal(areChatMessageBubblePropsEqual(previous, { ...previous, isStreaming: true }), false);
});

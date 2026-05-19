import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getImplicitContinuationContext,
  buildContinuationPrompt,
} from '../src/utils/implicitSkillContinuation';
import type { ConversationMessage, ConversationMessageMetadata } from '@helpudoc/contracts/types';

const makeAgentMessage = (
  text: string,
  metadata?: Partial<ConversationMessageMetadata>,
): ConversationMessage => ({
  id: 'msg-1',
  conversationId: 'conv-1',
  sender: 'agent',
  text,
  createdAt: new Date().toISOString(),
  metadata: metadata as Record<string, unknown>,
});

const makeUserMessage = (text: string): ConversationMessage => ({
  id: 'msg-2',
  conversationId: 'conv-1',
  sender: 'user',
  text,
  createdAt: new Date().toISOString(),
});

test('getImplicitContinuationContext returns shouldContinue=false when no agent messages', () => {
  const result = getImplicitContinuationContext([makeUserMessage('hello')]);
  assert.equal(result.shouldContinue, false);
});

test('getImplicitContinuationContext returns shouldContinue=false when agent message lacks metadata', () => {
  const messages = [
    makeUserMessage('run skill'),
    makeAgentMessage('Here is your result.'),
  ];
  const result = getImplicitContinuationContext(messages);
  assert.equal(result.shouldContinue, false);
});

test('getImplicitContinuationContext returns shouldContinue=false when awaitingImplicitInput is not set', () => {
  const messages = [
    makeUserMessage('run skill'),
    makeAgentMessage('Done.', {
      status: 'completed',
      runPolicy: { skill: 'frontend-slides' },
    }),
  ];
  const result = getImplicitContinuationContext(messages);
  assert.equal(result.shouldContinue, false);
});

test('getImplicitContinuationContext returns shouldContinue=true when awaitingImplicitInput is set', () => {
  const messages = [
    makeUserMessage('run skill'),
    makeAgentMessage('Please confirm the outline above. Would you like to proceed?', {
      status: 'completed',
      runPolicy: { skill: 'frontend-slides' },
      awaitingImplicitInput: true,
      implicitInputReason: 'missing_interrupt',
      implicitInputPrompt: 'Would you like to proceed?',
    }),
  ];
  const result = getImplicitContinuationContext(messages);
  assert.equal(result.shouldContinue, true);
  if (result.shouldContinue) {
    assert.equal(result.skillId, 'frontend-slides');
    assert.equal(result.prompt, 'Would you like to proceed?');
  }
});

test('getImplicitContinuationContext returns shouldContinue=false when no runPolicy.skill', () => {
  const messages = [
    makeAgentMessage('Please confirm?', {
      status: 'completed',
      awaitingImplicitInput: true,
      implicitInputReason: 'missing_interrupt',
    }),
  ];
  const result = getImplicitContinuationContext(messages);
  assert.equal(result.shouldContinue, false);
});

test('getImplicitContinuationContext uses the last agent message even if user messages follow', () => {
  const messages = [
    makeAgentMessage('Please confirm?', {
      status: 'completed',
      runPolicy: { skill: 'frontend-slides' },
      awaitingImplicitInput: true,
      implicitInputReason: 'missing_interrupt',
      implicitInputPrompt: 'Please confirm?',
    }),
    makeUserMessage('confirm'),
  ];
  const result = getImplicitContinuationContext(messages);
  assert.equal(result.shouldContinue, true);
  if (result.shouldContinue) {
    assert.equal(result.skillId, 'frontend-slides');
  }
});

test('buildContinuationPrompt wraps user reply with continuation directive and /skill', () => {
  const prompt = buildContinuationPrompt('yes, proceed', 'frontend-slides', 'Would you like to proceed?');
  assert.ok(prompt.includes('[CONTINUATION]'));
  assert.ok(prompt.includes('frontend-slides'));
  assert.ok(prompt.includes('yes, proceed'));
  assert.ok(prompt.includes('Would you like to proceed?'));
  assert.ok(prompt.includes('Do NOT restart the skill from the beginning'));
  assert.ok(prompt.startsWith('/skill frontend-slides'), 'must start with /skill directive');
  assert.ok(prompt.includes('Do NOT re-ask questions'));
});

test('buildContinuationPrompt handles empty implicitPrompt', () => {
  const prompt = buildContinuationPrompt('confirm', 'frontend-slides', '');
  assert.ok(prompt.includes('[CONTINUATION]'));
  assert.ok(prompt.includes('confirm'));
  assert.ok(!prompt.includes('Agent\'s pending question'));
  assert.ok(prompt.startsWith('/skill frontend-slides'), 'must start with /skill directive');
});

test('explicit pendingInterrupt messages do NOT trigger implicit continuation', () => {
  const messages = [
    makeAgentMessage('Please answer the form.', {
      status: 'awaiting_approval',
      runPolicy: { skill: 'frontend-slides' },
      pendingInterrupt: {
        kind: 'clarification',
        interruptId: 'int-1',
        title: 'Presentation Context',
      },
    }),
  ];
  const result = getImplicitContinuationContext(messages);
  assert.equal(result.shouldContinue, false);
});

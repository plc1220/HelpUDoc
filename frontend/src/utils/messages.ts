import type { ConversationMessage, ConversationMessageMetadata } from '../types';

const sanitizeRunPolicy = (
  runPolicy?: ConversationMessageMetadata['runPolicy'],
): ConversationMessageMetadata['runPolicy'] | undefined => {
  if (!runPolicy) {
    return undefined;
  }

  const sanitized: NonNullable<ConversationMessageMetadata['runPolicy']> = {};
  if (typeof runPolicy.skill === 'string' && runPolicy.skill.trim()) {
    sanitized.skill = runPolicy.skill;
  }
  if (typeof runPolicy.requiresHitlPlan === 'boolean') {
    sanitized.requiresHitlPlan = runPolicy.requiresHitlPlan;
  }
  if (typeof runPolicy.requiresArtifacts === 'boolean') {
    sanitized.requiresArtifacts = runPolicy.requiresArtifacts;
  }
  if (typeof runPolicy.requiredArtifactsMode === 'string' && runPolicy.requiredArtifactsMode.trim()) {
    sanitized.requiredArtifactsMode = runPolicy.requiredArtifactsMode;
  }
  if (typeof runPolicy.prePlanSearchLimit === 'number') {
    sanitized.prePlanSearchLimit = runPolicy.prePlanSearchLimit;
  }
  if (typeof runPolicy.prePlanSearchUsed === 'number') {
    sanitized.prePlanSearchUsed = runPolicy.prePlanSearchUsed;
  }

  return Object.keys(sanitized).length ? sanitized : undefined;
};

export const mapMessagesToAgentHistory = (messages: ConversationMessage[]) => {
  return messages
    .filter((message) => {
      if (typeof message.text !== 'string' || message.text.trim().length === 0) {
        return false;
      }
      const metadata = (message.metadata as ConversationMessageMetadata | null | undefined) || undefined;
      return !(message.sender === 'agent' && metadata?.bodySource === 'summary');
    })
    .map((message) => ({
      role: message.sender === 'agent' ? 'assistant' : 'user',
      content: message.text.trim(),
    }));
};

export const mergeMessageMetadata = (message: ConversationMessage): ConversationMessage => {
  const metadata = message.metadata as ConversationMessageMetadata | null | undefined;
  if (!metadata) {
    return message;
  }
  const thinkingText = message.thinkingText ?? metadata.thinkingText;
  const toolEvents = message.toolEvents ?? metadata.toolEvents;
  if (thinkingText === message.thinkingText && toolEvents === message.toolEvents) {
    return message;
  }
  return {
    ...message,
    thinkingText,
    toolEvents,
  };
};

export const mergeMonotonicAssistantText = (
  existingText: string,
  persistedText: string,
): string => {
  if (!persistedText) {
    return existingText;
  }
  if (!existingText || persistedText.startsWith(existingText)) {
    return persistedText;
  }
  if (existingText.startsWith(persistedText) || existingText.endsWith(persistedText)) {
    return existingText;
  }
  return persistedText;
};

export const buildMessageMetadata = (
  message?: ConversationMessage | null,
): ConversationMessageMetadata | undefined => {
  if (!message) {
    return undefined;
  }
  const existingMetadata = (message.metadata as ConversationMessageMetadata | null | undefined) || undefined;
  const metadata: ConversationMessageMetadata = {};
  if (message.thinkingText) {
    metadata.thinkingText = message.thinkingText;
  }
  if (message.toolEvents?.length) {
    metadata.toolEvents = message.toolEvents;
  }
  if (existingMetadata?.bodySource) {
    metadata.bodySource = existingMetadata.bodySource;
  }
  if (existingMetadata?.runPolicy) {
    const sanitizedRunPolicy = sanitizeRunPolicy(existingMetadata.runPolicy);
    if (sanitizedRunPolicy) {
      metadata.runPolicy = sanitizedRunPolicy;
    }
  }
  if (existingMetadata?.pendingInterrupt) {
    metadata.pendingInterrupt = existingMetadata.pendingInterrupt;
  }
  return Object.keys(metadata).length ? metadata : undefined;
};

export { sanitizeRunPolicy };

/**
 * Whether the agent is waiting on the user right now.
 *
 * The latest agent message decides it, and nothing before that. The Stop button
 * is hidden while the agent is waiting — answering is the thing to do, not
 * stopping — and this used to ask whether *any* message in the conversation
 * held an interrupt. One question the user walked past therefore hid Stop for
 * every later run in that conversation, with no way back: the clearing path
 * runs only when an interrupt is answered through its card.
 *
 * A question from five turns ago says nothing about whether the run happening
 * now can be stopped.
 */
export const isAwaitingUserInput = (messages: readonly ConversationMessage[]): boolean => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.sender !== 'agent') {
      continue;
    }
    const metadata = message.metadata as ConversationMessageMetadata | null | undefined;
    // A local notice — "Failed to submit your decision", and the like — is
    // posted with `sender: 'agent'` and no metadata. It is not a turn, and it
    // often appears while a question is still open, precisely when the user
    // needs the prompt. Treating it as the latest turn would answer "not
    // waiting" on top of the interrupt it is complaining about.
    if (!metadata) {
      continue;
    }
    return Boolean(metadata.pendingInterrupt) || metadata.status === 'awaiting_approval';
  }
  return false;
};

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
  if (existingMetadata?.attachmentJobId) {
    metadata.attachmentJobId = existingMetadata.attachmentJobId;
  }
  if (existingMetadata?.attachmentPrepStatus) {
    metadata.attachmentPrepStatus = existingMetadata.attachmentPrepStatus;
  }
  if (existingMetadata?.attachmentPrepError) {
    metadata.attachmentPrepError = existingMetadata.attachmentPrepError;
  }
  if (existingMetadata?.fileContextRefs?.length) {
    metadata.fileContextRefs = existingMetadata.fileContextRefs;
  }
  return Object.keys(metadata).length ? metadata : undefined;
};

export { sanitizeRunPolicy };

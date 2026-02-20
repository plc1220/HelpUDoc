import type { ConversationMessage, ConversationMessageMetadata } from '../types';

export const mapMessagesToAgentHistory = (messages: ConversationMessage[]) => {
  return messages
    .filter((message) => typeof message.text === 'string' && message.text.trim().length > 0)
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
  if (existingMetadata?.runPolicy) {
    metadata.runPolicy = existingMetadata.runPolicy;
  }
  if (existingMetadata?.pendingInterrupt) {
    metadata.pendingInterrupt = existingMetadata.pendingInterrupt;
  }
  return Object.keys(metadata).length ? metadata : undefined;
};

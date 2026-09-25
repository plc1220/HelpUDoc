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
  const metadata = latestAgentTurnMetadata(messages);
  if (!metadata) {
    return false;
  }
  return Boolean(metadata.pendingInterrupt) || metadata.status === 'awaiting_approval';
};

/**
 * The metadata of the newest real agent turn, or undefined when there is none.
 *
 * "Real" excludes messages with no metadata. A local notice — "Failed to submit
 * your decision", and the like — is posted with `sender: 'agent'` and carries
 * none. It is not a turn, and it often appears while a question is still open,
 * precisely when the user needs the prompt, so treating it as the latest turn
 * answers about the notice instead of the run.
 */
const latestAgentTurnMetadata = (
  messages: readonly ConversationMessage[],
): ConversationMessageMetadata | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.sender !== 'agent') {
      continue;
    }
    const metadata = message.metadata as ConversationMessageMetadata | null | undefined;
    if (!metadata) {
      continue;
    }
    return metadata;
  }
  return undefined;
};

/**
 * Whether a run is on screen and still going.
 *
 * The newest agent turn decides it. Asking whether *any* message in the
 * conversation was left at `running` is the same mistake `isAwaitingUserInput`
 * used to make, and it fails the same way — except this one has no clearing
 * path at all, so it sticks for the life of the conversation.
 *
 * A message is reliably left at `running`. When a newer stream supersedes an
 * older one, the older stream's cleanup skips its own status update to avoid
 * clobbering the newer turn, so its bubble keeps `running` forever. Under a
 * whole-conversation scan that one bubble pins Stop on: the composer offers
 * Stop, the run it refers to is long gone, and pressing it cannot settle
 * anything.
 */
export const isAgentRunInFlight = (messages: readonly ConversationMessage[]): boolean =>
  latestAgentTurnMetadata(messages)?.status === 'running';

/**
 * Settles whatever the newest agent turn is still showing as live.
 *
 * Stop has to work even when the client no longer holds the run: the active-run
 * map is emptied when a stream closes, and a superseded stream never settles
 * its own bubble, so the common case for a stuck `running` bubble is precisely
 * the one where there is nothing left to cancel. Without this the composer
 * keeps offering Stop and pressing it changes nothing.
 *
 * Client state only, and deliberately narrow: only messages still claiming to
 * be live are touched, so a finished turn keeps its own status and its history.
 */
export const stopInFlightAgentMessages = (
  messages: readonly ConversationMessage[],
): ConversationMessage[] => {
  let changed = false;
  const next = messages.map((message) => {
    if (message.sender !== 'agent') {
      return message;
    }
    const metadata = message.metadata as ConversationMessageMetadata | null | undefined;
    if (!metadata) {
      return message;
    }
    if (metadata.status !== 'running' && !metadata.pendingInterrupt) {
      return message;
    }
    changed = true;
    return {
      ...message,
      metadata: { ...metadata, status: 'cancelled' as const, pendingInterrupt: undefined },
    };
  });
  return changed ? next : [...messages];
};

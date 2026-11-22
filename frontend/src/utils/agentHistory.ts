import type { ConversationMessage, ConversationMessageMetadata } from '../types';

/**
 * The history sent to the agent with each run.
 *
 * A run that ends without an answer leaves only a status line in the chat ("The run was
 * stopped.", a clarification card, a failure). Those lines used to be dropped, so the agent
 * saw several user requests in a row with no reply between them, treated them all as open,
 * and worked on stopped requests instead of the latest one.
 *
 * Such a reply is now sent as a short closing note instead, so every earlier request is
 * visibly closed and the latest message is the only open one. The request itself stays in
 * the history, so the user can still refer back to it. The chat on screen is unchanged.
 */
export const CLOSING_NOTES = {
  cancelled: '[No answer: this request was stopped by the user.]',
  failed: '[No answer: the run failed.]',
  unanswered_question: '[No answer: Lumo asked a question or requested approval, and it was not answered.]',
  no_reply: '[No answer: the run ended without a reply.]',
} as const;

export type AgentHistoryEntry = { role: 'user' | 'assistant'; content: string };

const metadataOf = (message: ConversationMessage) =>
  (message.metadata as ConversationMessageMetadata | null | undefined) || undefined;

/** The closing note for an agent message that holds no real answer, or null. */
export const closingNoteFor = (message: ConversationMessage): string | null => {
  if (message.sender !== 'agent') {
    return null;
  }
  const metadata = metadataOf(message);
  const hasAnswer = typeof message.text === 'string'
    && message.text.trim().length > 0
    && metadata?.bodySource !== 'summary';
  if (hasAnswer) {
    return null;
  }
  if (metadata?.pendingInterrupt || metadata?.awaitingImplicitInput || metadata?.status === 'awaiting_approval') {
    return CLOSING_NOTES.unanswered_question;
  }
  switch (metadata?.status) {
    case 'cancelled':
      return CLOSING_NOTES.cancelled;
    case 'failed':
      return CLOSING_NOTES.failed;
    case 'completed':
      return CLOSING_NOTES.no_reply;
    default:
      // Queued or running (the turn in progress), or no status at all: nothing to close.
      return null;
  }
};

export const mapMessagesToAgentHistory = (messages: ConversationMessage[]): AgentHistoryEntry[] => {
  const history: AgentHistoryEntry[] = [];
  for (const message of messages) {
    const note = closingNoteFor(message);
    if (note) {
      history.push({ role: 'assistant', content: note });
      continue;
    }
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const metadata = metadataOf(message);
    if (!text || (message.sender === 'agent' && metadata?.bodySource === 'summary')) {
      continue;
    }
    history.push({ role: message.sender === 'agent' ? 'assistant' : 'user', content: text });
  }
  return history;
};

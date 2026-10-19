/**
 * Props for one chat message that the whole list shares, keyed by message.
 *
 * The bubble reads only its own entries: `messageKey` itself or `messageKey:<field>`
 * (see `interruptFieldKey` and `interruptActionFieldKey`). Comparing the whole record
 * would re-render every message when one answer box changed.
 */
const PER_MESSAGE_RECORD_PROPS = new Set([
  'interruptInputByMessageId',
  'interruptStructuredAnswersByMessageId',
  'interruptSelectedChoicesByMessageId',
  'interruptSubmittingByMessageId',
  'interruptErrorByMessageId',
]);

const sameEntriesForMessage = (
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
  messageKey: string,
): boolean => {
  const prefix = `${messageKey}:`;
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
  for (const key of keys) {
    if (key !== messageKey && !key.startsWith(prefix)) continue;
    if (previous?.[key] !== next?.[key]) return false;
  }
  return true;
};

type BubbleProps = { message: { id: unknown } } & Record<string, unknown>;

/**
 * Whether a chat message can skip re-rendering.
 *
 * Every chat state change used to re-render every message, re-parsing its Markdown:
 * in a 238-message conversation one keystroke blocked the page for over a second. A
 * message now re-renders only when its own data, or a shared prop it reads, changes.
 */
export const areChatMessageBubblePropsEqual = (previous: BubbleProps, next: BubbleProps): boolean => {
  const messageId = next.message.id;
  const messageKey = String(messageId);
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    const before = previous[key];
    const after = next[key];
    if (before === after) continue;
    if (PER_MESSAGE_RECORD_PROPS.has(key)) {
      if (!sameEntriesForMessage(
        before as Record<string, unknown> | undefined,
        after as Record<string, unknown> | undefined,
        messageKey,
      )) return false;
      continue;
    }
    if (key === 'expandedToolMessages') {
      const had = (before as Set<unknown> | undefined)?.has(messageId) ?? false;
      const has = (after as Set<unknown> | undefined)?.has(messageId) ?? false;
      if (had !== has) return false;
      continue;
    }
    if (key === 'copiedMessageId') {
      if ((before === messageId) !== (after === messageId)) return false;
      continue;
    }
    return false;
  }
  return true;
};

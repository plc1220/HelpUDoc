/** Messages a conversation opens with; older ones wait behind "Show earlier messages". */
export const INITIAL_VISIBLE_MESSAGES = 40;
/** Messages each "Show earlier messages" adds. */
export const EARLIER_MESSAGES_STEP = 40;
/**
 * Growth larger than this in one update is a history load, not live messages, so the
 * window re-anchors on the newest messages. A turn adds one or two messages.
 */
const BULK_LOAD_THRESHOLD = 10;

export type MessageWindow = {
  /** The conversation the window belongs to. */
  key: string;
  /** Index of the first rendered message. */
  start: number;
  /** Message count the window last saw. */
  length: number;
};

/**
 * The window for this render, or *previous* unchanged.
 *
 * Every message used to stay in the page: a 238-message conversation built 35,000
 * elements and froze on each update. Opening a conversation now renders its newest
 * messages. New messages are appended without moving `start`, so nothing above the
 * reader shifts; a shorter list (a rerun truncated it) still shows its newest messages.
 */
export const nextMessageWindow = (
  previous: MessageWindow | null,
  key: string,
  length: number,
): MessageWindow | null => {
  if (!length) return previous;
  const anchored = (): MessageWindow => ({
    key,
    start: Math.max(0, length - INITIAL_VISIBLE_MESSAGES),
    length,
  });
  if (!previous || previous.key !== key) return anchored();
  if (length === previous.length) return previous;
  if (length - previous.length > BULK_LOAD_THRESHOLD) return anchored();
  return {
    key,
    start: Math.min(previous.start, Math.max(0, length - INITIAL_VISIBLE_MESSAGES)),
    length,
  };
};

export const showEarlierMessages = (window: MessageWindow): MessageWindow => ({
  ...window,
  start: Math.max(0, window.start - EARLIER_MESSAGES_STEP),
});

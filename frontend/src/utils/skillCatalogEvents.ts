/**
 * Tell open workspace pages that the skills a user can run have changed.
 *
 * The workspace loads its skill list once and refetched it only when the copy was
 * over 30 seconds old and the tab regained focus or the "/" menu opened. A draft
 * saved, submitted or approved therefore stayed out of the menu until a reload,
 * although the next chat run already used it. Every successful governance change
 * now announces itself here: in this tab through an EventTarget, and in other tabs
 * of the same browser through a BroadcastChannel.
 */

const CHANNEL_NAME = 'helpudoc-skill-catalog';
const EVENT_NAME = 'skill-catalog-changed';

const sameTab = new EventTarget();
// A BroadcastChannel delivers to every other instance, including listeners in this
// tab, so messages carry their tab and a tab ignores its own (it heard the event).
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

let channel: BroadcastChannel | null | undefined;
const getChannel = (): BroadcastChannel | null => {
  if (channel === undefined) {
    try {
      channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;
      // Node (tests, SSR tooling) keeps a process alive while a channel is open;
      // browsers have no unref and need none.
      (channel as unknown as { unref?: () => void } | null)?.unref?.();
    } catch {
      channel = null;
    }
  }
  return channel;
};

export const notifySkillCatalogChanged = (): void => {
  sameTab.dispatchEvent(new Event(EVENT_NAME));
  try {
    getChannel()?.postMessage({ type: EVENT_NAME, tab: TAB_ID });
  } catch {
    // Closed channel or unsupported environment: other tabs catch up on focus.
  }
};

/** Subscribe to catalog changes from this tab and others. Returns the unsubscribe. */
export const onSkillCatalogChanged = (handler: () => void): (() => void) => {
  const listener = () => handler();
  sameTab.addEventListener(EVENT_NAME, listener);
  let otherTabs: BroadcastChannel | null = null;
  try {
    otherTabs = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;
  } catch {
    otherTabs = null;
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; tab?: string } | null;
    if (data?.type === EVENT_NAME && data.tab !== TAB_ID) handler();
  };
  otherTabs?.addEventListener('message', onMessage);
  return () => {
    sameTab.removeEventListener(EVENT_NAME, listener);
    otherTabs?.removeEventListener('message', onMessage);
    otherTabs?.close();
  };
};

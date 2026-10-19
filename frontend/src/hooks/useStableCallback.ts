import { useCallback, useRef } from 'react';

/**
 * A function whose identity never changes but always calls the latest *callback*.
 *
 * Chat messages skip re-rendering unless a prop changes. A handler rebuilt whenever
 * the composer text or the message list changes (`openScheduleDialog` reads both)
 * re-rendered every message on each keystroke and each streamed update. Use for
 * handlers called from events, never during render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  latest.current = callback;
  return useCallback((...args: Args) => latest.current(...args), []);
}

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const readStoredHeight = (key: string, fallback: number, min: number, max: number) => {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
    if (Number.isFinite(parsed)) {
      return clamp(parsed, min, max);
    }
  } catch {
    // ignore storage errors
  }
  return fallback;
};

export type UseVerticalPaneResizeOptions = {
  storageKey: string;
  defaultHeight: number;
  minHeight: number;
  maxHeight: number;
  enabled?: boolean;
};

export function useVerticalPaneResize({
  storageKey,
  defaultHeight,
  minHeight,
  maxHeight,
  enabled = true,
}: UseVerticalPaneResizeOptions) {
  const [height, setHeight] = useState(() =>
    readStoredHeight(storageKey, defaultHeight, minHeight, maxHeight),
  );
  const [isResizing, setIsResizing] = useState(false);
  const heightRef = useRef(height);
  heightRef.current = height;

  // Optimize performance: only save to localStorage when resizing has finished,
  // or when height is adjusted programmatically/via keyboard (isResizing is false).
  useEffect(() => {
    if (!enabled || isResizing) {
      return;
    }
    try {
      localStorage.setItem(storageKey, String(Math.round(height)));
    } catch {
      // ignore storage errors
    }
  }, [enabled, storageKey, height, isResizing]);

  const createHandleProps = useCallback(() => {
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!enabled || event.button !== 0) {
          return;
        }
        event.preventDefault();
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        setIsResizing(true);
        const startY = event.clientY;
        const startHeight = heightRef.current;

        const handlePointerMove = (moveEvent: PointerEvent) => {
          const delta = startY - moveEvent.clientY;
          setHeight(clamp(startHeight + delta, minHeight, maxHeight));
        };

        const endResize = (upEvent: PointerEvent) => {
          target.releasePointerCapture(upEvent.pointerId);
          target.removeEventListener('pointermove', handlePointerMove);
          target.removeEventListener('pointerup', endResize);
          target.removeEventListener('pointercancel', endResize);
          setIsResizing(false);
        };

        target.addEventListener('pointermove', handlePointerMove);
        target.addEventListener('pointerup', endResize);
        target.addEventListener('pointercancel', endResize);
      },
      onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (!enabled) {
          return;
        }
        let nextHeight = heightRef.current;
        const step = event.shiftKey ? 50 : 15;
        switch (event.key) {
          case 'ArrowUp':
            event.preventDefault();
            nextHeight = clamp(nextHeight + step, minHeight, maxHeight);
            break;
          case 'ArrowDown':
            event.preventDefault();
            nextHeight = clamp(nextHeight - step, minHeight, maxHeight);
            break;
          case 'Home':
            event.preventDefault();
            nextHeight = minHeight;
            break;
          case 'End':
            event.preventDefault();
            nextHeight = maxHeight;
            break;
          default:
            return;
        }
        setHeight(nextHeight);
      },
    };
  }, [enabled, maxHeight, minHeight]);

  return { height, isResizing, createHandleProps, setHeight };
}

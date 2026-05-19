import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const readStoredWidth = (key: string, fallback: number, min: number, max: number) => {
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

export type HorizontalPaneResizeDirection = 'ltr' | 'rtl';

export type UseHorizontalPaneResizeOptions = {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  enabled?: boolean;
};

export function useHorizontalPaneResize({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  enabled = true,
}: UseHorizontalPaneResizeOptions) {
  const [width, setWidth] = useState(() =>
    readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth),
  );
  const [isResizing, setIsResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    try {
      localStorage.setItem(storageKey, String(Math.round(width)));
    } catch {
      // ignore storage errors
    }
  }, [enabled, storageKey, width]);

  const createHandleProps = useCallback(
    (direction: HorizontalPaneResizeDirection) => {
      const sign = direction === 'ltr' ? 1 : -1;

      return {
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
          if (!enabled || event.button !== 0) {
            return;
          }
          event.preventDefault();
          const target = event.currentTarget;
          target.setPointerCapture(event.pointerId);
          setIsResizing(true);
          const startX = event.clientX;
          const startWidth = widthRef.current;

          const handlePointerMove = (moveEvent: PointerEvent) => {
            const delta = sign * (moveEvent.clientX - startX);
            setWidth(clamp(startWidth + delta, minWidth, maxWidth));
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
      };
    },
    [enabled, maxWidth, minWidth],
  );

  return { width, isResizing, createHandleProps, setWidth };
}

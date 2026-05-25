import { useEffect, useMemo, useRef, useState, useCallback, type PointerEvent } from 'react';
import lumoSpriteSheet from '../../assets/lumo/lumo-spritesheet.webp';
import './LumoPet.css';

type PetState =
  | 'idle'
  | 'blink'
  | 'walk'
  | 'wave'
  | 'think'
  | 'sad'
  | 'notify'
  | 'sleep';

type LumoPetProps = {
  colorMode?: 'light' | 'dark';
  workspaceName?: string | null;
  activeFileName?: string | null;
  aiBusy?: boolean;
  hasSuggestion?: boolean;
  onPrompt?: (prompt: string) => void;
};

const SPRITE_COLUMNS = 8;
const SPRITE_ROWS = 9;

const SPRITES = {
  idle: {
    row: 0,
    frames: [0],
    fps: 1,
  },
  blink: {
    row: 0,
    frames: [0, 1, 0],
    fps: 8,
  },
  walk: {
    row: 1,
    frames: [0, 1, 2, 3, 4, 5, 6, 7],
    fps: 12,
  },
  wave: {
    row: 3,
    frames: [0, 1, 2, 3],
    fps: 7,
  },
  think: {
    row: 6,
    frames: [0, 1, 2, 3, 4],
    fps: 5,
  },
  sad: {
    row: 5,
    frames: [0, 1, 2, 3],
    fps: 4,
  },
  notify: {
    row: 7,
    frames: [0, 1, 2, 3, 4],
    fps: 9,
  },
  sleep: {
    row: 8,
    frames: [0, 1, 2, 3],
    fps: 3,
  },
} as const;

const POSITION_STORAGE_KEY = 'helpudoc:lumo-pet-position';
const DRAG_THRESHOLD_PX = 6;

type LumoPosition = { x: number; y: number };

function readStoredPosition(): LumoPosition | null {
  try {
    const raw = localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LumoPosition;
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed;
  } catch {
    /* ignore corrupt storage */
  }
  return null;
}

function clampPosition(x: number, y: number, width: number, height: number): LumoPosition {
  const maxX = Math.max(0, window.innerWidth - width);
  const maxY = Math.max(0, window.innerHeight - height);
  return {
    x: Math.min(Math.max(0, x), maxX),
    y: Math.min(Math.max(0, y), maxY),
  };
}

export default function LumoPet({
  colorMode = 'light',
  aiBusy = false,
  hasSuggestion = false,
}: LumoPetProps) {
  const [state, setState] = useState<PetState>('idle');
  const [frame, setFrame] = useState(0);
  const [facing, setFacing] = useState<'left' | 'right'>('right');
  const [position, setPosition] = useState<LumoPosition | null>(readStoredPosition);
  const [dragging, setDragging] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const blinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);

  const dragSession = useRef({
    active: false,
    moved: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
  });

  const cfg = SPRITES[state];

  const resetSleepTimer = useCallback(() => {
    if (sleepTimer.current) clearTimeout(sleepTimer.current);
    sleepTimer.current = setTimeout(() => {
      setState((current) => (current === 'idle' ? 'sleep' : current));
    }, 20000);
  }, []);

  useEffect(() => {
    if (aiBusy) {
      setState('think');
      resetSleepTimer();
      return;
    }
    if (hasSuggestion) {
      setState('notify');
      resetSleepTimer();
      return;
    }
    setState((current) => (current === 'think' || current === 'notify' ? 'idle' : current));
  }, [aiBusy, hasSuggestion, resetSleepTimer]);

  useEffect(() => {
    const handleGlobalTyping = () => {
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.getAttribute('contenteditable') === 'true')
      ) {
        setState('think');
        resetSleepTimer();

        if (typingTimer.current) clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => {
          setState('idle');
        }, 1500);
      }
    };

    window.addEventListener('keydown', handleGlobalTyping);
    return () => {
      window.removeEventListener('keydown', handleGlobalTyping);
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [resetSleepTimer]);

  useEffect(() => {
    if (state !== 'idle') return;

    const scheduleBlink = () => {
      if (blinkTimer.current) clearTimeout(blinkTimer.current);
      blinkTimer.current = setTimeout(() => {
        setState('blink');
      }, 4000 + Math.random() * 5000);
    };

    scheduleBlink();
    resetSleepTimer();

    return () => {
      if (blinkTimer.current) clearTimeout(blinkTimer.current);
    };
  }, [state, resetSleepTimer]);

  useEffect(() => {
    if (state !== 'idle') {
      if (sleepTimer.current) clearTimeout(sleepTimer.current);
    }
  }, [state]);

  useEffect(() => {
    setFrame(0);

    const loops =
      state === 'idle' ||
      state === 'walk' ||
      state === 'think' ||
      state === 'sleep' ||
      state === 'notify';

    const id = setInterval(() => {
      setFrame((f) => {
        const nextFrame = f + 1;
        if (nextFrame >= cfg.frames.length) {
          if (!loops) {
            clearInterval(id);
            setState('idle');
            return 0;
          }
          return 0;
        }
        return nextFrame;
      });
    }, 1000 / cfg.fps);

    return () => clearInterval(id);
  }, [state, cfg.fps, cfg.frames.length]);

  useEffect(() => {
    if (!position) return;
    const clampToViewport = () => {
      const root = rootRef.current;
      if (!root) return;
      setPosition((current) => {
        if (!current) return current;
        return clampPosition(current.x, current.y, root.offsetWidth, root.offsetHeight);
      });
    };
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, [position]);

  const finishDrag = () => {
    dragSession.current.active = false;
    setDragging(false);
    dragSession.current.moved = false;
    setState('idle');
  };

  const handlePetPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    dragSession.current = {
      active: true,
      moved: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    resetSleepTimer();
  };

  const handlePetPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const session = dragSession.current;
    if (!session.active || event.pointerId !== session.pointerId) return;
    const root = rootRef.current;
    if (!root) return;

    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;

    session.moved = true;
    setDragging(true);
    setFacing(dx > 0 ? 'right' : 'left');
    setState('walk');

    const next = clampPosition(
      session.originX + dx,
      session.originY + dy,
      root.offsetWidth,
      root.offsetHeight,
    );
    setPosition(next);
  };

  const handlePetPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const session = dragSession.current;
    if (!session.active || event.pointerId !== session.pointerId) return;
    if (session.moved) {
      suppressClickRef.current = true;
      localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishDrag();
  };

  const handlePetPointerCancel = (event: PointerEvent<HTMLButtonElement>) => {
    const session = dragSession.current;
    if (!session.active || event.pointerId !== session.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishDrag();
  };

  const handleDoubleClick = () => {
    setState('wave');
    resetSleepTimer();
  };

  const bg = useMemo(() => {
    const col = cfg.frames[frame % cfg.frames.length];
    const row = cfg.row;

    const xPct = (col / (SPRITE_COLUMNS - 1)) * 100;
    const yPct = (row / (SPRITE_ROWS - 1)) * 100;

    return {
      backgroundImage: `url(${lumoSpriteSheet})`,
      backgroundPosition: `${xPct}% ${yPct}%`,
      backgroundSize: `${SPRITE_COLUMNS * 100}% ${SPRITE_ROWS * 100}%`,
      transform: facing === 'left' ? 'scaleX(-1)' : 'scaleX(1)',
    };
  }, [frame, state, facing, cfg]);

  const rootStyle = position ? { left: position.x, top: position.y } : undefined;

  return (
    <div
      ref={rootRef}
      className={`lumo-root${position ? ' lumo-root--placed' : ''}${dragging ? ' lumo-root--dragging' : ''}`}
      data-state={state}
      data-theme={colorMode}
      style={rootStyle}
    >
      <button
        type="button"
        className="lumo-pet-button"
        onPointerDown={handlePetPointerDown}
        onPointerMove={handlePetPointerMove}
        onPointerUp={handlePetPointerUp}
        onPointerCancel={handlePetPointerCancel}
        onDoubleClick={handleDoubleClick}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
          }
        }}
        aria-label="Lumo. Double click to wave, drag to move."
        title="Double click to wave. Drag to move."
      >
        <span className="lumo-sprite" aria-hidden style={bg} />
        <span className="sr-only">Lumo</span>
      </button>
    </div>
  );
}

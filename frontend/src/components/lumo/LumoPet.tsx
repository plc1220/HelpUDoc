import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import { Bell, Send, X } from 'lucide-react';
import lumoSpriteSheet from '../../assets/lumo/lumo-spritesheet.webp';
import './LumoPet.css';

type LumoState = 'idle' | 'blink' | 'thinking' | 'typing' | 'happy' | 'notification' | 'wave';

type LumoPetProps = {
  colorMode: 'light' | 'dark';
  workspaceName?: string | null;
  activeFileName?: string | null;
  aiBusy?: boolean;
  hasSuggestion?: boolean;
  onPrompt: (prompt: string) => void;
};

const SPRITE_COLUMNS = 8;
const SPRITE_ROWS = 9;

type SpriteFrame = readonly [column: number, row: number];

const spriteFrames = {
  idle: [0, 0],
  blink: [1, 0],
  curious: [3, 0],
  wink: [4, 0],
  waveStart: [0, 3],
  waveHigh: [1, 3],
  waveSettle: [2, 3],
  waveEnd: [3, 3],
  happyOpen: [1, 4],
  happyLift: [2, 4],
  happyHop: [3, 4],
  happySettle: [4, 4],
  thinkingLook: [0, 6],
  thinkingPaws: [1, 6],
  thinkingTilt: [2, 6],
  thinkingCheek: [3, 6],
  focusStart: [1, 7],
  focusPinch: [2, 7],
  focusHold: [3, 7],
  focusSquint: [4, 7],
  focusBlink: [5, 7],
} as const satisfies Record<string, SpriteFrame>;

const lumoSequences: Record<LumoState, SpriteFrame[]> = {
  idle: [spriteFrames.idle],
  blink: [spriteFrames.blink, spriteFrames.idle],
  thinking: [spriteFrames.focusStart, spriteFrames.focusPinch, spriteFrames.focusHold, spriteFrames.focusSquint, spriteFrames.focusBlink, spriteFrames.focusHold],
  typing: [spriteFrames.thinkingLook, spriteFrames.thinkingPaws, spriteFrames.thinkingTilt, spriteFrames.thinkingCheek],
  happy: [spriteFrames.happyOpen, spriteFrames.happyLift, spriteFrames.happyHop, spriteFrames.happySettle],
  notification: [spriteFrames.curious, spriteFrames.wink, spriteFrames.curious, spriteFrames.idle],
  wave: [spriteFrames.waveStart, spriteFrames.waveHigh, spriteFrames.waveSettle, spriteFrames.waveEnd],
};

const frameSpeeds: Record<LumoState, number> = {
  idle: 0,
  blink: 160,
  thinking: 260,
  typing: 180,
  happy: 170,
  notification: 360,
  wave: 150,
};

const loopingStates = new Set<LumoState>(['thinking', 'typing', 'notification']);

const quickPrompts = [
  'Summarize the current workspace and suggest the next documentation step.',
  'Review the selected file for clarity, missing context, and confusing sections.',
  'Create a concise outline for the document I should write next.',
];

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
  colorMode,
  workspaceName,
  activeFileName,
  aiBusy = false,
  hasSuggestion = false,
  onPrompt,
}: LumoPetProps) {
  const [state, setState] = useState<LumoState>('idle');
  const [sequenceStep, setSequenceStep] = useState(0);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [position, setPosition] = useState<LumoPosition | null>(readStoredPosition);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const blinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureReturnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragSession = useRef({
    active: false,
    moved: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
  });
  const suppressClickRef = useRef(false);

  const contextLine = useMemo(() => {
    const bits = [workspaceName, activeFileName].filter(Boolean);
    return bits.length ? bits.join(' / ') : 'HelpUDoc';
  }, [activeFileName, workspaceName]);

  const sequence = lumoSequences[state];
  const [spriteColumn, spriteRow] = sequence[sequenceStep % sequence.length];
  const spritePosition = `${(spriteColumn / (SPRITE_COLUMNS - 1)) * 100}% ${(spriteRow / (SPRITE_ROWS - 1)) * 100}%`;

  useEffect(() => {
    if (aiBusy) {
      setState('thinking');
      return;
    }
    if (hasSuggestion) {
      setState('notification');
      return;
    }
    setState((current) => (current === 'thinking' || current === 'notification' ? 'idle' : current));
  }, [aiBusy, hasSuggestion]);

  useEffect(() => {
    if (open) return;
    const scheduleBlink = () => {
      if (blinkTimer.current) clearTimeout(blinkTimer.current);
      blinkTimer.current = setTimeout(() => {
        setState((current) => (current === 'idle' ? 'blink' : current));
        scheduleBlink();
      }, 18000 + Math.random() * 9000);
    };
    scheduleBlink();
    return () => {
      if (blinkTimer.current) clearTimeout(blinkTimer.current);
    };
  }, [open]);

  useEffect(() => {
    setSequenceStep(0);
    if (gestureReturnTimer.current) clearTimeout(gestureReturnTimer.current);
    const speed = frameSpeeds[state];
    const totalFrames = lumoSequences[state].length;
    if (!speed || totalFrames <= 1) return;

    const loops = loopingStates.has(state);
    let raf = 0;
    let last = performance.now();
    let accumulated = 0;
    let virtualStep = 0;
    let done = false;
    const tick = (now: number) => {
      if (done) return;
      accumulated += now - last;
      last = now;
      if (accumulated >= speed) {
        const steps = Math.floor(accumulated / speed);
        accumulated %= speed;
        virtualStep += steps;
        if (!loops && virtualStep >= totalFrames - 1) {
          virtualStep = totalFrames - 1;
          done = true;
          setSequenceStep(virtualStep);
          gestureReturnTimer.current = setTimeout(() => setState('idle'), speed);
          return;
        }
        setSequenceStep(virtualStep);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      done = true;
      if (gestureReturnTimer.current) clearTimeout(gestureReturnTimer.current);
      cancelAnimationFrame(raf);
    };
  }, [state]);

  useEffect(
    () => () => {
      if (blinkTimer.current) clearTimeout(blinkTimer.current);
      if (gestureReturnTimer.current) clearTimeout(gestureReturnTimer.current);
      if (typingTimer.current) clearTimeout(typingTimer.current);
    },
    [],
  );

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

  const resolveRootPosition = (): LumoPosition => {
    const root = rootRef.current;
    if (!root) return { x: 0, y: 0 };
    const rect = root.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  };

  const finishDrag = () => {
    dragSession.current.active = false;
    setDragging(false);
    dragSession.current.moved = false;
  };

  const handlePetPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    const anchor = position ?? resolveRootPosition();
    dragSession.current = {
      active: true,
      moved: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: anchor.x,
      originY: anchor.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
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
    const next = clampPosition(session.originX + dx, session.originY + dy, root.offsetWidth, root.offsetHeight);
    setPosition(next);
  };

  const handlePetPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const session = dragSession.current;
    if (!session.active || event.pointerId !== session.pointerId) return;
    if (session.moved) {
      suppressClickRef.current = true;
      const root = rootRef.current;
      if (root) {
        const rect = root.getBoundingClientRect();
        const next = clampPosition(rect.left, rect.top, root.offsetWidth, root.offsetHeight);
        setPosition(next);
        localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(next));
      }
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

  const submitPrompt = (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onPrompt(trimmed);
    setInput('');
    setOpen(false);
    setState('happy');
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitPrompt(input);
  };

  const rootStyle = position ? { left: position.x, top: position.y } : undefined;

  return (
    <div
      ref={rootRef}
      className={`lumo-root${position ? ' lumo-root--placed' : ''}${dragging ? ' lumo-root--dragging' : ''}`}
      data-state={state}
      data-theme={colorMode}
      style={rootStyle}
    >
      {open ? (
        <section className="lumo-panel" aria-label="Lumo helper">
          <header className="lumo-panel-header">
            <div className="lumo-panel-title">
              <strong>Lumo</strong>
              <span>{contextLine}</span>
            </div>
            <button type="button" className="lumo-icon-button" onClick={() => setOpen(false)} aria-label="Close Lumo">
              <X size={16} />
            </button>
          </header>
          <div className="lumo-panel-body">
            <p>Lumo is ready to help shape the next bit of documentation.</p>
            <div className="lumo-quick-row">
              {quickPrompts.map((prompt) => (
                <button key={prompt} type="button" onClick={() => submitPrompt(prompt)}>
                  {prompt.split(' ').slice(0, 3).join(' ')}
                </button>
              ))}
            </div>
          </div>
          <form className="lumo-input-row" onSubmit={handleSubmit}>
            <input
              value={input}
              placeholder="Ask Lumo..."
              onChange={(event) => {
                setInput(event.target.value);
                if (typingTimer.current) clearTimeout(typingTimer.current);
                if (event.target.value) {
                  setState('typing');
                  typingTimer.current = setTimeout(() => setState('idle'), 850);
                } else {
                  setState('idle');
                }
              }}
            />
            <button type="submit" aria-label="Send Lumo prompt">
              <Send size={16} />
            </button>
          </form>
        </section>
      ) : null}

      {!open && state === 'notification' ? (
        <div className="lumo-bubble">
          <Bell size={14} />
          Thought ready
        </div>
      ) : null}

      <button
        type="button"
        className="lumo-pet-button"
        onPointerDown={handlePetPointerDown}
        onPointerMove={handlePetPointerMove}
        onPointerUp={handlePetPointerUp}
        onPointerCancel={handlePetPointerCancel}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          setOpen(true);
          setState('wave');
        }}
        aria-label="Open Lumo. Drag to move."
        title="Drag to move Lumo"
      >
        {state === 'notification' ? <span className="lumo-notification-dot" aria-hidden /> : null}
        <span
          className="lumo-sprite"
          aria-hidden
          style={{
            backgroundImage: `url(${lumoSpriteSheet})`,
            backgroundPosition: spritePosition,
            backgroundSize: `${SPRITE_COLUMNS * 100}% ${SPRITE_ROWS * 100}%`,
          }}
        />
        <span className="sr-only">Lumo</span>
      </button>
    </div>
  );
}

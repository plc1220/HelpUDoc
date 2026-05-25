import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
  const blinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureReturnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return (
    <div className="lumo-root" data-state={state} data-theme={colorMode}>
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
        onClick={() => {
          setOpen(true);
          setState('wave');
        }}
        aria-label="Open Lumo"
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

import { useCallback, useEffect, useRef, useState } from 'react';

const preferenceKey = (userId: string) => `helpudoc.notifications.sound.${userId}`;

export function useNotificationSound(userId?: string) {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const controls = useRef({ enable: () => {}, mute: () => {}, test: () => {}, play: () => {} });

  useEffect(() => {
    let active = true;
    let soundEnabled = false;
    let context: AudioContext | null = null;
    const key = userId ? preferenceKey(userId) : null;
    try { soundEnabled = Boolean(key && localStorage.getItem(key) === 'true'); } catch { /* Storage can be unavailable. */ }
    setEnabled(soundEnabled); setReady(false); setError('');

    const save = (value: boolean) => {
      soundEnabled = value;
      setEnabled(value);
      try { if (key) localStorage.setItem(key, String(value)); } catch { /* Keep the preference for this session. */ }
    };
    const activate = async () => {
      if (!active || !userId) return false;
      if (!context || context.state === 'closed') {
        context = new AudioContext();
        context.onstatechange = () => { if (active) setReady(context?.state === 'running'); };
      }
      if (context.state !== 'running') await context.resume();
      if (!active) return false;
      const running = context.state === 'running';
      setReady(running);
      return running;
    };
    const play = () => {
      // Never queue sounds while audio is blocked, or replay the inbox on activation.
      if (!active || !soundEnabled || context?.state !== 'running') return;
      const audio = context;
      [660, 880].forEach((frequency, index) => {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const start = audio.currentTime + index * 0.16;
        oscillator.frequency.value = frequency;
        oscillator.type = 'sine';
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.08, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(start);
        oscillator.stop(start + 0.24);
      });
    };
    const test = async () => {
      try {
        if (!await activate()) throw new Error('Audio is paused');
        if (!active || !soundEnabled) return;
        play();
        setError('');
      } catch {
        if (active) setError('Sound is unavailable or paused. Try Test sound again.');
      }
    };
    const unlock = () => {
      if (soundEnabled) void activate().catch(() => { if (active) setReady(false); });
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) {
        soundEnabled = event.key !== null && event.newValue === 'true';
        setEnabled(soundEnabled);
      }
    };
    controls.current = {
      enable: () => { save(true); void test(); },
      mute: () => { save(false); setError(''); },
      test: () => { void test(); },
      play: () => { try { play(); } catch { setError('Sound is unavailable. Try Test sound again.'); } },
    };
    // A saved preference still needs a user gesture after loading a new tab.
    window.addEventListener('click', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('storage', onStorage);
    return () => {
      active = false;
      window.removeEventListener('click', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('storage', onStorage);
      if (context) { context.onstatechange = null; void context.close().catch(() => {}); }
      controls.current = { enable: () => {}, mute: () => {}, test: () => {}, play: () => {} };
    };
  }, [userId]);

  const play = useCallback(() => controls.current.play(), []);
  return {
    enabled, ready, error, play,
    enable: () => controls.current.enable(),
    mute: () => controls.current.mute(),
    test: () => controls.current.test(),
  };
}

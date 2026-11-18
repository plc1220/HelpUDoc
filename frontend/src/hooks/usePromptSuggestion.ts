import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationMessage } from '../types';
import { API_URL, apiFetch } from '../services/apiClient';

/** A suggestion is a placeholder, never a draft or a submitted message. */
export function usePromptSuggestion(
  messages: ConversationMessage[],
  conversationScope: string,
  isBusy: boolean,
) {
  const context = useMemo(() => {
    const latest = messages.at(-1);
    if (isBusy || !latest || latest.sender !== 'agent' || !latest.text.trim()
      || latest.metadata?.pendingInterrupt || latest.metadata?.awaitingImplicitInput
      || (latest.metadata?.status && latest.metadata.status !== 'completed')
      || !messages.some(message => message.sender === 'user')) return '';
    return JSON.stringify(messages.filter(message => message.text.trim()).slice(-6).map(message => ({
      role: message.sender === 'agent' ? 'assistant' : 'user',
      content: message.text.trim().slice(-4000),
    })));
  }, [messages, isBusy]);
  const key = context ? `${conversationScope}:${context}` : '';
  const [result, setResult] = useState({ key: '', text: '' });
  const cache = useRef(new Map<string, string>());

  useEffect(() => {
    if (!key) return;
    const cached = cache.current.get(key);
    if (cached !== undefined) {
      setResult({ key, text: cached });
      return;
    }
    const controller = new AbortController();
    // Wait for the completed turn to settle before making the optional request.
    const timer = window.setTimeout(async () => {
      let text = '';
      try {
        const response = await apiFetch(`${API_URL}/agent/prompt-suggestion`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: JSON.parse(context) }),
          signal: controller.signal,
        });
        if (response.ok) {
          const payload = await response.json();
          if (typeof payload.suggestion === 'string' && payload.suggestion.length <= 500) text = payload.suggestion.trim();
        }
      } catch { /* An optional hint must never interrupt chat. */ }
      if (controller.signal.aborted) return;
      if (cache.current.size >= 20) cache.current.clear();
      cache.current.set(key, text);
      setResult({ key, text });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [context, key]);

  return key && result.key === key ? result.text : '';
}

import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../types';
import { API_URL, apiFetch } from '../services/apiClient';

type StarterPrompt = { label: string; prompt: string };

export function useWorkspaceStarterPrompts(workspace: Workspace | null, enabled: boolean, fileRevision: string) {
  const workspaceId = workspace?.id;
  const key = enabled && workspaceId
    ? JSON.stringify([workspaceId, workspace.name, workspace.contentRevision, workspace.role, fileRevision]) : '';
  const cache = useRef(new Map<string, { expires: number; prompts: StarterPrompt[] }>());
  const [result, setResult] = useState<{ key: string; prompts: StarterPrompt[] }>({ key: '', prompts: [] });

  useEffect(() => {
    if (!key || !workspaceId) return;
    const cached = cache.current.get(key);
    if (cached && cached.expires > Date.now()) {
      setResult({ key, prompts: cached.prompts });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      let prompts: StarterPrompt[] = [];
      try {
        const response = await apiFetch(`${API_URL}/agent/workspace-starter-prompts`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }), signal: controller.signal,
        });
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data.prompts) && data.prompts.length >= 2 && data.prompts.length <= 4
            && data.prompts.every((item: StarterPrompt) => typeof item?.label === 'string' && item.label.trim()
              && item.label.length <= 48 && typeof item.prompt === 'string' && item.prompt.trim() && item.prompt.length <= 600)) {
            prompts = data.prompts.map(({ label, prompt }: StarterPrompt) => ({ label, prompt }));
          }
        }
      } catch { /* Keep the generic starters available when Lite is unavailable. */ }
      if (controller.signal.aborted) return;
      if (cache.current.size >= 20) cache.current.clear();
      cache.current.set(key, { expires: Date.now() + (prompts.length ? 5 * 60 * 1000 : 30000), prompts });
      setResult({ key, prompts });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key, workspaceId]);

  return key && result.key === key ? result.prompts : [];
}

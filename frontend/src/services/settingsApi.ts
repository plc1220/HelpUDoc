import type { PromptDefinition } from '../types';

const API_URL = 'http://localhost:3000/api';

export const fetchAgentConfig = async (): Promise<string> => {
  const response = await fetch(`${API_URL}/settings/agent-config`);
  if (!response.ok) {
    throw new Error('Failed to load agents.yaml');
  }
  const data = await response.json();
  return data.content;
};

export const saveAgentConfig = async (content: string) => {
  const response = await fetch(`${API_URL}/settings/agent-config`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    throw new Error('Failed to save agents.yaml');
  }
};

export const fetchPrompts = async (): Promise<PromptDefinition[]> => {
  const response = await fetch(`${API_URL}/settings/prompts`);
  if (!response.ok) {
    throw new Error('Failed to load prompts');
  }
  const data = await response.json();
  return data.prompts;
};

export const savePrompt = async (id: string, content: string) => {
  const response = await fetch(`${API_URL}/settings/prompts`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id, content }),
  });
  if (!response.ok) {
    throw new Error('Failed to save prompt');
  }
};

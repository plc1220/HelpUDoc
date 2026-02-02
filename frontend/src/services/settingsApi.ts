import type { SkillDefinition } from '../types';
import { API_URL, apiFetch } from './apiClient';

export const fetchAgentConfig = async (): Promise<string> => {
  const response = await apiFetch(`${API_URL}/settings/agent-config`);
  if (!response.ok) {
    throw new Error('Failed to load runtime config');
  }
  const data = await response.json();
  return data.content;
};

export const saveAgentConfig = async (content: string) => {
  const response = await apiFetch(`${API_URL}/settings/agent-config`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    throw new Error('Failed to save runtime config');
  }
};

export const fetchSkills = async (): Promise<SkillDefinition[]> => {
  const response = await apiFetch(`${API_URL}/settings/skills`);
  if (!response.ok) {
    throw new Error('Failed to load skills');
  }
  const data = await response.json();
  return data.skills;
};

export const createSkill = async (payload: { id: string; name?: string; description?: string }) => {
  const response = await apiFetch(`${API_URL}/settings/skills`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to create skill');
  }
};

export const fetchSkillFiles = async (id: string): Promise<string[]> => {
  const response = await apiFetch(`${API_URL}/settings/skills/${id}/files`);
  if (!response.ok) {
    throw new Error('Failed to load skill files');
  }
  const data = await response.json();
  return data.files;
};

export const fetchSkillContent = async (id: string, filePath: string): Promise<string> => {
  const response = await apiFetch(`${API_URL}/settings/skills/${id}/content?path=${encodeURIComponent(filePath)}`);
  if (!response.ok) {
    throw new Error('Failed to load skill content');
  }
  const data = await response.json();
  return data.content;
};

export const saveSkillContent = async (id: string, filePath: string, content: string) => {
  const response = await apiFetch(`${API_URL}/settings/skills/${id}/content`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: filePath, content }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to save skill content');
  }
};

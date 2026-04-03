import type {
  UserMemorySection,
  UserMemorySuggestion,
  UserMemoryView,
  UserMemoryScope,
} from '../types';
import { apiFetch, API_URL } from './apiClient';

export async function getUserMemory(workspaceId?: string): Promise<UserMemoryView> {
  const params = new URLSearchParams();
  if (workspaceId) {
    params.set('workspaceId', workspaceId);
  }
  const response = await apiFetch(`${API_URL}/me/memory${params.toString() ? `?${params.toString()}` : ''}`);
  if (!response.ok) {
    throw new Error('Failed to load user memory');
  }
  return response.json();
}

export async function updateUserMemory(input: {
  scope: UserMemoryScope;
  section: UserMemorySection;
  workspaceId?: string;
  content: string;
}): Promise<UserMemoryView> {
  const response = await apiFetch(`${API_URL}/me/memory`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error('Failed to update user memory');
  }
  return response.json();
}

export async function getUserMemorySuggestions(workspaceId?: string): Promise<UserMemorySuggestion[]> {
  const params = new URLSearchParams();
  if (workspaceId) {
    params.set('workspaceId', workspaceId);
  }
  const response = await apiFetch(
    `${API_URL}/me/memory/suggestions${params.toString() ? `?${params.toString()}` : ''}`,
  );
  if (!response.ok) {
    throw new Error('Failed to load memory suggestions');
  }
  return response.json();
}

export async function decideUserMemorySuggestion(
  suggestionId: string,
  payload: { decision: 'accept' | 'reject'; editedContent?: string },
): Promise<UserMemorySuggestion> {
  const response = await apiFetch(`${API_URL}/me/memory/suggestions/${encodeURIComponent(suggestionId)}/decision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'Failed to apply memory suggestion decision');
  }
  return response.json();
}

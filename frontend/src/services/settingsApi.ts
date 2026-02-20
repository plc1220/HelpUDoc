import type { SkillDefinition } from '../types';
import { API_URL, apiFetch } from './apiClient';

export type ManagedUser = {
  id: string;
  externalId: string;
  displayName: string;
  email?: string | null;
  isAdmin: boolean;
};

export type ManagedGroup = {
  id: string;
  name: string;
};

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

export const fetchUsers = async (): Promise<ManagedUser[]> => {
  const response = await apiFetch(`${API_URL}/users`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to load users');
  }
  const data = await response.json();
  return data.users;
};

export const setUserAdmin = async (userId: string, isAdmin: boolean): Promise<ManagedUser> => {
  const response = await apiFetch(`${API_URL}/users/${userId}/admin`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isAdmin }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to update user admin role');
  }
  const data = await response.json();
  return data.user;
};

export const fetchGroups = async (): Promise<ManagedGroup[]> => {
  const response = await apiFetch(`${API_URL}/users/groups/list`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to load groups');
  }
  const data = await response.json();
  return data.groups;
};

export const createGroup = async (name: string): Promise<ManagedGroup> => {
  const response = await apiFetch(`${API_URL}/users/groups`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to create group');
  }
  const data = await response.json();
  return data.group;
};

export const deleteGroup = async (groupId: string): Promise<void> => {
  const response = await apiFetch(`${API_URL}/users/groups/${groupId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to delete group');
  }
};

export const fetchGroupMembers = async (groupId: string): Promise<ManagedUser[]> => {
  const response = await apiFetch(`${API_URL}/users/groups/${groupId}/members`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to load group members');
  }
  const data = await response.json();
  return data.members;
};

export const addGroupMember = async (groupId: string, userId: string): Promise<void> => {
  const response = await apiFetch(`${API_URL}/users/groups/${groupId}/members`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ userId }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to add member');
  }
};

export const removeGroupMember = async (groupId: string, userId: string): Promise<void> => {
  const response = await apiFetch(`${API_URL}/users/groups/${groupId}/members/${userId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to remove member');
  }
};

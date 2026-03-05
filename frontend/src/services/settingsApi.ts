import type { SkillDefinition } from '../types';
import type { AgentStreamChunk } from '../../../packages/shared/src/services/agentStream';
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

export type SkillBuilderAction =
  | {
      type: 'create_skill';
      skillId: string;
      name?: string;
      description?: string;
      template?: string;
    }
  | {
      type: 'upsert_text';
      skillId: string;
      path: string;
      content: string;
      encoding: 'utf-8';
    }
  | {
      type: 'upload_binary_from_context';
      skillId: string;
      contextFileId: string;
      targetPath: string;
    }
  | {
      type: 'delete_file';
      skillId: string;
      path: string;
    };

export type ApplyActionsResult = {
  success: boolean;
  results: Array<{
    index: number;
    type: string;
    status: 'ok' | 'error';
    message?: string;
  }>;
  error?: string;
};

export type SkillBuilderSession = {
  workspaceId: string;
  limits: {
    maxFileSize: number;
    maxFiles: number;
  };
  allowedExtensions: string[];
};

export type SkillBuilderContextFile = {
  fileId: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType: string;
  uploadedAt?: string;
};

export type SkillBuilderRun = {
  runId: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  workspaceId: string;
  persona: string;
};

export type GithubImportInspectResult = {
  importSessionId: string;
  source: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
    url: string;
  };
  detectedSkillId: string;
  filesPreview: Array<{ path: string; size: number }>;
  warnings: string[];
};

const unwrapError = async (response: Response, fallback: string) => {
  const data = await response.json().catch(() => ({}));
  const message = typeof data.error === 'string' ? data.error : fallback;
  throw new Error(message);
};

export const fetchAgentConfig = async (): Promise<string> => {
  const response = await apiFetch(`${API_URL}/settings/agent-config`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const apiError = typeof data.error === 'string' ? data.error : '';
    if (response.status === 401 || response.status === 403 || /admin access required/i.test(apiError)) {
      throw new Error('Admin access required to open Settings.');
    }
    throw new Error(apiError || 'Failed to load runtime config');
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
    const data = await response.json().catch(() => ({}));
    const apiError = typeof data.error === 'string' ? data.error : '';
    if (response.status === 401 || response.status === 403 || /admin access required/i.test(apiError)) {
      throw new Error('Admin access required to update Settings.');
    }
    throw new Error(apiError || 'Failed to save runtime config');
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

export const parseSkillBuilderActions = async (text: string): Promise<SkillBuilderAction[]> => {
  const response = await apiFetch(`${API_URL}/settings/skills/parse-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    await unwrapError(response, 'Failed to parse actions');
  }
  const data = await response.json();
  return data.actions;
};

export const applySkillBuilderActions = async (actions: SkillBuilderAction[]): Promise<ApplyActionsResult> => {
  const response = await apiFetch(`${API_URL}/settings/skills/apply-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      success: false,
      results: data.results || [],
      error: data.error || 'Failed to apply actions',
    };
  }
  return data;
};

export const createSkillBuilderSession = async (): Promise<SkillBuilderSession> => {
  const response = await apiFetch(`${API_URL}/settings/skill-builder/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) {
    await unwrapError(response, 'Failed to create Skill Builder session');
  }
  return response.json();
};

export const uploadSkillBuilderContextFile = async (file: File): Promise<SkillBuilderContextFile> => {
  const form = new FormData();
  form.append('file', file);
  const response = await apiFetch(`${API_URL}/settings/skill-builder/context-files`, {
    method: 'POST',
    body: form,
  });
  if (!response.ok) {
    await unwrapError(response, 'Failed to upload context file');
  }
  return response.json();
};

export const listSkillBuilderContextFiles = async (): Promise<SkillBuilderContextFile[]> => {
  const response = await apiFetch(`${API_URL}/settings/skill-builder/context-files`);
  if (!response.ok) {
    await unwrapError(response, 'Failed to list context files');
  }
  const data = await response.json();
  return data.files || [];
};

export const deleteSkillBuilderContextFile = async (fileId: string) => {
  const response = await apiFetch(`${API_URL}/settings/skill-builder/context-files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    await unwrapError(response, 'Failed to delete context file');
  }
};

export const startSkillBuilderRun = async (payload: {
  prompt: string;
  history?: Array<{ role: string; content: string }>;
  contextFileIds?: string[];
  selectedSkillId?: string;
  turnId?: string;
  forceReset?: boolean;
}): Promise<SkillBuilderRun> => {
  const response = await apiFetch(`${API_URL}/settings/skill-builder/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await unwrapError(response, 'Failed to start Skill Builder run');
  }
  return response.json();
};

export const getSkillBuilderRun = async (runId: string) => {
  const response = await apiFetch(`${API_URL}/settings/skill-builder/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) {
    await unwrapError(response, 'Failed to fetch Skill Builder run');
  }
  return response.json();
};

export const cancelSkillBuilderRun = async (runId: string) => {
  const response = await apiFetch(`${API_URL}/settings/skill-builder/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
  if (!response.ok) {
    await unwrapError(response, 'Failed to cancel Skill Builder run');
  }
  return response.json();
};

export const submitSkillBuilderDecision = async (
  runId: string,
  decision: 'approve' | 'edit' | 'reject',
  options?: {
    editedAction?: { name: string; args: Record<string, unknown> };
    message?: string;
  },
) => {
  const response = await apiFetch(`${API_URL}/settings/skill-builder/runs/${encodeURIComponent(runId)}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      decision,
      editedAction: options?.editedAction,
      message: options?.message,
    }),
  });
  if (!response.ok) {
    await unwrapError(response, 'Failed to submit decision');
  }
  return response.json();
};

export const streamSkillBuilderRun = async (
  runId: string,
  onChunk: (chunk: AgentStreamChunk) => void,
  signal?: AbortSignal,
  afterId?: string,
) => {
  const url = afterId
    ? `${API_URL}/settings/skill-builder/runs/${encodeURIComponent(runId)}/stream?after=${encodeURIComponent(afterId)}`
    : `${API_URL}/settings/skill-builder/runs/${encodeURIComponent(runId)}/stream`;

  const response = await apiFetch(url, { method: 'GET', signal });
  if (!response.ok) {
    await unwrapError(response, 'Failed to stream Skill Builder run');
  }
  if (!response.body) {
    throw new Error('Streaming not supported by this browser');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          const chunk = JSON.parse(line);
          onChunk(chunk);
        } catch (error) {
          console.error('Failed to parse Skill Builder stream chunk', error, line);
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  }

  if (buffer.trim()) {
    try {
      const chunk = JSON.parse(buffer.trim());
      onChunk(chunk);
    } catch (error) {
      console.error('Failed to parse trailing Skill Builder stream chunk', error, buffer);
    }
  }
};

export const inspectGithubSkillImport = async (payload: {
  url: string;
  ref?: string;
  githubToken?: string;
}): Promise<GithubImportInspectResult> => {
  const response = await apiFetch(`${API_URL}/settings/skills/import/github/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await unwrapError(response, 'Failed to inspect GitHub import');
  }
  return response.json();
};

export const applyGithubSkillImport = async (payload: {
  importSessionId: string;
  destinationSkillId?: string;
  onCollision: 'copy';
}): Promise<{ importedSkillId: string; filesImported: number; warnings: string[] }> => {
  const response = await apiFetch(`${API_URL}/settings/skills/import/github/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await unwrapError(response, 'Failed to import skill from GitHub');
  }
  return response.json();
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

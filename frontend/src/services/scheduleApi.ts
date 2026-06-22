import type { WorkspaceSchedule, WorkspaceScheduleDraft, WorkspaceScheduleRun } from '../types';
import { API_URL, apiFetch } from './apiClient';

const readError = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = await response.json();
    if (payload && typeof payload === 'object' && typeof payload.error === 'string') {
      return payload.error;
    }
  } catch {
    // Ignore non-JSON responses.
  }
  return fallback;
};

export const fetchWorkspaceSchedules = async (workspaceId: string): Promise<WorkspaceSchedule[]> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/schedules`);
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to fetch schedules'));
  }
  const payload = await response.json() as { schedules?: WorkspaceSchedule[] };
  return payload.schedules || [];
};

export const createWorkspaceSchedule = async (
  workspaceId: string,
  draft: WorkspaceScheduleDraft,
): Promise<WorkspaceSchedule> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to create schedule'));
  }
  return response.json();
};

export const updateWorkspaceSchedule = async (
  workspaceId: string,
  scheduleId: string,
  patch: Partial<WorkspaceScheduleDraft> & { status?: WorkspaceSchedule['status'] },
): Promise<WorkspaceSchedule> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/schedules/${scheduleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to update schedule'));
  }
  return response.json();
};

export const deleteWorkspaceSchedule = async (
  workspaceId: string,
  scheduleId: string,
): Promise<void> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/schedules/${scheduleId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to delete schedule'));
  }
};

export const runWorkspaceScheduleNow = async (
  workspaceId: string,
  scheduleId: string,
): Promise<WorkspaceScheduleRun> => {
  const response = await apiFetch(`${API_URL}/workspaces/${workspaceId}/schedules/${scheduleId}/run`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to run schedule'));
  }
  return response.json();
};

import { API_URL, apiFetch } from './apiClient';

export type Paper2SlidesJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface Paper2SlidesJobRequest {
  workspaceId: string;
  fileIds: number[];
  brief?: string;
  persona?: string;
  output?: 'slides' | 'poster';
  content?: 'paper' | 'general';
  style?: string;
  length?: 'short' | 'medium' | 'long';
  mode?: 'fast' | 'normal';
  parallel?: number | boolean;
  fromStage?: 'rag' | 'analysis' | 'summary' | 'plan' | 'generate';
}

export interface Paper2SlidesJobStartResponse {
  jobId: string;
  status: Paper2SlidesJobStatus;
  createdAt: string;
}

export interface Paper2SlidesJobStatusResponse {
  jobId: string;
  status: Paper2SlidesJobStatus;
  result?: {
    pdfPath?: string;
    slideImages?: string[];
    htmlPath?: string;
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export const startPaper2SlidesJob = async (
  payload: Paper2SlidesJobRequest,
): Promise<Paper2SlidesJobStartResponse> => {
  const response = await apiFetch(`${API_URL}/agent/paper2slides/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details?.error || 'Failed to start Paper2Slides job');
  }
  return response.json();
};

export const getPaper2SlidesJob = async (
  jobId: string,
): Promise<Paper2SlidesJobStatusResponse> => {
  const response = await apiFetch(`${API_URL}/agent/paper2slides/jobs/${jobId}`);
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details?.error || 'Failed to fetch Paper2Slides job');
  }
  return response.json();
};

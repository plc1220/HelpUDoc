import { API_URL, apiFetch } from './apiClient';

export interface PresentationRequest {
  workspaceId: string;
  brief?: string;
  fileIds: number[];
  persona?: string;
  output?: 'slides' | 'poster';
  content?: 'paper' | 'general';
  style?: string;
  length?: 'short' | 'medium' | 'long';
  mode?: 'fast' | 'normal';
  parallel?: number | boolean;
  fromStage?: 'rag' | 'analysis' | 'summary' | 'plan' | 'generate';
  exportPptx?: boolean;
}

export interface PresentationResponse {
  htmlPath?: string;
  pdfPath?: string;
  pptxPath?: string;
  slideImages?: string[];
  jobId?: string;
}

export const createPresentation = async (payload: PresentationRequest): Promise<PresentationResponse> => {
  const response = await apiFetch(`${API_URL}/agent/presentation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const message = details?.error || 'Failed to generate presentation';
    throw new Error(message);
  }
  return response.json();
};

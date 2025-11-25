const API_URL = 'http://localhost:3000/api';

export interface PresentationRequest {
  workspaceId: string;
  brief?: string;
  fileIds: number[];
  persona?: string;
}

export interface PresentationResponse {
  htmlPath: string;
}

export const createPresentation = async (payload: PresentationRequest): Promise<PresentationResponse> => {
  const response = await fetch(`${API_URL}/agent/presentation`, {
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

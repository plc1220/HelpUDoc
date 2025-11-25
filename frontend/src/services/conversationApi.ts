import type { ConversationSummary, ConversationMessage, ConversationMessageMetadata } from '../types';

const API_URL = 'http://localhost:3000/api';

export interface ConversationDetailResponse {
  conversation: ConversationSummary;
  messages: ConversationMessage[];
}

export const fetchRecentConversations = async (
  workspaceId: string,
  limit = 5,
): Promise<ConversationSummary[]> => {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/conversations?limit=${limit}`);
  if (!response.ok) {
    throw new Error('Failed to fetch conversations');
  }
  return response.json();
};

export const createConversation = async (
  workspaceId: string,
  persona: string,
): Promise<ConversationSummary> => {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/conversations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ persona }),
  });

  if (!response.ok) {
    throw new Error('Failed to create conversation');
  }

  return response.json();
};

export const fetchConversationDetail = async (
  conversationId: string,
): Promise<ConversationDetailResponse> => {
  const response = await fetch(`${API_URL}/conversations/${conversationId}`);
  if (!response.ok) {
    throw new Error('Failed to load conversation');
  }
  return response.json();
};

export const appendMessage = async (
  conversationId: string,
  sender: 'user' | 'agent',
  text: string,
  options?: { turnId?: string; replaceExisting?: boolean; metadata?: ConversationMessageMetadata },
): Promise<ConversationMessage> => {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sender, text, ...options }),
  });

  if (!response.ok) {
    throw new Error('Failed to append message');
  }

  return response.json();
};

export const deleteConversation = async (conversationId: string): Promise<void> => {
  const response = await fetch(`${API_URL}/conversations/${conversationId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error('Failed to delete conversation');
  }
};

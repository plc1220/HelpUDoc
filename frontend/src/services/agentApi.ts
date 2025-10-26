const API_URL = 'http://localhost:3000/api';

export const runAgent = async (persona: string, prompt: string) => {
  const response = await fetch(`${API_URL}/agent/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ persona, prompt }),
  });

  if (!response.ok) {
    throw new Error('Failed to run agent');
  }

  return response.json();
};
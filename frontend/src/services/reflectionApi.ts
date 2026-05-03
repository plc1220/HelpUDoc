import type { DailyReflection, ReflectionTrendPoint } from '../types';
import { apiFetch, API_URL } from './apiClient';

export async function getDailyReflection(date?: string): Promise<DailyReflection | null> {
  const params = new URLSearchParams();
  if (date) {
    params.set('date', date);
  }
  const url = `${API_URL}/settings/reflections/daily${params.toString() ? `?${params.toString()}` : ''}`;
  const response = await apiFetch(url);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error('Failed to load daily reflection');
  }
  return response.json();
}

export async function getReflectionTrends(days = 14): Promise<ReflectionTrendPoint[]> {
  const response = await apiFetch(`${API_URL}/settings/reflections/trends?days=${encodeURIComponent(String(days))}`);
  if (!response.ok) {
    throw new Error('Failed to load reflection trends');
  }
  return response.json();
}

export async function generateReflection(date?: string): Promise<DailyReflection> {
  const response = await apiFetch(`${API_URL}/settings/reflections/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(date ? { date } : {}),
  });
  if (!response.ok) {
    throw new Error('Failed to generate reflection');
  }
  return response.json();
}

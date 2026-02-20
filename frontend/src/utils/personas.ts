import type { AgentPersona } from '../types';

export const DEFAULT_PERSONA_NAME = 'fast';
export const DEFAULT_PERSONAS: AgentPersona[] = [
  {
    name: 'fast',
    displayName: 'Fast',
    description: 'Gemini 3 Flash (Preview)',
  },
  {
    name: 'pro',
    displayName: 'Pro',
    description: 'Gemini 3 Pro (Preview)',
  },
];

export const normalizePersonaName = (name: string): string => {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_PERSONA_NAME;
  }
  if (normalized === 'general-assistant') {
    return 'fast';
  }
  return normalized;
};

export const normalizePersonas = (personas: AgentPersona[]): AgentPersona[] => {
  const normalized = new Map<string, AgentPersona>();
  const defaults = new Map(DEFAULT_PERSONAS.map((persona) => [persona.name, persona]));

  personas.forEach((persona) => {
    const name = normalizePersonaName(persona.name);
    if (name !== 'fast' && name !== 'pro') {
      return;
    }
    const fallback = defaults.get(name);
    normalized.set(name, {
      ...fallback,
      ...persona,
      name,
      displayName: persona.displayName || fallback?.displayName || name,
    });
  });

  DEFAULT_PERSONAS.forEach((persona) => {
    if (!normalized.has(persona.name)) {
      normalized.set(persona.name, persona);
    }
  });

  return DEFAULT_PERSONAS.map((persona) => normalized.get(persona.name) || persona);
};

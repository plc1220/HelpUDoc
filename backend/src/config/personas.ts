import { AgentDefinition } from '../core/agent';

export const personas: AgentDefinition[] = [
  {
    name: 'fast',
    displayName: 'Fast',
    description: 'General assistant optimized for speed (Gemini Flash).',
    promptConfig: {},
    modelConfig: {},
    runConfig: {},
    toolConfig: {},
  },
  {
    name: 'pro',
    displayName: 'Pro',
    description: 'General assistant optimized for quality (Gemini Pro).',
    promptConfig: {},
    modelConfig: {},
    runConfig: {},
    toolConfig: {},
  },
];

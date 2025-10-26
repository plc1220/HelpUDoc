import { AgentDefinition } from '../core/agent';

export const personas: AgentDefinition[] = [
  {
    name: 'default',
    displayName: 'Default',
    description: 'A general-purpose assistant.',
    promptConfig: {},
    modelConfig: {},
    runConfig: {},
    toolConfig: {},
  },
  {
    name: 'writer',
    displayName: 'Creative Writer',
    description: 'Helps with writing and brainstorming.',
    promptConfig: {},
    modelConfig: {},
    runConfig: {},
    toolConfig: {},
  },
];
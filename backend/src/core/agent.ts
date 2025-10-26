export interface AgentDefinition {
  name: string;
  displayName: string;
  description: string;
  promptConfig: object;
  modelConfig: object;
  runConfig: object;
  toolConfig: object;
}
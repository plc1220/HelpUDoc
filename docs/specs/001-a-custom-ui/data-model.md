# Data Model: Custom Agent UI and Backend

## Entities

### Workspace
Represents a collection of files and settings for a specific project.

| Field | Type | Description | Validation |
|---|---|---|---|
| `id` | string | Unique identifier for the workspace. | Required, UUID format. |
| `name` | string | The name of the workspace. | Required, unique, max 255 characters. |
| `files` | File[] | A list of files belonging to the workspace. | |
| `createdAt` | datetime | The timestamp when the workspace was created. | |
| `updatedAt` | datetime | The timestamp when the workspace was last updated. | |

### File
Represents a single document within a workspace.

| Field | Type | Description | Validation |
|---|---|---|---|
| `id` | string | Unique identifier for the file. | Required, UUID format. |
| `name` | string | The name of the file. | Required, max 255 characters. |
| `content` | text | The content of the file. | |
| `workspaceId` | string | The ID of the workspace this file belongs to. | Required, foreign key to Workspace. |
| `createdAt` | datetime | The timestamp when the file was created. | |
| `updatedAt` | datetime | The timestamp when the file was last updated. | |

### Agent Persona
Represents a specific configuration for the ReAct agent, aligned with the `AgentDefinition` interface.

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique identifier for the agent persona. |
| `displayName` | string | Human-readable name for the agent persona. |
| `description` | string | A brief description of the agent persona's purpose and capabilities. |
| `promptConfig` | object | System prompts and queries for the agent. |
| `modelConfig` | object | AI model parameters (e.g., temperature, top-p). |
| `runConfig` | object | Execution constraints (e.g., max turns, max time). |
| `toolConfig` | object | The tools available to the agent. |
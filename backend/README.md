# Custom Agent UI Backend

This is the backend for the Custom Agent UI. It is a Node.js application built with Express.

## Getting Started

### Prerequisites

- Node.js 20.x
- npm or yarn

### Installation

1. Navigate to the `backend` directory.
2. Install dependencies: `npm install`

### Running the Application

1. Start the development server: `npm run dev`
2. The API will be available at `http://localhost:3000`.

## API Endpoints

- `POST /api/agent/run`: Runs the agent with a given persona and prompt.
- `GET /api/workspaces`: Lists all workspaces.
- `POST /api/workspaces`: Creates a new workspace.
- `GET /api/workspaces/:workspaceId`: Gets a single workspace.
- `DELETE /api/workspaces/:workspaceId`: Deletes a workspace.
- `GET /api/workspaces/:workspaceId/files`: Lists all files in a workspace.
- `POST /api/workspaces/:workspaceId/files`: Creates a new file in a workspace.
- `PUT /api/workspaces/:workspaceId/files/:fileId`: Updates a file.
- `DELETE /api/workspaces/:workspaceId/files/:fileId`: Deletes a file.
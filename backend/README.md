# Custom Agent UI Backend

This is the backend for the Custom Agent UI. It is a Node.js application built with Express.

## Getting Started

### Prerequisites

- Node.js 20.x
- npm or yarn

### Installation

1. Navigate to the `backend` directory.
2. Install dependencies: `npm install`

### Environment Variables

Copy `.env.example` to `.env` inside the `backend` directory and update the values as needed:

```bash
cp .env.example .env
```

Key variables:

- **PostgreSQL**
  - `DATABASE_URL` or the individual `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`.
  - `DATABASE_SSL` – set to `false` locally, or `true/strict/allow` to toggle TLS when pointing at a managed database.
- **Object storage**
  - `S3_BUCKET_NAME`: Target bucket for binary files (defaults to `helpudoc`).
  - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`: MinIO or AWS credentials.
  - `S3_ENDPOINT`: The MinIO endpoint (e.g., `http://localhost:9000`).
  - `S3_PUBLIC_BASE_URL`: Base URL exposed to the frontend for direct asset links (e.g., `http://localhost:9000/helpudoc`).
- **Identity defaults**
  - `DEFAULT_USER_ID`, `DEFAULT_USER_NAME`, `DEFAULT_USER_EMAIL` (optional) let you emulate a user when the client does not yet send headers.

### Running the Application

1. Start the development server: `npm run dev`
2. The API will be available at `http://localhost:3000`.

### Running MinIO & PostgreSQL Locally

This repository includes `docker-compose.minio.yml` in the project root. It provisions PostgreSQL plus MinIO and automatically creates a public `helpudoc` bucket.

From the repository root run:

```bash
docker compose -f docker-compose.minio.yml up -d
```

By default MinIO listens on:

- API: `http://localhost:9000`
- Console UI: `http://localhost:9001`

Use the same credentials from your `.env` file to sign in to MinIO. PostgreSQL is exposed on `localhost:5432` with matching defaults (`helpudoc/helpudoc`).

### Identity headers

Multi-tenancy is enforced by lightweight identity headers on every `/api` request:

- `X-User-Id` – unique identifier for the signed-in user (email, auth id, etc.)
- `X-User-Name` – optional human-readable display name.
- `X-User-Email` – optional email address.

When these headers are absent the backend falls back to `DEFAULT_USER_*` so local development keeps working.

## Features

- **Multi-tenant workspaces**: Each workspace belongs to a user, with owner/editor/viewer roles managed through collaborator invitations.
- **Agent Interaction**: Core endpoint to interact with a specified agent (enforces workspace access before issuing tool calls).
- **Workspace Management**: Create, list, and share workspaces scoped to the authenticated user.
- **File Management with optimistic locking**: Upload, download, and manage files. Each file tracks an incremental `version` so clients can avoid overwriting each other.
- **Knowledge sources**: CRUD endpoints for text, table, image, presentation, and infographic knowledge entries tied to a workspace.

## API Endpoints

- `POST /api/agent/run`: Runs the agent with a given persona and prompt (must have edit access to the workspace).
- `GET /api/workspaces`: Lists workspaces the caller belongs to.
- `POST /api/workspaces`: Creates a new workspace owned by the caller.
- `GET /api/workspaces/:workspaceId`: Returns workspace metadata plus the caller's membership.
- `DELETE /api/workspaces/:workspaceId`: Deletes a workspace (owners only).
- `GET /api/workspaces/:workspaceId/collaborators`: Lists collaborators for a workspace.
- `POST /api/workspaces/:workspaceId/collaborators`: Adds or promotes a collaborator by external user id.
- `GET /api/workspaces/:workspaceId/files`: Lists all files in a workspace.
- `POST /api/workspaces/:workspaceId/files`: Creates a new file in a workspace.
- `GET /api/workspaces/:workspaceId/files/:fileId/content`: Gets the content of a file.
- `PUT /api/workspaces/:workspaceId/files/:fileId/content`: Updates the content of a file (optionally include `version` to enforce optimistic locking).
- `PATCH /api/workspaces/:workspaceId/files/:fileId`: Renames a file (optionally include `version`).
- `DELETE /api/workspaces/:workspaceId/files/:fileId`: Deletes a file.
- `GET /api/workspaces/:workspaceId/knowledge`: Lists knowledge sources for a workspace.
- `POST /api/workspaces/:workspaceId/knowledge`: Creates a knowledge source (supports `text`, `table`, `image`, `presentation`, `infographic`).
- `GET /api/workspaces/:workspaceId/knowledge/:knowledgeId`: Returns a single knowledge source with attached file metadata.
- `PUT /api/workspaces/:workspaceId/knowledge/:knowledgeId`: Updates a knowledge source.
- `DELETE /api/workspaces/:workspaceId/knowledge/:knowledgeId`: Deletes a knowledge source.

Each file record now includes `storageType`, `mimeType`, `version`, and (for binary assets stored in MinIO) a `publicUrl`. Agents or UI clients can fetch `/api/workspaces/:workspaceId/files` to discover these URLs and embed them directly inside Markdown or HTML.

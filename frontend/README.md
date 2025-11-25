# Frontend API Documentation

This document provides an overview of the API endpoints consumed by the frontend application.

## API Base URL

All API requests are prefixed with `http://localhost:3000/api`.

## Endpoints

### Agent

*   **`POST /agent/run`**
    *   **Description:** Runs the agent with a given persona and prompt.
    *   **Reference:** `specs/001-a-custom-ui/contracts/openapi.yaml`

### Workspaces

*   **`GET /workspaces`**
    *   **Description:** Fetches a list of all workspaces.
    *   **Reference:** `specs/001-a-custom-ui/contracts/openapi.yaml`

*   **`POST /workspaces`**
    *   **Description:** Creates a new workspace.
    *   **Reference:** `specs/001-a-custom-ui/contracts/openapi.yaml`

*   **`DELETE /workspaces/{id}`**
    *   **Description:** Deletes a workspace by its ID.
    *   **Reference:** `specs/001-a-custom-ui/contracts/openapi.yaml`

### Files

*   **`GET /workspaces/{workspaceId}/files`**
    *   **Description:** Fetches a list of files for a given workspace.
    *   **Reference:** `specs/001-a-custom-ui/contracts/openapi.yaml`

*   **`POST /workspaces/{workspaceId}/files`**
    *   **Description:** Creates a new file in a given workspace.
    *   **Reference:** `specs/001-a-custom-ui/contracts/openapi.yaml`

*   **`PUT /files/{id}`**
    *   **Description:** Updates the content of a file by its ID.
    *   **Reference:** `specs/001-a-custom-ui/contracts/openapi.yaml`

*   **`DELETE /files/{id}`**
    *   **Description:** Deletes a file by its ID.
    *   **Reference:** `specs/001-a-custom-ui/contracts/openapi.yaml`

## Notes on file rendering

`FileRenderer.tsx` uses an iframe for `.html` previews. The sandbox now allows `allow-scripts allow-same-origin` so embedded Plotly/Chart.js content can execute while still isolating the preview from the parent page.

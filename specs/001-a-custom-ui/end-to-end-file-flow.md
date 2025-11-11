# End-to-End File Management Flow

This document provides a consolidated view of the entire file lifecycle, from uploading a new file to selecting, editing, and saving it. This diagram reflects the final, correct architecture where the filesystem is the single source of truth for file content.

```mermaid
sequenceDiagram
    participant User
    participant WorkspacePage as Frontend
    participant FileAPI as Frontend API
    participant BackendAPI as Backend API
    participant FileService as Backend Service
    participant Database

    %% File Upload %%
    User->>WorkspacePage: Selects file for upload
    WorkspacePage->>FileAPI: createFile(workspaceId, file)
    FileAPI->>BackendAPI: POST /workspaces/{workspaceId}/files
    BackendAPI->>FileService: createFile(...)
    FileService->>FileService: Creates directory and saves file to local filesystem
    FileService->>Database: INSERT file metadata (name, path, etc.)
    Database-->>FileService: Returns new file metadata
    FileService-->>BackendAPI: Returns new file metadata
    BackendAPI-->>FileAPI: Returns new file metadata
    FileAPI-->>WorkspacePage: Returns new file metadata
    WorkspacePage->>User: Displays new file in list

    %% File Select and Edit %%
    User->>WorkspacePage: Clicks on a file
    WorkspacePage->>FileAPI: getFileContent(workspaceId, fileId)
    FileAPI->>BackendAPI: GET /workspaces/{workspaceId}/files/{fileId}/content
    BackendAPI->>FileService: getFileContent(fileId)
    FileService->>Database: SELECT file metadata by ID
    Database-->>FileService: Returns file metadata (including path)
    FileService->>FileService: Reads file from local filesystem
    FileService-->>BackendAPI: Returns full file content
    BackendAPI-->>FileAPI: Returns full file content
    FileAPI-->>WorkspacePage: Returns full file content
    WorkspacePage->>User: Displays full file content in editor
    User->>WorkspacePage: Edits content in editor

    %% File Save (Update) %%
    User->>WorkspacePage: Clicks "Save"
    WorkspacePage->>FileAPI: updateFileContent(workspaceId, fileId, newContent)
    FileAPI->>BackendAPI: PUT /workspaces/{workspaceId}/files/{fileId}/content
    BackendAPI->>FileService: updateFile(fileId, newContent)
    FileService->>Database: SELECT file metadata by ID
    Database-->>FileService: Returns file metadata (including path)
    FileService->>FileService: Writes new content to local filesystem
    FileService-->>BackendAPI: Returns updated file metadata
    BackendAPI-->>FileAPI: Returns updated file metadata
    FileAPI-->>WorkspacePage: Returns updated file metadata
    WorkspacePage->>User: Shows "Saved" confirmation
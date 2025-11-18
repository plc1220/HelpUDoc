const API_URL = 'http://localhost:3000/api';

export const getFiles = async (workspaceId: string) => {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/files`);
  if (!response.ok) {
    throw new Error('Failed to fetch files');
  }
  return response.json();
};

export const getFileContent = async (workspaceId: string, fileId: string) => {
  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/files/${fileId}/content`);
  if (!response.ok) {
    throw new Error('Failed to fetch file content');
  }
  return response.json();
};

export const createFile = async (workspaceId: string, file: File) => {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_URL}/workspaces/${workspaceId}/files`, {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    throw new Error('Failed to create file');
  }
  return response.json();
};

export const updateFileContent = async (
  workspaceId: string,
  fileId: number,
  content: string,
) => {
  const response = await fetch(
    `${API_URL}/workspaces/${workspaceId}/files/${fileId}/content`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    },
  );
  if (!response.ok) {
    throw new Error('Failed to update file content');
  }
  return response.json();
};

export const deleteFile = async (workspaceId: string, fileId: string) => {
  const response = await fetch(
    `${API_URL}/workspaces/${workspaceId}/files/${fileId}`,
    {
      method: 'DELETE',
    },
  );
  if (!response.ok) {
    throw new Error('Failed to delete file');
  }
};

export const renameFile = async (workspaceId: string, fileId: string, name: string) => {
  const response = await fetch(
    `${API_URL}/workspaces/${workspaceId}/files/${fileId}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    },
  );
  if (!response.ok) {
    throw new Error('Failed to rename file');
  }
  return response.json();
};

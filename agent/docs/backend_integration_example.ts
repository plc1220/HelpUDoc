/**
 * Backend Integration Example for get_image_url Tool
 * 
 * This file demonstrates how to maintain the .workspace_metadata.json file
 * that the get_image_url tool can use to fetch public URLs for uploaded images.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

interface FileMetadata {
    name: string;
    publicUrl: string;
    mimeType: string;
    storageType: 'local' | 's3';
    uploadedAt?: string;
    size?: number;
}

interface WorkspaceMetadata {
    files: FileMetadata[];
    lastUpdated?: string;
}

/**
 * Update the workspace metadata file with new file information
 */
export async function updateWorkspaceMetadata(
    workspacePath: string,
    fileInfo: FileMetadata
): Promise<void> {
    const metadataPath = path.join(workspacePath, '.workspace_metadata.json');

    let metadata: WorkspaceMetadata = { files: [] };

    // Read existing metadata if it exists
    try {
        const content = await fs.readFile(metadataPath, 'utf-8');
        metadata = JSON.parse(content);
    } catch (error) {
        // File doesn't exist yet, use empty metadata
        console.log('Creating new workspace metadata file');
    }

    // Remove any existing entry for this file
    metadata.files = metadata.files.filter(f => f.name !== fileInfo.name);

    // Add the new file info
    metadata.files.push({
        ...fileInfo,
        uploadedAt: new Date().toISOString()
    });

    // Update timestamp
    metadata.lastUpdated = new Date().toISOString();

    // Write back to file
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
}

/**
 * Remove a file from the workspace metadata
 */
export async function removeFromWorkspaceMetadata(
    workspacePath: string,
    fileName: string
): Promise<void> {
    const metadataPath = path.join(workspacePath, '.workspace_metadata.json');

    try {
        const content = await fs.readFile(metadataPath, 'utf-8');
        const metadata: WorkspaceMetadata = JSON.parse(content);

        // Remove the file
        metadata.files = metadata.files.filter(f => f.name !== fileName);
        metadata.lastUpdated = new Date().toISOString();

        // Write back
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    } catch (error) {
        console.error('Error removing file from metadata:', error);
    }
}

/**
 * Example integration in fileService.ts
 */
export class FileServiceExample {
    async createFileWithMetadata(
        workspaceId: string,
        fileName: string,
        fileBuffer: Buffer,
        mimeType: string,
        userId: string,
    ) {
        // ... existing file creation logic ...

        // After uploading to S3 and getting the public URL
        const workspacePath = `/path/to/workspaces/${workspaceId}`;

        // Determine if file should have a public URL
        const isImageOrBinary = this.isImageFile(fileName, mimeType);

        if (isImageOrBinary && publicUrl) {
            // Update workspace metadata
            await updateWorkspaceMetadata(workspacePath, {
                name: fileName,
                publicUrl: publicUrl,
                mimeType: mimeType,
                storageType: 's3',
                size: fileBuffer.length
            });
        } else {
            // File is stored locally
            await updateWorkspaceMetadata(workspacePath, {
                name: fileName,
                publicUrl: '', // No public URL for local files
                mimeType: mimeType,
                storageType: 'local',
                size: fileBuffer.length
            });
        }

        // ... rest of the logic ...
    }

    async deleteFileWithMetadata(fileId: number, userId: string) {
        // ... existing deletion logic ...

        // After deleting the file
        const workspacePath = `/path/to/workspaces/${workspaceId}`;
        await removeFromWorkspaceMetadata(workspacePath, fileName);

        // ... rest of the logic ...
    }

    async renameFileWithMetadata(
        fileId: number,
        newName: string,
        userId: string,
        expectedVersion?: number
    ) {
        // ... existing rename logic ...

        // After renaming
        const workspacePath = `/path/to/workspaces/${workspaceId}`;

        // Remove old entry
        await removeFromWorkspaceMetadata(workspacePath, oldName);

        // Add new entry
        await updateWorkspaceMetadata(workspacePath, {
            name: newName,
            publicUrl: publicUrl,
            mimeType: mimeType,
            storageType: storageType
        });

        // ... rest of the logic ...
    }

    private isImageFile(fileName: string, mimeType: string): boolean {
        const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'];
        const ext = path.extname(fileName).toLowerCase();
        return imageExtensions.includes(ext) || mimeType.startsWith('image/');
    }
}

/**
 * Example usage in the actual fileService.ts
 * 
 * Add this to the createFile method after uploading to S3:
 */
/*
// In fileService.ts, after ensurePublicUrl is called
if (file.publicUrl) {
  const workspacePath = this.workspaceService.getWorkspacePath(workspaceId);
  await updateWorkspaceMetadata(workspacePath, {
    name: fileName,
    publicUrl: file.publicUrl,
    mimeType: file.mimeType,
    storageType: 's3'
  });
}
*/

export const WORKSPACE_IMAGE_DRAG_MIME = 'application/x-helpudoc-workspace-image';
export const EDITOR_IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
export const MAX_EDITOR_IMAGE_BYTES = 10 * 1024 * 1024;

export type WorkspaceImageDrag = { fileId: string; name: string };
const imageTypes = new Set(EDITOR_IMAGE_ACCEPT.split(','));

export const isEditorImageName = (name: string): boolean => /\.(png|jpe?g|gif|webp)$/i.test(name);

export const isWorkspaceImageDrag = (transfer: Pick<DataTransfer, 'types'>): boolean =>
  Array.from(transfer.types).includes(WORKSPACE_IMAGE_DRAG_MIME);

export function readWorkspaceImageDrag(transfer: Pick<DataTransfer, 'getData'>): WorkspaceImageDrag | null {
  try {
    const value: unknown = JSON.parse(transfer.getData(WORKSPACE_IMAGE_DRAG_MIME));
    if (!value || typeof value !== 'object' || !('fileId' in value) || !('name' in value)) return null;
    if (typeof value.fileId !== 'string' || !value.fileId || value.fileId.length > 200
      || typeof value.name !== 'string' || !isEditorImageName(value.name)) return null;
    return { fileId: value.fileId, name: value.name };
  } catch {
    return null;
  }
}

export function validateEditorImage(file: Pick<File, 'type' | 'size'>): void {
  if (!imageTypes.has(file.type.toLowerCase())) {
    throw new Error('Choose a PNG, JPEG, GIF, or WebP image.');
  }
  if (!file.size) throw new Error('This image is empty. Choose another image.');
  if (file.size > MAX_EDITOR_IMAGE_BYTES) throw new Error('Choose an image smaller than 10 MB.');
}

/** Embed the bytes so images remain available when Markdown is downloaded or shared. */
export async function readEditorImageDataUrl(file: File): Promise<string> {
  validateEditorImage(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${file.type};base64,${btoa(binary)}`;
}

/** Read via the current workspace's authenticated API; drag metadata is never a URL. */
export async function loadWorkspaceImage(workspaceId: string, payload: WorkspaceImageDrag): Promise<File> {
  const { getFileContent } = await import('../services/fileApi');
  const stored = await getFileContent(encodeURIComponent(workspaceId), encodeURIComponent(payload.fileId));
  const mime = typeof stored?.mimeType === 'string' ? stored.mimeType.toLowerCase() : '';
  if (!imageTypes.has(mime) || typeof stored?.content !== 'string') {
    throw new Error('This file cannot be inserted as an image. Choose PNG, JPEG, GIF, or WebP.');
  }
  if (stored.content.length > Math.ceil(MAX_EDITOR_IMAGE_BYTES / 3) * 4) {
    throw new Error('Choose an image smaller than 10 MB.');
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(stored.content), char => char.charCodeAt(0));
  } catch {
    throw new Error('This image could not be read. Try uploading it again.');
  }
  const file = new File([bytes], payload.name.split('/').pop() || 'image', { type: mime });
  validateEditorImage(file);
  return file;
}

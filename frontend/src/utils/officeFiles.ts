/** Workspace .docx / .pptx: binary OOXML, preview-only in the web UI. */

export const isWordDocument = (fileName: string): boolean => {
  const n = fileName.trim().toLowerCase();
  return n.endsWith('.docx');
};

export const isPowerPointDocument = (fileName: string): boolean => {
  const n = fileName.trim().toLowerCase();
  return n.endsWith('.pptx');
};

/** Filename or OOXML MIME — workspace treats these as binary, preview-only (no Monaco edit). */
export const isBinaryOfficeDocument = (
  fileName: string,
  mimeType?: string | null,
): boolean => {
  if (isWordDocument(fileName) || isPowerPointDocument(fileName)) return true;
  const m = (mimeType || '').toLowerCase();
  return m.includes('wordprocessingml') || m.includes('presentationml');
};

/**
 * Microsoft Office Online embed requires a publicly reachable **HTTPS** URL.
 * Returns null if the URL cannot be used for embedding.
 */
export const officeOnlineEmbedUrl = (publicUrl: string | null | undefined): string | null => {
  if (!publicUrl || typeof publicUrl !== 'string') return null;
  try {
    const u = new URL(publicUrl.trim());
    if (u.protocol !== 'https:') return null;
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(publicUrl.trim())}`;
  } catch {
    return null;
  }
};

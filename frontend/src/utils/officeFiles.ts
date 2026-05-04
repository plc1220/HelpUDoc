/** Workspace Office documents: binary, preview-only in the web UI. */

const WORD_EXTENSIONS = ['.doc', '.docx', '.docm', '.dot', '.dotx', '.dotm', '.odt'];
const POWERPOINT_EXTENSIONS = ['.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.pot', '.potx', '.odp'];
const SPREADSHEET_EXTENSIONS = ['.xls', '.xlsx', '.xlsm', '.xlsb', '.xlt', '.xltx', '.ods'];

const hasAnyExtension = (fileName: string, extensions: string[]): boolean => {
  const n = fileName.trim().toLowerCase();
  return extensions.some((extension) => n.endsWith(extension));
};

export const isWordDocument = (fileName: string): boolean => {
  return hasAnyExtension(fileName, WORD_EXTENSIONS);
};

export const isPowerPointDocument = (fileName: string): boolean => {
  return hasAnyExtension(fileName, POWERPOINT_EXTENSIONS);
};

export const isSpreadsheetDocument = (fileName: string): boolean => {
  return hasAnyExtension(fileName, SPREADSHEET_EXTENSIONS);
};

export const isOfficeDocument = (fileName: string, mimeType?: string | null): boolean => {
  if (isWordDocument(fileName) || isPowerPointDocument(fileName) || isSpreadsheetDocument(fileName)) {
    return true;
  }
  const m = (mimeType || '').toLowerCase();
  return (
    m.includes('msword') ||
    m.includes('ms-excel') ||
    m.includes('ms-powerpoint') ||
    m.includes('officedocument') ||
    m.includes('opendocument') ||
    m.includes('wordprocessingml') ||
    m.includes('presentationml') ||
    m.includes('spreadsheetml')
  );
};

/** Filename or Office MIME — workspace treats these as binary, preview-only (no Monaco edit). */
export const isBinaryOfficeDocument = (
  fileName: string,
  mimeType?: string | null,
): boolean => {
  return isOfficeDocument(fileName, mimeType);
};

export const getOfficeDocumentKind = (
  fileName: string,
  mimeType?: string | null,
): 'Word' | 'PowerPoint' | 'Spreadsheet' | 'Office' => {
  const m = (mimeType || '').toLowerCase();
  if (isWordDocument(fileName) || m.includes('msword') || m.includes('wordprocessingml')) {
    return 'Word';
  }
  if (isPowerPointDocument(fileName) || m.includes('ms-powerpoint') || m.includes('presentationml')) {
    return 'PowerPoint';
  }
  if (isSpreadsheetDocument(fileName) || m.includes('ms-excel') || m.includes('spreadsheetml')) {
    return 'Spreadsheet';
  }
  return 'Office';
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

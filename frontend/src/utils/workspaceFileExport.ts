export const MARKDOWN_FILE_EXTENSIONS = ['.md'];
export const HTML_FILE_EXTENSIONS = ['.html', '.htm'];

/**
 * Where the canvas Download button gets its bytes.
 *
 * - `canvas`: the text the canvas holds. Markdown and HTML only, so a draft or
 *   an unsaved edit downloads as shown.
 * - `stored`: the original from the object store. Every other type, because the
 *   preview of an Office file is a lossy rendering and cannot be saved back.
 */
export type WorkspaceFileDownloadSource = 'canvas' | 'stored';

export type WorkspaceFileExportActions = {
  canPrint: boolean;
  downloadSource: WorkspaceFileDownloadSource | null;
};

const hasExtension = (fileName: string, extensions: string[]) => {
  const normalized = fileName.trim().toLowerCase();
  return extensions.some((extension) => normalized.endsWith(extension));
};

export const resolveWorkspaceFileExportActions = ({
  fileName,
  isDraft,
}: {
  fileName: string | null | undefined;
  isDraft: boolean;
}): WorkspaceFileExportActions => {
  if (!fileName) {
    return { canPrint: false, downloadSource: null };
  }
  if (hasExtension(fileName, MARKDOWN_FILE_EXTENSIONS) || hasExtension(fileName, HTML_FILE_EXTENSIONS)) {
    return { canPrint: true, downloadSource: 'canvas' };
  }
  // A draft has no stored object yet, so there is nothing to fetch.
  return { canPrint: false, downloadSource: isDraft ? null : 'stored' };
};

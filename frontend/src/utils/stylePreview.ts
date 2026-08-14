export type StylePreviewSource = {
  html?: string;
  path?: string;
};

export const resolveStylePreviewSource = (
  preview: StylePreviewSource | undefined,
  pathToUrl: (sourcePath: string) => string | undefined,
): { html?: string; url?: string } => {
  const sourcePath = String(preview?.path || '').trim();
  const url = sourcePath ? pathToUrl(sourcePath) : undefined;
  if (url) {
    return { url };
  }

  const html = String(preview?.html || '').trim();
  return html ? { html } : {};
};

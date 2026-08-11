export type StylePreviewSource = {
  html?: string;
  path?: string;
};

export const resolveStylePreviewSource = (
  preview: StylePreviewSource | undefined,
  pathToUrl: (sourcePath: string) => string | undefined,
): { html?: string; url?: string } => {
  const html = String(preview?.html || '').trim();
  if (html) {
    return { html };
  }

  const sourcePath = String(preview?.path || '').trim();
  const url = sourcePath ? pathToUrl(sourcePath) : undefined;
  return url ? { url } : {};
};

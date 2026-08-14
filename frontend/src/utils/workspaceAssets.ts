export const normalizeWorkspaceRelativePath = (rawPath: string) => (
  String(rawPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
);

export const isExternalAssetSource = (src: string) => /^(?:https?:|data:|blob:|javascript:|#)/i.test(src.trim());

export const resolveWorkspaceAssetPath = (assetPath: string, sourcePath?: string): string => {
  const normalizedAsset = normalizeWorkspaceRelativePath(assetPath);
  if (!normalizedAsset || assetPath.trim().startsWith('/')) {
    return normalizedAsset;
  }
  const normalizedSource = normalizeWorkspaceRelativePath(sourcePath || '');
  const sourceDirectory = normalizedSource.includes('/')
    ? normalizedSource.slice(0, normalizedSource.lastIndexOf('/'))
    : '';
  const segments = `${sourceDirectory}/${normalizedAsset}`.split('/');
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join('/');
};


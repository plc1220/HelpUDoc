import { isExternalAssetSource, resolveWorkspaceAssetPath } from './workspaceAssets.ts';

type WorkspacePreviewPayload = {
  content?: unknown;
  encoding?: unknown;
  mimeType?: unknown;
};

// Generated decks often restore editor state during startup. Opaque-origin frames
// cannot access browser storage; give each render private, non-persistent storage
// instead of weakening the sandbox or exposing the application's credentials.
export const withPreviewStorage = (html: string): string => {
  const bootstrap = `<script data-preview-storage>(function(){
    for (const name of ['localStorage','sessionStorage']) {
      const values = new Map();
      const storage = {
        get length(){return values.size;},
        key(index){return Array.from(values.keys())[index] ?? null;},
        getItem(key){return values.get(String(key)) ?? null;},
        setItem(key,value){values.set(String(key),String(value));},
        removeItem(key){values.delete(String(key));},
        clear(){values.clear();}
      };
      Object.defineProperty(window,name,{value:storage,configurable:true});
    }
  })();</script>`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, match => match + bootstrap);
  if (/<!doctype[^>]*>/i.test(html)) return html.replace(/<!doctype[^>]*>/i, match => match + bootstrap);
  return bootstrap + html;
};

export const previewPayloadToHtml = (payload: WorkspacePreviewPayload): string => {
  if (typeof payload.content !== 'string') {
    return '';
  }
  if (payload.encoding === 'base64') {
    try {
      return decodeURIComponent(Array.from(atob(payload.content), (character) => (
        `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`
      )).join(''));
    } catch {
      return '';
    }
  }
  return payload.content;
};

const previewPayloadToDataUrl = (payload: WorkspacePreviewPayload): string => {
  if (typeof payload.content !== 'string' || !payload.content) return '';
  const mimeType = typeof payload.mimeType === 'string' && payload.mimeType
    ? payload.mimeType
    : 'application/octet-stream';
  if (payload.encoding === 'base64') {
    return `data:${mimeType};base64,${payload.content}`;
  }
  return `data:${mimeType};charset=utf-8,${encodeURIComponent(payload.content)}`;
};

const replaceAsync = async (
  value: string,
  pattern: RegExp,
  replacer: (...match: string[]) => Promise<string>,
): Promise<string> => {
  const matches = Array.from(value.matchAll(pattern));
  if (!matches.length) return value;
  const replacements = await Promise.all(matches.map((match) => replacer(...match)));
  let cursor = 0;
  return matches.map((match, index) => {
    const prefix = value.slice(cursor, match.index);
    cursor = (match.index || 0) + match[0].length;
    return prefix + replacements[index];
  }).join('') + value.slice(cursor);
};

export const hydrateWorkspaceHtmlAssets = async (
  html: string,
  sourcePath: string,
  loadPreview: (path: string) => Promise<WorkspacePreviewPayload>,
): Promise<string> => {
  const cache = new Map<string, Promise<string>>();
  const resolveAsset = (rawSource: string) => {
    const source = rawSource.trim();
    if (!source || isExternalAssetSource(source)) return Promise.resolve(rawSource);
    const assetPath = resolveWorkspaceAssetPath(source, sourcePath);
    if (!assetPath) return Promise.resolve(rawSource);
    if (!cache.has(assetPath)) {
      cache.set(assetPath, loadPreview(assetPath).then(previewPayloadToDataUrl).catch(() => rawSource));
    }
    return cache.get(assetPath)!;
  };

  const withElementSources = await replaceAsync(
    html,
    /\b(src|poster)\s*=\s*(["'])(.*?)\2/gi,
    async (_full, attribute, quote, source) => `${attribute}=${quote}${await resolveAsset(source)}${quote}`,
  );
  return replaceAsync(
    withElementSources,
    /url\(\s*(["']?)(.*?)\1\s*\)/gi,
    async (_full, quote, source) => `url(${quote}${await resolveAsset(source)}${quote})`,
  );
};

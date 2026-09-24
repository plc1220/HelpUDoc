import { defaultUrlTransform, type UrlTransform } from 'react-markdown';

const MAX_EMBEDDED_IMAGE_BYTES = 10 * 1024 * 1024;

/** Allow portable editor images without enabling arbitrary data: documents. */
export function isEmbeddedRasterImageUrl(url: string): boolean {
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
  if (!match) return false;
  const [, mime, content] = match;
  if (content.length % 4 !== 0) return false;
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  if ((content.length / 4) * 3 - padding > MAX_EMBEDDED_IMAGE_BYTES) return false;
  let header: string;
  try { header = atob(content.slice(0, 16)); } catch { return false; }
  switch (mime.toLowerCase()) {
    case 'png': return header.startsWith('\x89PNG\r\n\x1a\n');
    case 'jpeg': return header.startsWith('\xff\xd8\xff');
    case 'gif': return header.startsWith('GIF87a') || header.startsWith('GIF89a');
    case 'webp': return header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
    default: return false;
  }
}

export const safeMarkdownUrlTransform: UrlTransform = (url, key, node) => (
  key === 'src' && node.tagName === 'img' && isEmbeddedRasterImageUrl(url)
    ? url
    : defaultUrlTransform(url)
);

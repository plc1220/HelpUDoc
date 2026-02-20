import {
  Description as MarkdownIcon,
  Code as HtmlIcon,
  PictureAsPdf as PdfIcon,
  Image as ImageIcon,
} from '@mui/icons-material';
import { FileIcon } from 'lucide-react';

import { SYSTEM_DIR_NAMES, SYSTEM_FILE_NAMES } from '../constants/workspace';
import type { File as WorkspaceFile } from '../types';

const TEXT_PREVIEW_EXTENSIONS = new Set([
  '.md',
  '.mermaid',
  '.txt',
  '.json',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.svg',
  '.csv',
]);

export const normalizeFilePath = (value: string) => value.replace(/\\/g, '/');

export const getFileDisplayName = (value: string) => {
  if (!value) {
    return '';
  }
  const normalized = normalizeFilePath(value);
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
};

export const getFileTypeIcon = (value: string) => {
  const normalized = getFileDisplayName(value).toLowerCase();
  const sharedClass = 'text-slate-400 opacity-70';
  if (normalized.endsWith('.md') || normalized.endsWith('.markdown')) {
    return <MarkdownIcon className={sharedClass} fontSize="small" />;
  }
  if (normalized.endsWith('.html') || normalized.endsWith('.htm')) {
    return <HtmlIcon className={sharedClass} fontSize="small" />;
  }
  if (normalized.endsWith('.pdf')) {
    return <PdfIcon className={sharedClass} fontSize="small" />;
  }
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
    return <ImageIcon className={sharedClass} fontSize="small" />;
  }
  if (['.png', '.gif', '.bmp', '.webp', '.svg'].some((ext) => normalized.endsWith(ext))) {
    return <ImageIcon className={sharedClass} fontSize="small" />;
  }
  return <FileIcon size={16} className={sharedClass} />;
};

export const isSystemFile = (file: WorkspaceFile): boolean => {
  const name = normalizeFilePath(file.name || '');
  if (!name) {
    return false;
  }
  const lowerName = name.toLowerCase();
  const parts = lowerName.split('/');
  const baseName = parts[parts.length - 1] || '';
  if (SYSTEM_FILE_NAMES.has(baseName)) {
    return true;
  }
  for (const part of parts) {
    if (!part) {
      continue;
    }
    if (SYSTEM_DIR_NAMES.has(part)) {
      return true;
    }
    if (part.startsWith('.')) {
      return true;
    }
  }
  return false;
};

export const inferPreviewEncoding = (fileName: string, mimeType?: string | null): 'text' | 'base64' => {
  const normalizedMime = (mimeType || '').toLowerCase();
  if (
    normalizedMime.startsWith('text/') ||
    normalizedMime.includes('json') ||
    normalizedMime.includes('javascript') ||
    normalizedMime.includes('typescript') ||
    normalizedMime.includes('markdown') ||
    normalizedMime.includes('html') ||
    normalizedMime.includes('xml')
  ) {
    return 'text';
  }
  const extIndex = fileName.lastIndexOf('.');
  const ext = extIndex >= 0 ? fileName.slice(extIndex).toLowerCase() : '';
  return TEXT_PREVIEW_EXTENSIONS.has(ext) ? 'text' : 'base64';
};

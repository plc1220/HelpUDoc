import {
  Article as DocumentIcon,
  Archive as ArchiveIcon,
  AudioFile as AudioIcon,
  Code as CodeIcon,
  Description as MarkdownIcon,
  Folder as FolderIcon,
  Code as HtmlIcon,
  InsertChartOutlined as ChartIcon,
  InsertDriveFile as GenericFileIcon,
  Movie as VideoIcon,
  PictureAsPdf as PdfIcon,
  Image as ImageIcon,
  Slideshow as PresentationIcon,
  Storage as DataIcon,
  TableChart as SpreadsheetIcon,
} from '@mui/icons-material';

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

export const isExtractedAssetFilePath = (value: string): boolean => {
  const normalized = normalizeFilePath(value || '').replace(/^\/+/, '').toLowerCase();
  return normalized.startsWith('.system/extracted-assets/');
};

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
  const muiIconProps = { className: sharedClass, fontSize: 'small' as const };
  if (!normalized.includes('.')) {
    return <FolderIcon {...muiIconProps} />;
  }
  if (normalized.endsWith('.md') || normalized.endsWith('.markdown')) {
    return <MarkdownIcon {...muiIconProps} />;
  }
  if (normalized.endsWith('.html') || normalized.endsWith('.htm')) {
    return <HtmlIcon {...muiIconProps} />;
  }
  if (normalized.endsWith('.pdf')) {
    return <PdfIcon {...muiIconProps} />;
  }
  if (['.doc', '.docx', '.docm', '.dot', '.dotx', '.odt', '.rtf'].some((ext) => normalized.endsWith(ext))) {
    return <DocumentIcon {...muiIconProps} />;
  }
  if (['.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.pot', '.potx', '.odp'].some((ext) => normalized.endsWith(ext))) {
    return <PresentationIcon {...muiIconProps} />;
  }
  if (['.xls', '.xlsx', '.xlsm', '.xlsb', '.xlt', '.xltx', '.ods'].some((ext) => normalized.endsWith(ext))) {
    return <SpreadsheetIcon {...muiIconProps} />;
  }
  if (['.csv', '.tsv'].some((ext) => normalized.endsWith(ext))) {
    return <SpreadsheetIcon {...muiIconProps} />;
  }
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
    return <ImageIcon {...muiIconProps} />;
  }
  if (['.png', '.gif', '.bmp', '.webp', '.svg'].some((ext) => normalized.endsWith(ext))) {
    return <ImageIcon {...muiIconProps} />;
  }
  if (normalized.endsWith('.plotly.json') || normalized.endsWith('.plot.json') || normalized.endsWith('.chart.json')) {
    return <ChartIcon {...muiIconProps} />;
  }
  if (['.json', '.jsonl', '.yaml', '.yml', '.xml', '.parquet', '.pq', '.sqlite', '.db'].some((ext) => normalized.endsWith(ext))) {
    return <DataIcon {...muiIconProps} />;
  }
  if (['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z'].some((ext) => normalized.endsWith(ext))) {
    return <ArchiveIcon {...muiIconProps} />;
  }
  if (['.mp4', '.mov', '.webm', '.mkv'].some((ext) => normalized.endsWith(ext))) {
    return <VideoIcon {...muiIconProps} />;
  }
  if (['.mp3', '.wav', '.m4a', '.flac', '.ogg'].some((ext) => normalized.endsWith(ext))) {
    return <AudioIcon {...muiIconProps} />;
  }
  if (
    [
      '.py',
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.css',
      '.scss',
      '.sql',
      '.sh',
      '.bash',
      '.zsh',
      '.ps1',
      '.go',
      '.rs',
      '.java',
      '.kt',
      '.php',
      '.rb',
      '.r',
      '.lua',
      '.toml',
      '.env',
    ].some((ext) => normalized.endsWith(ext))
  ) {
    return <CodeIcon {...muiIconProps} />;
  }
  return <GenericFileIcon {...muiIconProps} />;
};

export const isSystemFile = (file: WorkspaceFile): boolean => {
  const name = normalizeFilePath(file.name || '');
  if (!name) {
    return false;
  }
  if (isExtractedAssetFilePath(name)) {
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

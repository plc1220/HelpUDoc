import {
  Braces,
  Code2,
  FileCode2,
  FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

const FILE_EXTENSION_PATTERN = /\.([a-z0-9]{2,5})$/i;
const WORKSPACE_PATH_PATTERN = /(?:https?:\/\/\S+|\/helpudoc\/[\s\S]*?\.[a-z0-9]{2,5}(?:\?[^\s]*)?)/gi;
const INLINE_PATH_PATTERN = /(?:https?:\/\/\S+|\/helpudoc\/[^\n]+?\.[a-z0-9]{2,5}(?:\?[^\s]*)?)/gi;

export type MessageTextSegment =
  | { type: 'text'; value: string }
  | { type: 'path'; value: string };

export const getPathBasename = (path: string): string => {
  const normalized = path.trim().replace(/[?#].*$/, '');
  const segments = normalized.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] || normalized;
};

export const shortenDisplayName = (name: string, maxLength = 32): string => {
  if (name.length <= maxLength) {
    return name;
  }
  const extensionMatch = name.match(FILE_EXTENSION_PATTERN);
  const extension = extensionMatch?.[0] || '';
  const stem = extension ? name.slice(0, -extension.length) : name;
  const keepStem = Math.max(8, maxLength - extension.length - 1);
  return `${stem.slice(0, keepStem)}…${extension}`;
};

const isWorkspaceFilePath = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return true;
  }
  if (!trimmed.startsWith('/')) {
    return false;
  }
  return FILE_EXTENSION_PATTERN.test(trimmed) || /\/helpudoc\//i.test(trimmed);
};

export const splitMessageTextSegments = (text: string): MessageTextSegment[] => {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (isWorkspaceFilePath(trimmed)) {
    return [{ type: 'path', value: trimmed }];
  }

  const segments: MessageTextSegment[] = [];
  let lastIndex = 0;
  const matches = [...text.matchAll(INLINE_PATH_PATTERN)];
  if (!matches.length) {
    return [{ type: 'text', value: text }];
  }

  matches.forEach((match) => {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, start) });
    }
    segments.push({ type: 'path', value: match[0] });
    lastIndex = start + match[0].length;
  });

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return segments.filter((segment) => segment.value.length > 0);
};

export const getAttachmentTypeLabel = (
  name: string,
  options: { isDrive?: boolean; isImage?: boolean } = {},
): string => {
  if (options.isDrive) {
    return 'Google Drive';
  }
  if (options.isImage) {
    return 'Image';
  }
  const extension = name.includes('.') ? name.split('.').pop()?.toUpperCase() : '';
  return extension || 'File';
};

export const getAttachmentFileIcon = (name: string, isImage: boolean): LucideIcon => {
  if (isImage) {
    return FileImage;
  }
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : '';
  switch (extension) {
    case 'html':
    case 'htm':
    case 'css':
    case 'scss':
      return Code2;
    case 'md':
    case 'markdown':
    case 'txt':
      return FileText;
    case 'json':
    case 'yaml':
    case 'yml':
      return Braces;
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'py':
    case 'go':
    case 'rs':
    case 'java':
    case 'cpp':
    case 'c':
    case 'sh':
      return FileCode2;
    case 'csv':
    case 'xls':
    case 'xlsx':
      return FileSpreadsheet;
    default:
      return FileIcon;
  }
};

export const renderFormattedUserText = (
  text: string,
  pillClassName: string,
): ReactNode => {
  const segments = splitMessageTextSegments(text);
  if (!segments.length) {
    return null;
  }
  if (segments.length === 1 && segments[0].type === 'text') {
    return <p className="whitespace-pre-line leading-relaxed">{segments[0].value}</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 leading-relaxed">
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return (
            <span key={`text-${index}`} className="whitespace-pre-line">
              {segment.value}
            </span>
          );
        }
        const basename = getPathBasename(segment.value);
        const label = shortenDisplayName(basename);
        const Icon = getAttachmentFileIcon(basename, false);
        return (
          <span
            key={`path-${index}`}
            className={pillClassName}
            title={segment.value}
          >
            <Icon size={14} className="shrink-0 opacity-90" aria-hidden />
            <span className="truncate">{label}</span>
          </span>
        );
      })}
    </div>
  );
};

// Re-export pattern for tests
export const pathPatterns = {
  workspace: WORKSPACE_PATH_PATTERN,
  inline: INLINE_PATH_PATTERN,
};

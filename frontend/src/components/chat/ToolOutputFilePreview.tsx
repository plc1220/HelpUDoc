import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { getFiles, getFileContent, getWorkspaceFilePreview } from '../../services/fileApi';
import type { File as WorkspaceFile, ToolOutputFile } from '../../types';
import { inferPreviewEncoding } from '../../utils/files';

type FilePreviewPayload = {
  path: string;
  mimeType?: string | null;
  encoding: 'text' | 'base64';
  content: string;
};

const normalizeWorkspaceRelativePath = (rawPath: string): string => {
  return String(rawPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

export default function ToolOutputFilePreview({
  workspaceId,
  file,
  markdownComponents,
}: {
  workspaceId?: string;
  file: ToolOutputFile;
  markdownComponents?: Record<string, any>;
}) {
  const [preview, setPreview] = useState<FilePreviewPayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const loadPreview = async () => {
      setIsLoading(true);
      setError(null);
      const normalizedPath = normalizeWorkspaceRelativePath(file.path);
      try {
        const data = await getWorkspaceFilePreview(workspaceId, normalizedPath);
        if (!cancelled) {
          setPreview(data);
        }
        return;
      } catch {
        // Fall back to metadata + content APIs.
      }

      try {
        const workspaceFiles: WorkspaceFile[] = await getFiles(workspaceId);
        const matched = workspaceFiles.find((item) => normalizeWorkspaceRelativePath(item.name) === normalizedPath);
        if (!matched) {
          throw new Error('File metadata not found');
        }
        const fetched = await getFileContent(workspaceId, String(matched.id));
        const mimeType = fetched?.mimeType || file.mimeType || null;
        const encoding = inferPreviewEncoding(normalizedPath, mimeType);
        const fallbackPreview: FilePreviewPayload = {
          path: normalizedPath,
          mimeType,
          encoding,
          content: typeof fetched?.content === 'string' ? fetched.content : '',
        };
        if (!cancelled) {
          setPreview(fallbackPreview);
        }
      } catch {
        if (!cancelled) {
          setError('Unable to load preview for this artifact.');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, file.path, file.mimeType]);

  if (!workspaceId) {
    return <p className="text-xs text-gray-500">Select a workspace to preview this file.</p>;
  }
  if (isLoading) {
    return <p className="text-xs text-gray-500">Loading preview...</p>;
  }
  if (error) {
    return <p className="text-xs text-red-500">{error}</p>;
  }
  if (!preview) {
    return null;
  }

  const { mimeType, encoding, content } = preview;
  const normalizedMime = mimeType || '';

  if (normalizedMime.startsWith('image/')) {
    const dataUrl = encoding === 'base64' ? `data:${normalizedMime};base64,${content}` : content;
    return <img src={dataUrl} alt={file.path} className="mt-2 max-w-full rounded border border-gray-200" />;
  }

  if (normalizedMime.includes('pdf')) {
    const dataUrl = encoding === 'base64' ? `data:application/pdf;base64,${content}` : content;
    return (
      <iframe
        title={file.path}
        className="mt-2 h-64 w-full rounded border border-gray-200"
        src={dataUrl}
      />
    );
  }

  if (normalizedMime.includes('html')) {
    return (
      <iframe
        title={file.path}
        className="mt-2 h-64 w-full rounded border border-gray-200"
        srcDoc={content}
        sandbox="allow-scripts allow-same-origin"
      />
    );
  }

  if (normalizedMime.includes('markdown')) {
    return (
      <div className="prose prose-sm mt-2 max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      </div>
    );
  }

  if (normalizedMime.includes('json')) {
    let formatted = content;
    try {
      formatted = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Keep original payload as-is.
    }
    return (
      <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
        {formatted}
      </pre>
    );
  }

  return encoding === 'base64' ? (
    <pre className="mt-2 max-h-64 overflow-auto rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-800">
      Binary file preview not available.
    </pre>
  ) : (
    <pre className="mt-2 max-h-64 overflow-auto rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-800">
      {content}
    </pre>
  );
}

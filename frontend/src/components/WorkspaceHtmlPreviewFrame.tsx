import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { getWorkspaceFilePreview } from '../services/fileApi';
import { hydrateWorkspaceHtmlAssets, previewPayloadToHtml } from '../utils/workspaceHtmlPreview';

export default function WorkspaceHtmlPreviewFrame({
  workspaceId,
  path,
  html,
  title,
  className,
  placeholderClassName,
  sandbox = 'allow-scripts',
}: {
  workspaceId?: string;
  path?: string;
  html?: string;
  title: string;
  className?: string;
  placeholderClassName?: string;
  sandbox?: string;
}) {
  const embeddedHtml = String(html || '').trim();
  const sourcePath = String(path || '').trim();
  const [resolvedHtml, setResolvedHtml] = useState(sourcePath ? '' : embeddedHtml);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    setResolvedHtml('');
    if (!workspaceId) {
      if (embeddedHtml) setResolvedHtml(embeddedHtml);
      else setError('Preview is unavailable.');
      return () => {
        cancelled = true;
      };
    }
    if (!sourcePath && !embeddedHtml) {
      setError('Preview is unavailable.');
      return () => {
        cancelled = true;
      };
    }

    const loadHtml = sourcePath
      ? getWorkspaceFilePreview(workspaceId, sourcePath).then(previewPayloadToHtml)
      : Promise.resolve(embeddedHtml);
    void loadHtml
      .then((rawHtml) => hydrateWorkspaceHtmlAssets(
        rawHtml,
        sourcePath,
        (assetPath) => getWorkspaceFilePreview(workspaceId, assetPath),
      ))
      .then((payload) => {
        if (cancelled) return;
        const nextHtml = payload;
        if (!nextHtml.trim()) {
          setError('Preview content is empty.');
          return;
        }
        setResolvedHtml(nextHtml);
      })
      .catch((caught) => {
        if (cancelled) return;
        if (embeddedHtml) {
          void hydrateWorkspaceHtmlAssets(
            embeddedHtml,
            sourcePath,
            (assetPath) => getWorkspaceFilePreview(workspaceId, assetPath),
          ).then((fallbackHtml) => {
            if (!cancelled) setResolvedHtml(fallbackHtml);
          });
          return;
        }
        setError(caught instanceof Error ? caught.message : 'Preview could not be loaded.');
      });

    return () => {
      cancelled = true;
    };
  }, [embeddedHtml, sourcePath, workspaceId]);

  if (resolvedHtml) {
    return (
      <iframe
        title={title}
        srcDoc={resolvedHtml}
        loading="lazy"
        sandbox={sandbox}
        referrerPolicy="no-referrer"
        className={className}
      />
    );
  }

  return (
    <div className={placeholderClassName || className} role={error ? 'alert' : 'status'}>
      {error ? (
        <span className="px-4 text-center text-xs text-rose-300">{error}</span>
      ) : (
        <Loader2 size={22} className="animate-spin text-slate-400" aria-label="Loading preview" />
      )}
    </div>
  );
}

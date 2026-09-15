import { useEffect, useState, useRef } from 'react';
import { useCanvasAnnotations } from './CanvasAnnotationContext';
import { annotationPreviewBridge } from '../utils/annotationPreviewBridge';
import { Loader2 } from 'lucide-react';

import { getWorkspaceFilePreview } from '../services/fileApi';
import { hydrateWorkspaceHtmlAssets, previewPayloadToHtml, withPreviewStorage } from '../utils/workspaceHtmlPreview';

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
  const annotation = useCanvasAnnotations();
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!annotation) return;
    const sendState = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const token = (name: string, fallback: string) => {
        probe.style.color = `var(${name}, ${fallback})`;
        return getComputedStyle(probe).color;
      };
      frameRef.current?.contentWindow?.postMessage({
        type: 'canvas-annotation-state', active: annotation.active, annotations: annotation.annotations,
        theme: { accent: token('--color-accent', '#262626'), surface: token('--color-background-surface', '#ffffff'), text: token('--color-on-accent', '#ffffff'), focus: token('--color-border-blue', '#2563eb') },
      }, '*');
      probe.remove();
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.data?.type !== 'canvas-annotation') return;
      if (event.data.ready) sendState();
      if (typeof event.data.id === 'string' && annotation.annotations.some(item => item.id === event.data.id)) annotation.open(event.data.id);
      const anchor = event.data.anchor;
      if (annotation.active && anchor && typeof anchor.blockId === 'string' && anchor.blockId.length <= 255 && typeof anchor.anchorText === 'string') {
        annotation.select({ blockId: anchor.blockId, anchorText: anchor.anchorText.slice(0, 4000), anchorFingerprint: typeof anchor.anchorFingerprint === 'string' ? anchor.anchorFingerprint.slice(0, 255) : undefined });
      }
    };
    window.addEventListener('message', receive);
    sendState();
    const observer = new MutationObserver(sendState);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-astryx-theme', 'class', 'style'] });
    return () => { window.removeEventListener('message', receive); observer.disconnect(); };
  }, [annotation]);
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

    const loadHtml = sourcePath && !embeddedHtml
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
          }).catch(() => {
            if (!cancelled) setError('Preview could not be loaded.');
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
        ref={frameRef}
        title={title}
        srcDoc={withPreviewStorage(resolvedHtml) + (annotation ? annotationPreviewBridge : '')}
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

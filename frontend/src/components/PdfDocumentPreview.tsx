import 'pdfjs-dist/web/pdf_viewer.css';
import React, { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import type { File } from '../types';
import { apiFetch } from '../services/apiClient';
import { getFilePreviewUrl } from '../services/fileApi';
import { decodeOfficeBase64 } from '../utils/officeQuickEdit';
import { Button } from '@astryxdesign/core/Button';
const decodeBase64ToArrayBuffer = decodeOfficeBase64;

const pdfWorkerUrl = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
);
// The worker asset is immutable and its content hash does not change when the
// serving headers change. Version the URL so browsers do not reuse a cached
// response with the old, incorrect MIME type.
pdfWorkerUrl.searchParams.set('v', '2');
GlobalWorkerOptions.workerSrc = pdfWorkerUrl.toString();

type PdfDocumentPreviewProps = {
  file: File;
  fileContent: string;
  workspaceId?: string;
  sourceKind?: 'pdf' | 'docx' | 'pptx';
  sourceRevision?: string;
};

const PdfDocumentPreview: React.FC<PdfDocumentPreviewProps> = ({ file, fileContent, workspaceId, sourceKind = 'pdf', sourceRevision }) => {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [viewWidth, setViewWidth] = useState(0);
  const scrollAnchor = useRef<{ page: number; offset: number } | null>(null);

  useEffect(() => {
    const pages = pagesRef.current;
    if (!pages) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setViewWidth(Math.round(pages.clientWidth)), 120);
    });
    observer.observe(pages);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const scrollContainer = pagesRef.current;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    let pdfDocument: PDFDocumentProxy | null = null;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let objectUrl: string | null = null;
    let activeTextLayer: TextLayer | null = null;
    let rendered = false;

    const clearPages = () => {
      if (pagesRef.current) {
        pagesRef.current.replaceChildren();
      }
    };

    const loadAndRender = async () => {
      setStatus('loading');
      setError(null);
      setOpenUrl(null);
      clearPages();

      try {
        let bytes: ArrayBuffer;
        if (workspaceId) {
          const response = await apiFetch(getFilePreviewUrl(workspaceId, file.id));
          if (!response.ok) {
            throw new Error(`Preview request failed (${response.status})`);
          }
          bytes = await response.arrayBuffer();
        } else if (file.publicUrl) {
          const response = await apiFetch(file.publicUrl);
          if (!response.ok) {
            throw new Error(`Preview request failed (${response.status})`);
          }
          bytes = await response.arrayBuffer();
        } else if (fileContent.trim()) {
          bytes = decodeBase64ToArrayBuffer(fileContent);
        } else {
          throw new Error('No PDF data is available for preview.');
        }

        if (cancelled) return;

        objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        setOpenUrl(objectUrl);
        loadingTask = getDocument({ data: new Uint8Array(bytes) });
        pdfDocument = await loadingTask.promise;
        if (cancelled || !pagesRef.current) return;

        const availableWidth = Math.max(pagesRef.current.clientWidth - 32, 320);
        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
          if (cancelled || !pagesRef.current) return;

          const page = await pdfDocument.getPage(pageNumber);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(1.5, availableWidth / baseViewport.width);
          const viewport = page.getViewport({ scale });
          const pageContainer = document.createElement('div');
          pageContainer.className = 'flex justify-center px-4 pb-4 first:pt-4';
          const canvas = document.createElement('canvas');
          canvas.className = 'block h-auto max-w-full bg-white shadow-md';
          const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.floor(viewport.width * pixelRatio);
          canvas.height = Math.floor(viewport.height * pixelRatio);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          const pageSurface = document.createElement('div');
          pageSurface.className = 'relative shrink-0 bg-white';
          pageSurface.style.width = `${viewport.width}px`;
          pageSurface.style.height = `${viewport.height}px`;
          pageSurface.style.setProperty('--scale-factor', String(scale));
          pageSurface.dataset.annotationSurface = `document:${sourceKind}:${sourceKind === 'pptx' ? 'slide' : 'page'}:${pageNumber}`;
          pageSurface.dataset.annotationLabel = `${sourceKind === 'docx' ? 'Word page' : sourceKind === 'pptx' ? 'PowerPoint slide' : 'PDF page'} ${pageNumber}`;
          pageSurface.dataset.annotationRevision = sourceRevision || pdfDocument.fingerprints[0] || '';
          pageSurface.appendChild(canvas);
          pageContainer.appendChild(pageSurface);
          pagesRef.current.appendChild(pageContainer);

          const context = canvas.getContext('2d');
          if (!context) {
            throw new Error(`Unable to create a canvas for page ${pageNumber}.`);
          }
          renderTask = page.render({
            canvasContext: context,
            viewport,
            transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
          });
          await renderTask.promise;
          renderTask = null;
          if (cancelled) return;
          const textContainer = document.createElement('div');
          textContainer.className = 'textLayer';
          pageSurface.appendChild(textContainer);
          try {
            const textContent = await page.getTextContent();
            if (cancelled) return;
            activeTextLayer = new TextLayer({ textContentSource: textContent, container: textContainer, viewport });
            await activeTextLayer.render();
            activeTextLayer = null;
          } catch (textError) {
            if (cancelled) return;
            // Keep the visual page and positional comments available when text cannot be extracted.
            textContainer.remove();
            console.warn(`PDF page ${pageNumber} has no usable text layer`, textError);
          }
        }

        if (!cancelled) {
          const anchor = scrollAnchor.current;
          if (anchor && pagesRef.current) {
            const surfaces = pagesRef.current.querySelectorAll<HTMLElement>('[data-annotation-surface]');
            const selectedPage = surfaces[Math.min(anchor.page, surfaces.length - 1)];
            if (selectedPage) {
              const pageRect = selectedPage.getBoundingClientRect();
              const containerRect = pagesRef.current.getBoundingClientRect();
              const scale = pageRect.height / selectedPage.offsetHeight || 1;
              pagesRef.current.scrollTop += (pageRect.top - containerRect.top) / scale + selectedPage.offsetHeight * anchor.offset;
            }
          }
          rendered = true;
          setStatus('ready');
        }
      } catch (cause) {
        if (cancelled) return;
        console.error('PDF preview error', cause);
        setStatus('error');
        setError(cause instanceof Error ? cause.message : 'Unable to render this PDF.');
      }
    };

    void loadAndRender();

    return () => {
      cancelled = true;
      if (rendered && scrollContainer?.isConnected) {
        const top = scrollContainer.getBoundingClientRect().top;
        const surfaces = Array.from(scrollContainer.querySelectorAll<HTMLElement>('[data-annotation-surface]'));
        const index = surfaces.findIndex(surface => surface.getBoundingClientRect().bottom > top);
        if (index >= 0) {
          const rect = surfaces[index].getBoundingClientRect();
          scrollAnchor.current = { page: index, offset: Math.max(0, (top - rect.top) / rect.height) };
        }
      }
      renderTask?.cancel();
      activeTextLayer?.cancel();
      void loadingTask?.destroy();
      void pdfDocument?.destroy();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      clearPages();
    };
  }, [file.id, file.publicUrl, fileContent, retryCount, workspaceId, sourceKind, sourceRevision, viewWidth]);

  const handleOpenNewTab = () => {
    if (openUrl) window.open(openUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="document-pdf-preview relative h-full w-full overflow-hidden">
      <div
        ref={pagesRef}
        className="h-full w-full overflow-auto"
        aria-label={`${file.name} preview`}
      />
      {status === 'loading' && (
        <div className="document-pdf-loading absolute inset-0 flex items-center justify-center text-sm" role="status">
          Loading PDF preview…
        </div>
      )}
      {status === 'error' && (
        <div className="document-pdf-loading absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center" role="alert">
          <p className="text-sm text-red-600">Unable to render this PDF.</p>
          <p className="max-w-md text-xs text-slate-500">{error}</p>
          <Button
            label="Retry preview" variant="secondary" size="sm"
            onClick={() => setRetryCount((count) => count + 1)}
          />
        </div>
      )}
      {status === 'ready' && openUrl && sourceKind === 'pdf' && (
        <div className="document-pdf-open absolute right-3 top-3"><Button
          label="Open in new tab" variant="secondary" size="sm"
          onClick={handleOpenNewTab}
        /></div>
      )}
    </div>
  );
};


export default PdfDocumentPreview;

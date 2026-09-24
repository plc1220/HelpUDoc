import { useEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Text } from '@astryxdesign/core/Text';
import { MessageSquarePlus, RefreshCw, X } from 'lucide-react';
import type { File } from '../types';
import { getOfficePreview, type OfficePreview } from '../services/officeDocumentApi';
import type { AnnotationAnchor } from '../utils/canvasAnnotations';
import { useCanvasAnnotations } from './CanvasAnnotationContext';
import PdfDocumentPreview from './PdfDocumentPreview';

type Selection = { quote: string; anchor: AnnotationAnchor; revision: string };

export default function OfficeDocumentPreview({ file, fileContent, workspaceId }: { file: File; fileContent: string; workspaceId?: string }) {
  const annotations = useCanvasAnnotations();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<OfficePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const kind = /\.pptx$/i.test(file.name) || file.mimeType?.includes('presentationml') ? 'pptx' : 'docx';

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    if (!workspaceId) {
      setError('Open this document in a workspace to load its page preview.'); setLoading(false);
      return () => controller.abort();
    }
    if (!/^\d+$/.test(String(file.id)) && !fileContent) return () => controller.abort();
    void getOfficePreview(workspaceId, { id: file.id, name: file.name }, fileContent, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setPreview(result);
      setSelection(null);
    }).catch(cause => {
      if (!controller.signal.aborted) { setPreview(null); setError(cause instanceof Error ? cause.message : 'Unable to load document preview.'); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, file.id, file.name, file.version, fileContent, reload]);

  useEffect(() => { if (annotations?.active) setSelection(null); }, [annotations?.active]);

  const captureSelection = () => {
    if (loading || annotations?.active || !annotations?.canComment || !preview) return;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) return;
    const range = selected.getRangeAt(0);
    const root = surfaceRef.current;
    if (!root?.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const startElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const page = startElement?.closest<HTMLElement>('[data-annotation-surface]');
    if (!page || !page.contains(range.endContainer)) return;
    const quote = range.toString();
    if (!quote.trim() || quote.length > 4000) return;
    const before = range.cloneRange(); before.selectNodeContents(page); before.setEnd(range.startContainer, range.startOffset);
    setSelection({ quote, revision: preview.revision, anchor: {
      blockId: page.dataset.annotationSurface, anchorText: quote,
      anchorStart: before.toString().length, anchorEnd: before.toString().length + quote.length,
      anchorFingerprint: JSON.stringify({ kind: 'document-text', revision: preview.revision }),
    } });
  };

  return <div className="office-document-preview" aria-label={`${kind === 'docx' ? 'Word' : 'PowerPoint'} document`}>
    <header className="office-preview-toolbar">
      <Text type="label">{kind === 'docx' ? 'Word preview' : 'PowerPoint preview'}</Text>
      <Text type="supporting">{annotations?.canComment ? 'Select text to annotate' : 'Page layout'}</Text>
      <span className="office-toolbar-spacer" />
      <IconButton label="Refresh document preview" icon={<RefreshCw size={14}/>} variant="ghost" size="sm" isDisabled={loading} onClick={() => { setReload(count => count + 1); }} />
    </header>
    {error && <div role="alert" className="office-preview-error"><Text type="supporting">{error}</Text><Button label="Refresh preview" size="sm" variant="ghost" isDisabled={loading} onClick={() => setReload(count => count + 1)} /></div>}
    <div className="office-preview-pages" ref={surfaceRef} onMouseUp={captureSelection} onKeyUp={event => { if (event.key.startsWith('Arrow') || event.key === 'Shift') captureSelection(); }}>
      {preview ? <PdfDocumentPreview file={{ ...file, publicUrl: null }} fileContent={preview.pdf} sourceKind={kind} sourceRevision={preview.revision} />
        : loading ? <div className="office-preview-empty" role="status"><Text type="body">Preparing page preview…</Text></div>
        : <div className="office-preview-empty"><Text type="body">Document preview unavailable</Text><Text type="supporting">Download the original file or retry the preview.</Text></div>}
      {loading && preview && <div className="office-preview-refreshing" role="status"><Text type="body">Refreshing page preview…</Text></div>}
    </div>
    {selection && !annotations?.active && <section className="office-annotation-selection" aria-label="Annotate selection" onKeyDown={event => {
      if (event.key === 'Escape') setSelection(null);
    }}>
      <div className="office-annotation-heading"><Text type="supporting" maxLines={2}>{selection.quote}</Text><IconButton label="Close annotation selection" icon={<X size={14}/>} variant="ghost" size="sm" onClick={() => setSelection(null)} /></div>
      <Button label="Annotate" icon={<MessageSquarePlus size={14}/>} variant="ghost" size="sm" isDisabled={loading || selection.revision !== preview?.revision} onClick={() => { annotations?.select(selection.anchor); setSelection(null); }} />
    </section>}
  </div>;
}

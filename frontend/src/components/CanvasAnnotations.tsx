import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Text } from '@astryxdesign/core/Text';
import { Card } from '@astryxdesign/core/Card';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { MessageSquarePlus, MessageSquare, ArrowLeft, X, Send, Check } from 'lucide-react';
import type { Workspace } from '../types';
import {
  createWorkspaceCollaborationObject, listWorkspaceCollaborationObjects,
  getWorkspaceCollaborationObject, replyToWorkspaceCollaborationObject, updateWorkspaceCollaborationObject,
  type WorkspaceCollaborationObject, type WorkspaceCollaborationMessage,
} from '../services/workspaceCollaborationApi';
import { annotationThreadsChatPrompt, locateAnnotationText, textRange, documentPin, documentAnchorLabel, type AnnotationAnchor } from '../utils/canvasAnnotations';
import { CanvasAnnotationContext } from './CanvasAnnotationContext';
import './CanvasAnnotations.css';

type Props = { workspace: Workspace | null; filePath?: string; onAgentChat: (prompt: string) => void; children: ReactNode };

export default function CanvasAnnotations(props: Props) {
  // Keep annotation state scoped to the current workspace and file.
  if (!props.workspace || !props.filePath) return <>{props.children}</>;
  return <AnnotationSurface key={`${props.workspace.id}:${props.filePath}`} {...props} workspace={props.workspace} filePath={props.filePath} />;
}

function AnnotationSurface({ workspace, filePath, onAgentChat, children }: Props & { workspace: Workspace; filePath: string }) {
  const openedNotificationRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const agentChatRef = useRef(onAgentChat);
  agentChatRef.current = onAgentChat;
  const [active, setActive] = useState(false);
  const [panel, setPanel] = useState(false);
  const [objects, setObjects] = useState<WorkspaceCollaborationObject[]>([]);
  const [anchor, setAnchor] = useState<AnnotationAnchor | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WorkspaceCollaborationMessage[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [error, setError] = useState('');
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [draftNotice, setDraftNotice] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<Array<{ id: string; x: number; y: number; width: number; height: number; pin?: boolean }>>([]);
  const canComment = ['owner', 'editor', 'contributor', 'commenter'].includes(workspace.role || '');
  const selected = objects.find(item => item.id === selectedId);
  const annotations = useMemo(() => objects.filter(item => item.status !== 'resolved' && item.status !== 'addressed'), [objects]);
  const checkedObjects = objects.filter(item => checkedIds.includes(item.id));

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    const items = await listWorkspaceCollaborationObjects(workspace.id);
    setObjects(items.filter(item => item.type === 'annotation' && item.filePath === filePath));
  }, [workspace.id, filePath]);
  useEffect(() => {
    let alive = true;
    const refresh = () => { if (alive) void load().catch(e => { if (alive) setError(e.message); }); };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [load]);
  useEffect(() => {
    if (!selectedId) { setMessages([]); return; }
    let cancelled = false;
    setLoadingThread(true);
    setMessages([]);
    const refresh = () => void getWorkspaceCollaborationObject(workspace.id, selectedId).then(detail => {
      if (!cancelled) setMessages(detail.messages);
    }).catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoadingThread(false); });
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [workspace.id, selectedId]);
  const select = useCallback((next: AnnotationAnchor) => {
    if (!canComment) return;
    setAnchor(next); setSelectedId(null); setBody(''); setPanel(true); setError('');
  }, [canComment]);
  const open = useCallback((id: string) => {
    setSelectedId(id); setAnchor(null); setBody(''); setPanel(true); setError('');
  }, []);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const id = query.get('annotationId');
    if (id && openedNotificationRef.current !== id && objects.some(item => item.id === id)) { openedNotificationRef.current = id; open(id); }
  }, [objects, open]);
  const context = useMemo(() => ({ active, canComment, annotations, select, open }), [active, canComment, annotations, select, open]);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const paint = () => {
      if (root.querySelector('.monaco-editor')) { setMarks([]); return; }
      const surface = root.querySelector<HTMLElement>('[contenteditable="true"]') || root;
      const bounds = root.getBoundingClientRect();
      const next: typeof marks = [];
      for (const item of annotations) {
        const scopedSurface = item.blockId?.startsWith('document:')
          ? Array.from(root.querySelectorAll<HTMLElement>('[data-annotation-surface]')).find(el => el.dataset.annotationSurface === item.blockId)
          : undefined;
        if (item.blockId && !scopedSurface) continue;
        if (scopedSurface && item.anchorFingerprint) {
          try {
            const fingerprint = JSON.parse(item.anchorFingerprint);
            if (fingerprint.kind === 'document-text' && fingerprint.revision !== scopedSurface.dataset.annotationRevision) continue;
          } catch { /* Older annotations can have a non-JSON fingerprint. */ }
        }
        if (scopedSurface && item.anchorFingerprint?.includes('document-pin')) {
          const pin = documentPin(item, scopedSurface.dataset.annotationRevision || '');
          if (!pin) continue;
          const rect = scopedSurface.getBoundingClientRect();
          next.push({ id: item.id, x: rect.left - bounds.left + rect.width * pin.x, y: rect.top - bounds.top + rect.height * pin.y, width: 24, height: 24, pin: true });
          continue;
        }
        const textSurface = scopedSurface || surface;
        const match = locateAnnotationText(textSurface.textContent || '', item);
        const range = match && textRange(textSurface, ...match);
        if (!range) continue;
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width && rect.height) next.push({ id: item.id, x: rect.left - bounds.left, y: rect.top - bounds.top, width: rect.width, height: rect.height });
        }
      }
      setMarks(next);
    };
    paint();
    const timer = window.setInterval(paint, 700);
    root.addEventListener('scroll', paint, true);
    return () => { window.clearInterval(timer); root.removeEventListener('scroll', paint, true); };
  }, [annotations]);

  const submit = async () => {
    if (!body.trim() || !canComment) return;
    setBusy(true); setError('');
    try {
      if (selected) {
        await replyToWorkspaceCollaborationObject(workspace.id, selected.id, body.trim());
        const detail = await getWorkspaceCollaborationObject(workspace.id, selected.id);
        setMessages(detail.messages);
      } else if (anchor) {
        const created = await createWorkspaceCollaborationObject(workspace.id, {
          type: 'annotation', visibility: workspace.visibility === 'team' ? 'workspace_audience' : 'private', filePath, body: body.trim(), ...anchor,
        });
        setSelectedId(created.id); setAnchor(null);
      }
      setBody(''); await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save comment'); }
    finally { setBusy(false); }
  };
  const resolve = async () => {
    if (!selected) return;
    setBusy(true); setError('');
    try { await updateWorkspaceCollaborationObject(workspace.id, selected.id, { status: selected.status === 'resolved' ? 'open' : 'resolved' }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to update comment'); }
    finally { setBusy(false); }
  };
  const draftThreads = async (ids: string[]) => {
    if (!ids.length || drafting) return;
    setDrafting(true); setError(''); setDraftNotice('');
    try {
      // Fetch every selected thread afresh, including replies. If any request
      // fails, leave the selection intact and never send an incomplete batch.
      const threads = await Promise.all(ids.map(id => getWorkspaceCollaborationObject(workspace.id, id)));
      if (!mountedRef.current) return;
      agentChatRef.current(annotationThreadsChatPrompt(filePath, threads));
      setDraftNotice(`${threads.length === 1 ? 'Comment' : `${threads.length} comments`} added to the agent chat draft. Review it before sending.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to add comments to agent chat'); }
    finally { setDrafting(false); }
  };

  return <CanvasAnnotationContext.Provider value={context}>
    <div className="canvas-annotations" data-testid="annotation-canvas">
      <div className="canvas-annotations-toolbar">
        {canComment && <ToggleButton label="Annotate" icon={<MessageSquarePlus size={14} />} size="sm" isPressed={active} onPressedChange={setActive} />}
        <Button label={`Comments (${annotations.length})`} icon={<MessageSquare size={14} />} variant="ghost" size="sm" onClick={() => setPanel(!panel)} />
        {active && <Text type="supporting" maxLines={1}>Select text or click a page, slide, or HTML element</Text>}
      </div>
      <div className="canvas-annotations-body">
        <div className="canvas-annotations-content">
          <div ref={contentRef} className="h-full" onMouseUp={(event) => {
            if (!active || contentRef.current?.querySelector('.monaco-editor')) return;
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || !selection.rangeCount) {
              const target = event.target instanceof Element ? event.target : null;
              const page = target?.closest<HTMLElement>('[data-annotation-surface]');
              if (!page || target?.closest('button,a,input,textarea')) return;
              const rect = page.getBoundingClientRect();
              if (!rect.width || !rect.height) return;
              select({ blockId: page.dataset.annotationSurface, anchorText: page.dataset.annotationLabel,
                anchorFingerprint: JSON.stringify({ kind: 'document-pin', revision: page.dataset.annotationRevision || '', x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }) });
              return;
            }
            const range = selection.getRangeAt(0);
            const root = contentRef.current;
            if (!root || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
            const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
            const page = element?.closest<HTMLElement>('[data-annotation-surface]');
            const endElement = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
            if (page !== endElement?.closest('[data-annotation-surface]')) { setError('Select text within one page or slide.'); return; }
            const surface = page || root.querySelector<HTMLElement>('[contenteditable="true"]') || root;
            if (!surface.contains(range.startContainer) || !surface.contains(range.endContainer)) return;
            const before = range.cloneRange(); before.selectNodeContents(surface); before.setEnd(range.startContainer, range.startOffset);
            const quote = range.toString().slice(0, 4000);
            if (quote.trim()) select({ blockId: page?.dataset.annotationSurface, anchorText: quote, anchorStart: before.toString().length, anchorEnd: before.toString().length + quote.length,
              ...(page ? { anchorFingerprint: JSON.stringify({ kind: 'document-text', revision: page.dataset.annotationRevision || '' }) } : {}),
            });
          }}>{children}</div>
          <div className="canvas-annotations-marks" aria-label="Comment highlights">
            {marks.map((mark, index) => <button key={`${mark.id}:${index}`} type="button" aria-label="Open annotation" onClick={() => open(mark.id)} className={mark.pin ? "canvas-annotations-pin" : "canvas-annotations-mark"} style={{ left: mark.x, top: mark.y, width: mark.width, height: mark.height }}>{mark.pin ? annotations.findIndex(item => item.id === mark.id) + 1 : null}</button>)}
          </div>
        </div>
        {panel && <aside aria-label="Canvas comments" className="canvas-annotations-panel">
          <header className="canvas-annotations-panel-header">
            <Text type="label">Canvas comments</Text>
            <IconButton label="Close comments" icon={<X size={16}/>} variant="ghost" size="sm" onClick={() => setPanel(false)} />
          </header>
          {error && <div role="alert" className="canvas-annotations-error"><Text type="supporting">{error}</Text></div>}
          {draftNotice && <div role="status"><Text type="supporting">{draftNotice}</Text></div>}
          {anchor || selected ? <>
            <div><Button label="All comments" icon={<ArrowLeft size={14}/>} variant="ghost" size="sm" onClick={() => { setAnchor(null); setSelectedId(null); setBody(''); }} /></div>
            {documentAnchorLabel((anchor || selected)!) && <Text type="supporting">{documentAnchorLabel((anchor || selected)!)}</Text>}
            {selected?.anchorFingerprint && (() => {
              try {
                const fingerprint = JSON.parse(selected.anchorFingerprint);
                const current = contentRef.current?.querySelector<HTMLElement>('[data-annotation-revision]')?.dataset.annotationRevision;
                return current && fingerprint.revision && fingerprint.revision !== current
                  ? <Text type="supporting">This comment refers to an earlier document revision.</Text> : null;
              } catch { return null; }
            })()}
            <Card variant="default" padding={3} className="canvas-annotations-quote">
              <Text type="supporting" display="block">{(anchor || selected)?.anchorText || (anchor || selected)?.blockId || filePath}</Text>
            </Card>
            {selected && <>
              <div className="canvas-annotations-message">
                <Text type="supporting" display="block">{selected.authorName} · {selected.status}</Text>
                <Text type="body" display="block" className="canvas-annotations-message-body">{selected.body}</Text>
              </div>
              {loadingThread && <div role="status"><Text type="supporting">Loading replies…</Text></div>}
              {messages.map(message => <div key={message.id} className="canvas-annotations-reply">
                <Text type="supporting" display="block">{message.authorName}</Text>
                <Text type="body" display="block" className="canvas-annotations-message-body">{message.body}</Text>
              </div>)}
              <div className="canvas-annotations-actions">
                <Button label={drafting ? 'Adding…' : 'Add to agent chat'} icon={<Send size={13}/>} variant="secondary" size="sm" isDisabled={loadingThread || drafting} onClick={() => void draftThreads([selected.id])} />
                {canComment && <Button label={selected.status === 'resolved' ? 'Reopen' : 'Resolve'} icon={<Check size={13}/>} variant="ghost" size="sm" isDisabled={busy} onClick={() => void resolve()} />}
              </div>
            </>}
            {canComment && <form className="canvas-annotations-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
              <TextArea label={selected ? 'Reply to annotation' : 'Annotation comment'} isLabelHidden placeholder={selected ? 'Write a reply…' : 'Leave a comment…'} value={body} maxLength={20000} onChange={setBody} rows={3} size="sm" width="100%" />
              <Text type="supporting" display="block">{workspace.visibility !== 'team' || selected?.visibility === 'private' ? 'Private comment. Only you can see this thread.' : 'Visible to this workspace. Other members will be notified.'}</Text>
              <div className="canvas-annotations-submit"><Button type="submit" label={busy ? 'Saving…' : selected ? 'Reply' : 'Post comment'} variant="primary" size="sm" isDisabled={busy || !body.trim()} /></div>
            </form>}
          </> : <>
            {!objects.length && <Text type="supporting" display="block">No comments on this file yet. Turn on Annotate to select a passage or place a pin.</Text>}
            {!!objects.length && <div className="canvas-annotations-batch">
              <div className="canvas-annotations-batch-selection">
                <CheckboxInput label="Select all comments" value={checkedObjects.length === objects.length ? true : checkedObjects.length ? 'indeterminate' : false} isDisabled={drafting} onChange={checked => { setCheckedIds(checked ? objects.map(item => item.id) : []); setDraftNotice(''); }} />
                <Text type="supporting">{checkedObjects.length} selected</Text>
              </div>
              <Button label={drafting ? 'Adding comments…' : checkedObjects.length ? `Add ${checkedObjects.length} comment${checkedObjects.length === 1 ? '' : 's'} to agent chat` : 'Add comments to agent chat'} icon={<Send size={13}/>} variant="secondary" size="sm" isDisabled={!checkedObjects.length || drafting} onClick={() => void draftThreads(checkedObjects.map(item => item.id))} />
              <Text type="supporting">Add selected comments and replies to one chat draft.</Text>
            </div>}
            {objects.map((item, index) => <div className="canvas-annotations-list-row" key={item.id}>
              <CheckboxInput label={`Select comment ${index + 1}: ${item.body}`} isLabelHidden value={checkedIds.includes(item.id)} isDisabled={drafting} onChange={checked => { setCheckedIds(ids => checked ? [...ids, item.id] : ids.filter(id => id !== item.id)); setDraftNotice(''); }} />
              <ClickableCard label={item.body} padding={3} onClick={() => open(item.id)}>
              <div className="canvas-annotations-card-content">
                <Text type="supporting" display="block">{item.authorName} · {item.status}</Text>
                {!!documentAnchorLabel(item) && <Text type="supporting" display="block">{documentAnchorLabel(item)}</Text>}
                <Text type="body" display="block" maxLines={3}>{item.body}</Text>
                <Text type="supporting" display="block">{item.messageCount} {item.messageCount === 1 ? 'reply' : 'replies'}</Text>
              </div>
              </ClickableCard>
            </div>)}
          </>}
        </aside>}
        {!panel && error && <div role="alert" className="canvas-annotations-toast"><Text type="supporting">{error}</Text></div>}
      </div>
    </div>
  </CanvasAnnotationContext.Provider>;
}

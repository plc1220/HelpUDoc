import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { DocxEditor, useEditorState } from '@docx-editor.dev/react';
import { defaultFonts } from '@docx-editor.dev/fonts';
import type { FontConfigurationFragment } from '@docx-editor.dev/core/editor';
import type { DocumentSource, Editor } from '@docx-editor.dev/core/contracts/editor';
import { Button } from '@astryxdesign/core/Button';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Text } from '@astryxdesign/core/Text';
import { Bold, Italic, Undo2, Redo2 } from 'lucide-react';
import { API_URL, apiFetch } from '../services/apiClient';
import { getAuthUser } from '../auth/authStore';
import type { File } from '../types';
import { useOfficeDocument } from './OfficeDocumentContext';
import '@docx-editor.dev/core/styles/editor.css';
import './native-docx-editor.css';

export type NativeDocxEditorState = { dirty: boolean; saving: boolean; error: string | null };
export type NativeDocxEditorHandle = { save(): Promise<void> };
type Props = { workspaceId: string; file: File; onStateChange?: (state: NativeDocxEditorState) => void };
type Source = { content: string; version: number; revision: string; canEdit: boolean; readOnlyReason: string | null };
type Draft = { materialize: () => Promise<ArrayBuffer>; base: Source };

// Byte snapshots keep unsaved documents through canvas navigation. Serialization is
// debounced during typing and initiated before unmount; using a draft requires a fresh
// access check. The original version stays with it for optimistic concurrency checks.
const drafts = new Map<string, Draft>();
const MAX_DRAFTS = 8;
const nativeFontUrls = new Map(Object.entries(import.meta.glob<string>('../../node_modules/@docx-editor.dev/fonts/assets/*.{ttf,otf}', {
  eager: true, query: '?url', import: 'default',
})).flatMap(([path, url]) => [[path.split('/').at(-1)!, url], [url.split('/').at(-1)!, url]]));
let fontsPromise: Promise<FontConfigurationFragment> | undefined;
window.addEventListener('beforeunload', event => {
  if (drafts.size) { event.preventDefault(); event.returnValue = ''; }
});

async function loadNativeFonts(): Promise<FontConfigurationFragment> {
  const configuration = await defaultFonts({ fetcher: (input, init) => {
    // Vite's development pre-bundler relocates the package's import.meta.url.
    // Resolve only its known assets through Vite's own URLs in dev and production.
    const name = new URL(String(input), window.location.href).pathname.split('/').at(-1)!;
    const asset = nativeFontUrls.get(name);
    if (!asset) return Promise.reject(new Error('Unknown document font asset.'));
    return fetch(asset, init);
  } });
  if (configuration.failures.length) throw new Error('Document fonts could not be loaded. Retry to open with the correct text layout.');
  // The engine uses these bytes for shaping, but 2.19's paint layer still emits the
  // Word family names. Register the same bundled substitutes for browser paint so
  // Cambria text does not measure as Caladea and then display in fallback sans-serif.
  await Promise.all(configuration.substitutions.map(async substitution => {
    const source = configuration.sources.find(face => face.request.family === substitution.to.family
      && face.request.weight === substitution.to.weight && face.request.style === substitution.to.style);
    if (!source) return;
    const font = new FontFace(substitution.from.family, new Uint8Array(source.bytes).buffer, {
      weight: String(substitution.from.weight), style: substitution.from.style,
    });
    await font.load(); document.fonts.add(font);
  }));
  return configuration;
}

function decode(content: string): Uint8Array {
  return Uint8Array.from(atob(content), character => character.charCodeAt(0));
}
function encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 409
    ? 'A newer version is available. Your edits are kept here. Download your copy before loading the latest version.'
    : body.error || 'The document could not be saved. Your edits are kept here.');
  return body as T;
}
function NativeToolbar() {
  const parseError = useEditorState(snapshot => snapshot.parseError);
  return <>
    <DocxEditor.Toolbar preset={false} overflow={false} className="native-docx-toolbar">
      <DocxEditor.Toolbar.Undo icon={<Undo2 size={16} />} />
      <DocxEditor.Toolbar.Redo icon={<Redo2 size={16} />} />
      <DocxEditor.Toolbar.Separator />
      <DocxEditor.Toolbar.StylePicker />
      <DocxEditor.Toolbar.FontSize />
      <DocxEditor.Toolbar.Bold icon={<Bold size={16} />} />
      <DocxEditor.Toolbar.Italic icon={<Italic size={16} />} />
    </DocxEditor.Toolbar>
    {parseError && <div role="alert" className="native-docx-notice">This document could not be opened: {parseError}</div>}
  </>;
}

const NativeDocxEditor = forwardRef<NativeDocxEditorHandle, Props>(function NativeDocxEditor({ workspaceId, file, onStateChange }, ref) {
  const office = useOfficeDocument();
  const officeRef = useRef(office); officeRef.current = office;
  const stateCallback = useRef(onStateChange); stateCallback.current = onStateChange;
  const editorRef = useRef<Editor | null>(null);
  const baseRef = useRef<Source | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const generationRef = useRef(0);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [source, setSource] = useState<DocumentSource>();
  const [fonts, setFonts] = useState<FontConfigurationFragment>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [confirmReload, setConfirmReload] = useState(false);
  const effectiveCanEdit = canEdit && office?.canEdit !== false;
  const user = getAuthUser();
  const cacheKey = `${user?.id || 'anonymous'}:${workspaceId}:${file.id}`;
  const url = `${API_URL}/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(file.id)}/docx-content`;

  useEffect(() => { stateCallback.current?.({ dirty, saving, error }); }, [dirty, saving, error]);
  useLayoutEffect(() => () => {
    clearTimeout(draftTimer.current);
    void drafts.get(cacheKey)?.materialize().catch(() => {});
  }, [cacheKey]);
  useEffect(() => {
    const controller = new AbortController();
    if (dirtyRef.current && baseRef.current && file.version !== undefined && file.version !== baseRef.current.version) {
      setNotice('A newer version is available. Save will check for conflicts; your current edits are kept here.');
      return () => controller.abort();
    }
    if (dirtyRef.current) return () => controller.abort();
    setLoading(true); setError(null);
    fontsPromise ??= loadNativeFonts().catch(cause => { fontsPromise = undefined; throw cause; });
    void Promise.all([apiFetch(url, { signal: controller.signal }).then(responseJson<Source>), fontsPromise]).then(async ([loaded, fontConfig]) => {
      if (controller.signal.aborted) return;
      const draft = drafts.get(cacheKey);
      if (!draft && drafts.size >= MAX_DRAFTS) throw new Error('Save one of your edited documents before opening another editor. Your existing drafts are kept in this tab.');
      const permitted = loaded.canEdit && officeRef.current?.canEdit !== false;
      const restored = permitted ? draft : undefined;
      const bytes = restored ? new Uint8Array(await restored.materialize()) : decode(loaded.content);
      if (controller.signal.aborted) return;
      baseRef.current = restored?.base || loaded;
      dirtyRef.current = !!restored;
      setDirty(!!restored); setCanEdit(permitted); setFonts(fontConfig);
      setSource(bytes);
      setNotice(!permitted ? loaded.readOnlyReason || 'You have read-only access to this document.'
        : restored ? restored.base.revision === loaded.revision ? 'Your unsaved edits have been restored.' : 'Your unsaved edits have been restored. A newer version is available; download your copy before loading it.'
        : null);
    }).catch(cause => {
      if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : 'Unable to open this document.'); setSource(undefined); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cacheKey, url, file.version, reload]);

  const changed = useCallback(() => {
    const editor = editorRef.current;
    const base = baseRef.current;
    if (!editor || !base || !editor.snapshot().editable) return;
    generationRef.current += 1;
    dirtyRef.current = true; setDirty(true);
    let bytes: Promise<ArrayBuffer> | undefined;
    const materialize = () => { bytes ??= editor.save(); return bytes; };
    drafts.set(cacheKey, { materialize, base });
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { void materialize().catch(() => {}); }, 250);
  }, [cacheKey]);

  const save = useCallback(async () => {
    const editor = editorRef.current;
    const base = baseRef.current;
    if (!dirtyRef.current) return;
    if (!editor || !base || !effectiveCanEdit) throw new Error('This document is not ready to save.');
    if (savingRef.current) throw new Error('A save is already in progress.');
    savingRef.current = true; setSaving(true); setError(null);
    const onSaved = officeRef.current?.onSaved;
    const savedDraft = drafts.get(cacheKey);
    const expectedVersion = base.version;
    const expectedRevision = base.revision;
    try {
      const generation = generationRef.current;
      const buffer = await editor.save();
      const content = encode(buffer);
      const result = await responseJson<{ file: File; revision: string }>(await apiFetch(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, version: expectedVersion, revision: expectedRevision }),
      }));
      const nextBase: Source = { ...base, content, version: result.file.version!, revision: result.revision };
      baseRef.current = nextBase;
      const currentDraft = drafts.get(cacheKey);
      if (generation === generationRef.current && currentDraft === savedDraft) {
        dirtyRef.current = false; setDirty(false); drafts.delete(cacheKey);
      } else {
        // A new mount can be editing this same draft while an older request completes.
        // Keep its snapshot and advance its shared base only from the version we saved.
        if (currentDraft && currentDraft.base.version === expectedVersion && currentDraft.base.revision === expectedRevision) Object.assign(currentDraft.base, nextBase);
      }
      setNotice(null);
      onSaved?.(result.file);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to save. Your edits are kept here.';
      setError(message); throw cause;
    } finally { savingRef.current = false; setSaving(false); }
  }, [cacheKey, effectiveCanEdit, url]);
  useImperativeHandle(ref, () => ({ save }), [save]);

  const downloadDraft = async () => {
    try {
      const bytes = await editorRef.current?.save();
      if (!bytes) return;
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
      const link = document.createElement('a'); link.href = objectUrl; link.download = file.name.replace(/\.docx$/i, '-my-edits.docx'); link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to download your edits.'); }
  };

  return <div className="native-docx-editor" aria-label="Word document editor" onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void save().catch(() => {}); }
  }}>
    {(error || notice) && <div className="native-docx-notice" role={error ? 'alert' : 'status'}>
      <Text type="supporting">{error || notice}</Text>
      {dirty && <Button label="Download my edits" size="sm" variant="ghost" onClick={() => { void downloadDraft(); }} />}
      {dirty && <Button label="Load latest version" size="sm" variant="ghost" isDisabled={saving} onClick={() => setConfirmReload(true)} />}
      {!dirty && error && <Button label="Retry" size="sm" variant="ghost" onClick={() => setReload(value => value + 1)} />}
    </div>}
    {loading ? <div className="native-docx-loading" role="status"><Text type="body">Opening Word document…</Text></div>
      : source && fonts ? <DocxEditor.Root document={source} fonts={fonts} mode={effectiveCanEdit && !saving ? 'edit' : 'view'}
        onReady={editor => { editorRef.current = editor; }} onChange={changed}>
        <NativeToolbar />
        <DocxEditor.Viewport className="native-docx-viewport"><DocxEditor.Content /><DocxEditor.FontNotice /></DocxEditor.Viewport>
      </DocxEditor.Root> : null}
    <AlertDialog isOpen={confirmReload} onOpenChange={setConfirmReload} title="Load the latest version?"
      description="This will discard the unsaved edits in this editor. Download your edits first if you want to keep a copy."
      actionLabel="Discard edits and load" cancelLabel="Keep editing" onAction={() => {
        clearTimeout(draftTimer.current); drafts.delete(cacheKey); dirtyRef.current = false; setDirty(false);
        setConfirmReload(false); setNotice(null); setReload(value => value + 1);
      }} />
  </div>;
});

export default NativeDocxEditor;

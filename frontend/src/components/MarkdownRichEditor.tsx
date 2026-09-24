import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  MDXEditor,
  type CodeBlockEditorDescriptor,
  type MDXEditorMethods,
  useCodeBlockEditorContext,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  InsertCodeBlock,
  CodeToggle,
  CreateLink,
  InsertTable,
  ListsToggle,
  Separator,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { MermaidDiagram, useMermaidColorMode } from './markdown/MarkdownShared';
import { prepareMarkdownForRichEditor } from '../utils/markdownEditorSource';
import { isWorkspaceImageDrag, type WorkspaceImageDrag } from '../utils/editorImages';
import { MarkdownImageControls } from './MarkdownImageControls';
import { markdownEditorIcon } from './MarkdownEditorIcons';

const CODE_BLOCK_LANGUAGES: Record<string, string> = {
  '': 'Plain text',
  js: 'JavaScript',
  ts: 'TypeScript',
  jsx: 'JSX',
  tsx: 'TSX',
  json: 'JSON',
  css: 'CSS',
  html: 'HTML',
  md: 'Markdown',
  bash: 'Bash',
  shell: 'Shell',
  python: 'Python',
  sql: 'SQL',
  yaml: 'YAML',
  mermaid: 'Mermaid',
};

type MermaidCodeBlockEditorProps = {
  code: string;
  focusEmitter: { subscribe: (cb: () => void) => void };
};

const MermaidCodeBlockEditor = ({
  code,
  focusEmitter,
}: MermaidCodeBlockEditorProps) => {
  const { lexicalNode, parentEditor, setCode } = useCodeBlockEditorContext();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState(code);
  const mermaidColorMode = useMermaidColorMode();

  useEffect(() => {
    setDraft(code);
  }, [code]);

  useEffect(() => {
    focusEmitter.subscribe(() => {
      textareaRef.current?.focus();
    });
  }, [focusEmitter]);

  return (
    <div className="helpudoc-mermaid-editor not-prose my-4">
      <div className="helpudoc-mermaid-editor-header">
        <div>
          <Text type="label" color="secondary">Mermaid</Text>
          <Text type="supporting" color="secondary">Edit the diagram source and preview it live.</Text>
        </div>
        <Button
          label="Remove Mermaid diagram"
          size="sm"
          variant="secondary"
          onClick={() => {
            parentEditor.update(() => {
              lexicalNode.remove();
            });
          }}
        >
          Remove
        </Button>
      </div>
      <div className="helpudoc-mermaid-editor-body">
        <label className="helpudoc-mermaid-editor-pane">
          <Text type="supporting" color="secondary">Source</Text>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              const nextValue = event.target.value;
              setDraft(nextValue);
              setCode(nextValue);
            }}
            spellCheck={false}
            className="helpudoc-mermaid-source"
          />
        </label>
        <div className="helpudoc-mermaid-editor-pane">
          <Text type="supporting" color="secondary">Preview</Text>
          <MermaidDiagram
            chart={draft}
            colorMode={mermaidColorMode}
            className="helpudoc-mermaid-preview"
            fallbackClassName="h-full min-h-[240px]"
          />
        </div>
      </div>
    </div>
  );
};

const mermaidCodeBlockDescriptor: CodeBlockEditorDescriptor = {
  priority: 100,
  match: (language) => language === 'mermaid',
  Editor: MermaidCodeBlockEditor,
};

export type MarkdownRichEditorHandle = {
  setMarkdown: (value: string) => void;
};

type MarkdownRichEditorProps = {
  markdown: string;
  onChange: (value: string) => void;
  onError?: (error: string) => void;
  onImageUpload: (image: File) => Promise<string>;
  onWorkspaceImageDrop?: (image: WorkspaceImageDrag) => Promise<string>;
  colorMode: 'light' | 'dark';
};

const MarkdownRichEditor = forwardRef<MarkdownRichEditorHandle, MarkdownRichEditorProps>(({
  markdown,
  onChange,
  onError,
  onImageUpload,
  onWorkspaceImageDrop,
  colorMode,
}, ref) => {
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sourceRef = useRef(markdown);
  const errorRef = useRef<string | null>(null);
  const [overlayContainer, setOverlayContainer] = useState<HTMLDivElement | null>(null);
  const [source, setSource] = useState(markdown);
  const [renderMarkdown, setRenderMarkdown] = useState(() => prepareMarkdownForRichEditor(markdown));
  const [sourceMode, setSourceMode] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const [imageStatus, setImageStatus] = useState({ message: '', isError: false });

  const setContainer = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
    setOverlayContainer(element);
  }, []);
  const handleImageStatus = useCallback((message: string, isError = false) => setImageStatus({ message, isError }), []);
  const isFileDrop = (transfer: DataTransfer) => isWorkspaceImageDrag(transfer)
    || Array.from(transfer.types).some(type => type === 'Files' || type === 'application/x-helpudoc-workspace-file-id');

  useImperativeHandle(ref, () => ({
    setMarkdown: (value: string) => {
      if (value === sourceRef.current) return;
      sourceRef.current = value;
      setSource(value);
      const prepared = prepareMarkdownForRichEditor(value);
      setRenderMarkdown(prepared);
      if (!sourceMode) editorRef.current?.setMarkdown(prepared);
    },
  }), [sourceMode]);

  const openRichEditor = () => {
    errorRef.current = null;
    setParseError(null);
    setRenderMarkdown(prepareMarkdownForRichEditor(sourceRef.current));
    setEditorVersion(version => version + 1);
    setSourceMode(false);
  };

  const plugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      tablePlugin(),
      imagePlugin({ disableImageResize: true }),
      codeBlockPlugin({
        codeBlockEditorDescriptors: [mermaidCodeBlockDescriptor],
      }),
      codeMirrorPlugin({
        codeBlockLanguages: CODE_BLOCK_LANGUAGES,
      }),
      markdownShortcutPlugin(),
      toolbarPlugin({
        toolbarContents: () => (
          <>
            <UndoRedo />
            <Separator />
            <BoldItalicUnderlineToggles />
            <CodeToggle />
            <Separator />
            <ListsToggle />
            <Separator />
            <BlockTypeSelect />
            <Separator />
            <CreateLink />
            <MarkdownImageControls containerRef={containerRef} onImageUpload={onImageUpload}
              onWorkspaceImageDrop={onWorkspaceImageDrop} onStatusChange={handleImageStatus} />
            <InsertTable />
            <InsertCodeBlock />
          </>
        ),
      }),
    ],
    [onImageUpload, onWorkspaceImageDrop, handleImageStatus],
  );

  return (
    <div ref={setContainer} className="helpudoc-markdown-editor-shell">
      <div className="helpudoc-markdown-modebar">
        <div className="helpudoc-markdown-modes">
          <Button label="Rich text" size="sm" variant={sourceMode ? 'ghost' : 'secondary'}
            aria-pressed={!sourceMode} onClick={() => { if (sourceMode) openRichEditor(); }}>Write</Button>
          <Button label="Markdown source" size="sm" variant={sourceMode ? 'secondary' : 'ghost'}
            aria-pressed={sourceMode} onClick={() => { setSource(sourceRef.current); setSourceMode(true); }}>Source</Button>
        </div>
        {!sourceMode && <span className="helpudoc-markdown-image-hint">Drag images from Files</span>}
      </div>
      {parseError && <div className="helpudoc-markdown-notice" role="status">
        <p>This Markdown needs source mode. Your content is preserved.</p>
        <details><summary>Formatting details</summary><pre>{parseError}</pre></details>
      </div>}
      {imageStatus.message && <div className="helpudoc-markdown-image-status" role={imageStatus.isError ? 'alert' : 'status'}
        data-error={imageStatus.isError || undefined}>{imageStatus.message}</div>}
      {sourceMode ? <textarea className="helpudoc-markdown-source" aria-label="Markdown source" value={source}
        spellCheck={false}
        onDragOver={event => { if (isFileDrop(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
        onDrop={event => {
          if (!isFileDrop(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          handleImageStatus('Switch to Write to insert an image.', true);
        }}
        onChange={event => {
          const value = event.target.value;
          sourceRef.current = value;
          setSource(value);
          onChange(value);
        }} /> : <MDXEditor
      key={editorVersion}
      ref={editorRef}
      markdown={renderMarkdown}
      overlayContainer={overlayContainer ?? undefined}
      iconComponentFor={markdownEditorIcon}
      className={`mdxeditor helpudoc-mdxeditor flex-1 ${colorMode === 'dark' ? 'helpudoc-mdxeditor-dark' : 'helpudoc-mdxeditor-light'}`}
      contentEditableClassName={`prose max-w-none helpudoc-markdown helpudoc-markdown-editor mdxeditor-root-contenteditable ${
        colorMode === 'dark' ? 'prose-invert helpudoc-markdown-dark' : 'prose-slate helpudoc-markdown-light'
      }`}
      onChange={(value, initialMarkdownNormalize) => {
        // Loading/normalizing the source is not a user edit. In particular, a
        // failed import must never autosave an empty or partially imported tree.
        if (initialMarkdownNormalize || errorRef.current) return;
        sourceRef.current = value;
        onChange(value);
      }}
      onError={({ error }) => {
        errorRef.current = error;
        setParseError(error);
        setSource(sourceRef.current);
        setSourceMode(true);
        onError?.(error);
      }}
      plugins={plugins}
    />}
    </div>
  );
});

MarkdownRichEditor.displayName = 'MarkdownRichEditor';

export default MarkdownRichEditor;

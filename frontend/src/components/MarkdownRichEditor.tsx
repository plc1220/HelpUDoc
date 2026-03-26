import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
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
  InsertImage,
  InsertTable,
  ListsToggle,
  Separator,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { MermaidDiagram, useMermaidColorMode } from './markdown/MarkdownShared';

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
    <div className="helpudoc-mermaid-editor not-prose my-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Mermaid</p>
          <p className="text-xs text-slate-500">Edit the diagram source and preview it live.</p>
        </div>
        <button
          type="button"
          className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
          onClick={() => {
            parentEditor.update(() => {
              lexicalNode.remove();
            });
          }}
        >
          Remove
        </button>
      </div>
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="flex min-h-[260px] flex-col gap-2">
          <span className="text-xs font-medium text-slate-600">Source</span>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              const nextValue = event.target.value;
              setDraft(nextValue);
              setCode(nextValue);
            }}
            spellCheck={false}
            className="min-h-[240px] w-full resize-y rounded-xl border border-slate-200 bg-slate-950 p-4 font-mono text-sm leading-relaxed text-slate-100 focus:border-blue-400 focus:outline-none"
          />
        </label>
        <div className="flex min-h-[260px] flex-col gap-2">
          <span className="text-xs font-medium text-slate-600">Preview</span>
          <MermaidDiagram
            chart={draft}
            colorMode={mermaidColorMode}
            className={`mermaid-container h-full min-h-[240px] overflow-auto rounded-xl border p-4 ${mermaidColorMode === 'dark' ? 'border-slate-700 bg-slate-950' : 'border-slate-200 bg-white'}`}
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
  onError: (error: string) => void;
  onImageUpload: (image: File) => Promise<string>;
};

const MarkdownRichEditor = forwardRef<MarkdownRichEditorHandle, MarkdownRichEditorProps>(({
  markdown,
  onChange,
  onError,
  onImageUpload,
}, ref) => {
  const editorRef = useRef<MDXEditorMethods | null>(null);

  useImperativeHandle(ref, () => ({
    setMarkdown: (value: string) => {
      editorRef.current?.setMarkdown(value);
    },
  }), []);

  const plugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      tablePlugin(),
      imagePlugin({ imageUploadHandler: onImageUpload }),
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
            <InsertImage />
            <InsertTable />
            <InsertCodeBlock />
          </>
        ),
      }),
    ],
    [onImageUpload],
  );

  return (
    <MDXEditor
      ref={editorRef}
      markdown={markdown}
      className="mdxeditor helpudoc-mdxeditor flex-1"
      contentEditableClassName="prose prose-slate max-w-none helpudoc-markdown helpudoc-markdown-editor mdxeditor-root-contenteditable"
      onChange={onChange}
      onError={({ error }) => {
        console.error('MDXEditor markdown processing error:', error);
        onError(error);
      }}
      plugins={plugins}
    />
  );
});

MarkdownRichEditor.displayName = 'MarkdownRichEditor';

export default MarkdownRichEditor;

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
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
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
  onError: (error: string) => void;
  onImageUpload: (image: File) => Promise<string>;
  colorMode: 'light' | 'dark';
};

const MarkdownRichEditor = forwardRef<MarkdownRichEditorHandle, MarkdownRichEditorProps>(({
  markdown,
  onChange,
  onError,
  onImageUpload,
  colorMode,
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
      className={`mdxeditor helpudoc-mdxeditor flex-1 ${colorMode === 'dark' ? 'helpudoc-mdxeditor-dark' : 'helpudoc-mdxeditor-light'}`}
      contentEditableClassName={`prose max-w-none helpudoc-markdown helpudoc-markdown-editor mdxeditor-root-contenteditable ${
        colorMode === 'dark' ? 'prose-invert helpudoc-markdown-dark' : 'prose-slate helpudoc-markdown-light'
      }`}
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

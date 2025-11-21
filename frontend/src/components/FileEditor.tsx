import React, { useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { File } from '../types';
import { editor } from 'monaco-editor';
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  CodeToggle,
  CreateLink,
  InsertImage,
  InsertTable,
  ListsToggle,
  Separator,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';

interface FileEditorProps {
  file: File | null;
  fileContent: string;
  onContentChange: (content: string) => void;
}

const FileEditor: React.FC<FileEditorProps> = ({ file, fileContent, onContentChange }) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  const applyFormat = (format: 'bold' | 'italic' | 'heading') => {
    const editor = editorRef.current;
    if (!editor) return;

    const selection = editor.getSelection();
    if (!selection) return;

    const model = editor.getModel();
    if (!model) return;

    const text = model.getValueInRange(selection);
    let formattedText = '';

    switch (format) {
      case 'bold':
        formattedText = `**${text}**`;
        break;
      case 'italic':
        formattedText = `*${text}*`;
        break;
      case 'heading':
        formattedText = `# ${text}`;
        break;
    }

    editor.executeEdits('toolbar', [
      {
        range: selection,
        text: formattedText,
        forceMoveMarkers: true,
      },
    ]);
  };

  const handleUndo = () => {
    editorRef.current?.trigger('toolbar', 'undo', null);
  };

  const handleRedo = () => {
    editorRef.current?.trigger('toolbar', 'redo', null);
  };

  if (!file) {
    return null;
  }

  const getLanguage = (fileName: string) => {
    const extension = fileName.split('.').pop()?.toLowerCase();
    switch (extension) {
      case 'js':
      case 'jsx':
        return 'javascript';
      case 'ts':
      case 'tsx':
        return 'typescript';
      case 'css':
        return 'css';
      case 'html':
        return 'html';
      case 'json':
        return 'json';
      case 'md':
        return 'markdown';
      case 'py':
        return 'python';
      case 'java':
        return 'java';
      case 'c':
      case 'h':
        return 'c';
      case 'cpp':
      case 'hpp':
      case 'cc':
        return 'cpp';
      case 'go':
        return 'go';
      case 'rs':
        return 'rust';
      case 'php':
        return 'php';
      case 'rb':
        return 'ruby';
      case 'sh':
      case 'bash':
        return 'shell';
      case 'yaml':
      case 'yml':
        return 'yaml';
      case 'xml':
        return 'xml';
      case 'sql':
        return 'sql';
      default:
        return 'plaintext';
    }
  };

  const isMarkdown = getLanguage(file.name) === 'markdown';

  return (
    <div className="h-full flex flex-col">
      {!isMarkdown && (
        <div className="bg-gray-100 p-1 border-b">
          <button onClick={handleUndo} className="px-2 py-1 mr-1 border rounded">Undo</button>
          <button onClick={handleRedo} className="px-2 py-1 mr-1 border rounded">Redo</button>
          <button onClick={() => applyFormat('bold')} className="px-2 py-1 mr-1 border rounded font-bold">B</button>
          <button onClick={() => applyFormat('italic')} className="px-2 py-1 mr-1 border rounded italic">I</button>
          <button onClick={() => applyFormat('heading')} className="px-2 py-1 mr-1 border rounded">H</button>
        </div>
      )}
      <div className="flex-grow overflow-auto">
        {isMarkdown ? (
          <div className="h-full overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
            <MDXEditor
              markdown={fileContent}
              onChange={onContentChange}
              plugins={[
                headingsPlugin(),
                listsPlugin(),
                quotePlugin(),
                thematicBreakPlugin(),
                toolbarPlugin({
                  toolbarContents: () => (
                    <>
                      <UndoRedo />
                      <Separator />
                      <BoldItalicUnderlineToggles />
                      <Separator />
                      <ListsToggle />
                      <Separator />
                      <BlockTypeSelect />
                      <Separator />
                      <CreateLink />
                      <InsertImage />
                      <InsertTable />
                      <Separator />
                      <CodeToggle />
                    </>
                  ),
                }),
              ]}
            />
          </div>
        ) : (
          <Editor
            height="100%"
            language={getLanguage(file.name)}
            value={fileContent}
            onMount={handleEditorDidMount}
            onChange={(value) => onContentChange(value || '')}
            theme="vs"
            options={{
              wordWrap: 'on',
              wrappingIndent: 'indent',
              minimap: { enabled: false },
            }}
          />
        )}
      </div>
    </div>
  );
};

export default FileEditor;
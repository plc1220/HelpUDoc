import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { editor as MonacoEditorNamespace } from 'monaco-editor';
import type { File as WorkspaceFile } from '../types';
import { createFile, getFileContent } from '../services/fileApi';
import { useCanvasAnnotations } from './CanvasAnnotationContext';
import { locateAnnotationText } from '../utils/canvasAnnotations';
import EditorLoadingState from './EditorLoadingState';
import type { MarkdownRichEditorHandle } from './MarkdownRichEditor';
import { isBinaryOfficeDocument } from '../utils/officeFiles';
import type { NativeDocxEditorHandle, NativeDocxEditorState } from './NativeDocxEditor';

const MonacoEditor = lazy(async () => {
  await import('../config/monaco');
  return import('@monaco-editor/react');
});
const MarkdownRichEditor = lazy(() => import('./MarkdownRichEditor'));
const FileRenderer = lazy(() => import('./FileRenderer'));
const NativeDocxEditor = lazy(() => import('./NativeDocxEditor'));

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

interface FileEditorProps {
  file: WorkspaceFile | null;
  fileContent: string;
  onContentChange: (content: string) => void;
  workspaceId: string;
  colorMode: 'light' | 'dark';
  nativeDocxRef?: React.Ref<NativeDocxEditorHandle>;
  onNativeDocxStateChange?: (state: NativeDocxEditorState) => void;
}

const OfficeDocumentPreviewPane: React.FC<{
  file: WorkspaceFile;
  fileContent: string;
  workspaceId: string;
  colorMode: 'light' | 'dark';
}> = ({ file, fileContent, workspaceId, colorMode }) => {
  const isDarkMode = colorMode === 'dark';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={`border-b px-3 py-2 text-xs ${
          isDarkMode
            ? 'border-slate-700/70 bg-slate-950/70 text-slate-300'
            : 'border-amber-100 bg-amber-50 text-amber-950'
        }`}
      >
        Document preview. Use the agent to make changes to this file.
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<EditorLoadingState />}>
          <FileRenderer file={file} fileContent={fileContent} workspaceId={workspaceId} />
        </Suspense>
      </div>
    </div>
  );
};

const WorkspaceFileEditor: React.FC<FileEditorProps> = ({
  file,
  fileContent,
  onContentChange,
  workspaceId,
  colorMode,
}) => {
  const annotation = useCanvasAnnotations();
  const annotationRef = useRef(annotation);
  annotationRef.current = annotation;
  const [mountedEditor, setMountedEditor] = useState<MonacoEditorNamespace.IStandaloneCodeEditor | null>(null);
  const fileId = file?.id ? String(file.id) : null;
  const fileName = file?.name ?? '';
  const editorRef = useRef<MonacoEditorNamespace.IStandaloneCodeEditor | null>(null);
  const mdxEditorRef = useRef<MarkdownRichEditorHandle | null>(null);
  const isApplyingContentRef = useRef(false);
  const [mdxError, setMdxError] = useState<string | null>(null);
  const isDarkMode = colorMode === 'dark';
  const monacoTheme = isDarkMode ? 'helpudoc-nord' : 'vs';

  const handleImageUpload = useCallback(async (image: File) => {
    const created = await createFile(workspaceId, image);
    if (!created?.id) {
      throw new Error('Image upload did not return a file identifier.');
    }
    const stored = await getFileContent(workspaceId, String(created.id));
    if (!stored?.content) {
      throw new Error('Image upload could not be read back.');
    }
    return `data:${stored.mimeType || image.type || 'image/*'};base64,${stored.content}`;
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;

    if (!fileName || getLanguage(fileName) === 'markdown') {
      return undefined;
    }

    void import('monaco-editor').then(({ editor }) => {
      if (cancelled) return;

      if (isDarkMode) {
        editor.defineTheme('helpudoc-nord', {
          base: 'vs-dark',
          inherit: true,
          rules: [
            { token: 'comment', foreground: '4c566a' },
            { token: 'string', foreground: 'a3be8c' },
            { token: 'number', foreground: 'b48ead' },
            { token: 'keyword', foreground: '81a1c1' },
            { token: 'type.identifier', foreground: '8fbcbb' },
            { token: 'delimiter', foreground: 'd8dee9' },
            { token: 'tag', foreground: '81a1c1' },
            { token: 'attribute.name', foreground: '88c0d0' },
            { token: 'attribute.value', foreground: 'a3be8c' },
          ],
          colors: {
            'editor.background': '#2e3440',
            'editor.foreground': '#d8dee9',
            'editorLineNumber.foreground': '#4c566a',
            'editorLineNumber.activeForeground': '#eceff4',
            'editorCursor.foreground': '#d8dee9',
            'editor.selectionBackground': '#434c5e',
            'editor.inactiveSelectionBackground': '#3b4252',
            'editorIndentGuide.background': '#3b4252',
            'editorIndentGuide.activeBackground': '#4c566a',
          },
        });
        editor.setTheme('helpudoc-nord');
        return;
      }

      editor.setTheme('vs');
    });

    return () => {
      cancelled = true;
    };
  }, [fileName, isDarkMode]);

  const handleEditorDidMount = (editorInstance: MonacoEditorNamespace.IStandaloneCodeEditor) => {
    editorRef.current = editorInstance;
    setMountedEditor(editorInstance);
  };

  useEffect(() => {
    if (!mountedEditor) return;
    const subscription = mountedEditor.onMouseUp((event) => {
      const state = annotationRef.current;
      const selection = mountedEditor.getSelection();
      const model = mountedEditor.getModel();
      if (!state || !model) return;
      if (!state.active && event.target.position) {
        const offset = model.getOffsetAt(event.target.position);
        const item = state.annotations.find(item => {
          const match = !item.blockId && locateAnnotationText(model.getValue(), item);
          return match && offset >= match[0] && offset < match[1];
        });
        if (item) state.open(item.id);
        return;
      }
      if (!state.active || !selection || selection.isEmpty()) return;
      const anchorStart = model.getOffsetAt(selection.getStartPosition());
      const anchorText = model.getValueInRange(selection).slice(0, 4000);
      state.select({ anchorText, anchorStart, anchorEnd: anchorStart + anchorText.length });
    });
    const decorations = mountedEditor.createDecorationsCollection();
    const paint = () => {
      const model = mountedEditor.getModel();
      if (!model) return;
      decorations.set((annotationRef.current?.annotations || []).flatMap(item => {
        if (item.blockId) return [];
        const match = locateAnnotationText(model.getValue(), item);
        if (!match) return [];
        const start = model.getPositionAt(match[0]); const end = model.getPositionAt(match[1]);
        return [{ range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, options: { inlineClassName: 'canvas-annotation-highlight', hoverMessage: { value: 'Canvas comment — open Comments to view the thread.' } } }];
      }));
    };
    paint();
    const timer = window.setInterval(paint, 700);
    return () => { subscription.dispose(); decorations.clear(); window.clearInterval(timer); };
  }, [mountedEditor]);

  const handleUndo = () => {
    editorRef.current?.focus();
    editorRef.current?.trigger('toolbar', 'undo', null);
  };

  const handleRedo = () => {
    editorRef.current?.focus();
    editorRef.current?.trigger('toolbar', 'redo', null);
  };

  useEffect(() => {
    if (!fileName || getLanguage(fileName) !== 'markdown') {
      return;
    }

    const editorInstance = mdxEditorRef.current;
    if (!editorInstance) {
      return;
    }

    isApplyingContentRef.current = true;
    editorInstance.setMarkdown(fileContent || '');
    isApplyingContentRef.current = false;
  }, [fileContent, fileName]);

  useEffect(() => {
    setMdxError(null);
  }, [fileId]);

  if (!file) {
    return null;
  }

  const resolvedFileName = file.name ?? '';
  const isMarkdown = getLanguage(resolvedFileName) === 'markdown';
  return (
    <div className="h-full flex flex-col">
      {!isMarkdown && (
        <div className={`p-1 border-b backdrop-blur ${
          isDarkMode ? 'border-slate-700/70 bg-slate-950/70' : 'border-slate-200 bg-white/95'
        }`}>
          <button
            onClick={handleUndo}
            className={`px-2 py-1 mr-1 border rounded ${
              isDarkMode ? 'border-slate-700 text-slate-200 hover:bg-slate-800' : 'border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            Undo
          </button>
          <button
            onClick={handleRedo}
            className={`px-2 py-1 mr-1 border rounded ${
              isDarkMode ? 'border-slate-700 text-slate-200 hover:bg-slate-800' : 'border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            Redo
          </button>
          <button
            onClick={() => {
              editorRef.current?.focus();
              editorRef.current?.trigger('toolbar', 'actions.find', null);
            }}
            className={`px-2 py-1 mr-1 border rounded ${
              isDarkMode ? 'border-slate-700 text-slate-200 hover:bg-slate-800' : 'border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            Find
          </button>
        </div>
      )}
      <div className="min-h-0 flex-grow overflow-hidden">
        {isMarkdown ? (
          <div className="helpudoc-mdxeditor-shell flex h-full min-h-0 flex-col overflow-hidden">
            {mdxError && (
              <div className={`border-b px-4 py-2 text-sm ${
                isDarkMode
                  ? 'border-rose-500/20 bg-rose-950/25 text-rose-200'
                  : 'border-rose-200 bg-rose-50 text-rose-700'
              }`}>
                {mdxError}
              </div>
            )}
            <Suspense fallback={<EditorLoadingState className="min-h-[320px] flex-1" label="Loading rich editor..." />}>
              <MarkdownRichEditor
                key={fileId ?? resolvedFileName}
                ref={mdxEditorRef}
                markdown={fileContent}
                onChange={(value) => {
                  if (isApplyingContentRef.current) return;
                  setMdxError(null);
                  onContentChange(value);
                }}
                onError={setMdxError}
                onImageUpload={handleImageUpload}
                colorMode={colorMode}
              />
            </Suspense>
          </div>
        ) : (
          <Suspense fallback={<EditorLoadingState />}>
            <MonacoEditor
              height="100%"
              language={getLanguage(resolvedFileName)}
              defaultValue={fileContent}
              value={fileContent}
              onMount={handleEditorDidMount}
              onChange={(value) => {
                onContentChange(value || '');
              }}
              theme={monacoTheme}
              options={{
                // Use Monaco's established textarea input, including browser automation
                // and assistive technology, instead of the experimental EditContext API.
                editContext: false,
                automaticLayout: true,
                wordWrap: 'on',
                wrappingIndent: 'indent',
                minimap: { enabled: false },
                lineHeight: 22,
                fontSize: 14,
              }}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
};

const FileEditor: React.FC<FileEditorProps> = (props) => {
  if (!props.file) {
    return null;
  }
  if (/\.docx$/i.test(props.file.name)) {
    return <Suspense fallback={<EditorLoadingState label="Opening Word editor…" />}>
      <NativeDocxEditor
        key={`${props.workspaceId}:${props.file.id}`}
        ref={props.nativeDocxRef}
        workspaceId={props.workspaceId}
        file={props.file}
        onStateChange={props.onNativeDocxStateChange}
      />
    </Suspense>;
  }
  if (isBinaryOfficeDocument(props.file.name ?? '', props.file.mimeType)) {
    return (
      <OfficeDocumentPreviewPane
        file={props.file}
        fileContent={props.fileContent}
        workspaceId={props.workspaceId}
        colorMode={props.colorMode}
      />
    );
  }
  return <WorkspaceFileEditor key={`${props.workspaceId}:${props.file.id}`} {...props} />;
};

export default FileEditor;

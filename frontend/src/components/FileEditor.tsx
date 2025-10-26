import React from 'react';
import Editor from '@monaco-editor/react';
import type { File } from '../types';
import SimpleMDE from 'react-simplemde-editor';
import 'easymde/dist/easymde.min.css';

interface FileEditorProps {
  file: File | null;
  fileContent: string;
  onContentChange: (content: string) => void;
}

const FileEditor: React.FC<FileEditorProps> = ({ file, fileContent, onContentChange }) => {
  if (!file) {
    return null;
  }

  if (file.name.endsWith('.md')) {
    return (
      <div className="w-full h-full overflow-hidden">
        <style>{`
          .EasyMDEContainer {
            width: 100% !important;
            max-width: 100% !important;
          }
          .EasyMDEContainer .CodeMirror {
            width: 100% !important;
            max-width: 100% !important;
            box-sizing: border-box !important;
          }
          .editor-toolbar {
            width: 100% !important;
            max-width: 100% !important;
            box-sizing: border-box !important;
          }
          .CodeMirror-wrap pre {
            word-wrap: break-word !important;
            white-space: pre-wrap !important;
          }
        `}</style>
        <SimpleMDE
          value={fileContent}
          onChange={onContentChange}
          options={{
            autosave: {
              enabled: true,
              uniqueId: `file-${file.id}`,
              delay: 1000,
            },
            toolbar: [
              "bold", "italic", "heading", "|",
              "quote", "unordered-list", "ordered-list", "|",
              "link", "image", "|",
              "preview", "side-by-side", "fullscreen", "|",
              "guide"
            ],
            spellChecker: false,
            lineWrapping: true,
            maxHeight: "calc(100vh - 250px)",
          }}
        />
      </div>
    );
  }

  const getLanguage = (fileName: string) => {
    const extension = fileName.split('.').pop();
    switch (extension) {
      case 'js':
        return 'javascript';
      case 'ts':
        return 'typescript';
      case 'css':
        return 'css';
      case 'html':
        return 'html';
      case 'json':
        return 'json';
      default:
        return 'plaintext';
    }
  };

  return (
    <Editor
      height="100%"
      language={getLanguage(file.name)}
      value={fileContent}
      onChange={(value) => onContentChange(value || '')}
      theme="vs-dark"
      options={{
        wordWrap: 'on',
        wrappingIndent: 'indent',
        minimap: { enabled: false },
      }}
    />
  );
};

export default FileEditor;
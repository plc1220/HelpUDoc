import React, { useEffect, useRef } from 'react';
import mermaid from 'mermaid';
import ReactMarkdown from 'react-markdown';
import type { File } from '../types';

interface FileRendererProps {
  file: File | null;
  fileContent: string;
}

const FileRenderer: React.FC<FileRendererProps> = ({ file, fileContent }) => {
  const mermaidRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (file?.name.endsWith('.mermaid') && mermaidRef.current) {
      try {
        mermaid.run({
          nodes: [mermaidRef.current],
        });
      } catch (e) {
        console.error('Mermaid rendering error:', e);
      }
    }
  }, [file, fileContent]);

  if (!file) {
    return (
      <div className="text-center text-gray-400">
        <p>Select a file to view its content</p>
      </div>
    );
  }

  const renderContent = () => {
    if (file.name.endsWith('.md')) {
      return (
        <div className="prose max-w-none break-words overflow-x-hidden h-full overflow-y-auto">
          <ReactMarkdown
            components={{
              img: ({ node, ...props }) => (
                <img
                  className="max-w-full h-auto rounded-lg shadow-md"
                  loading="lazy"
                  {...props}
                />
              ),
            }}
          >
            {fileContent}
          </ReactMarkdown>
        </div>
      );
    }
    if (file.name.endsWith('.mermaid')) {
      return (
        <div ref={mermaidRef} className="mermaid">
          {fileContent}
        </div>
      );
    }
    if (file.name.endsWith('.html')) {
      return <iframe srcDoc={fileContent} title={file.name} className="w-full h-full border-none" style={{ height: '100%' }} />;
    }
    if (['.png', '.jpg', '.jpeg', '.gif'].some(ext => file.name.endsWith(ext))) {
      if (!fileContent) {
        return null;
      }
      return (
        <div className="flex items-center justify-center h-full">
          <img src={`data:image;base64,${fileContent}`} alt={file.name} className="max-w-full max-h-full object-contain" />
        </div>
      );
    }
    if (file.name.endsWith('.pdf')) {
      return <embed src={`data:application/pdf;base64,${fileContent}`} type="application/pdf" className="w-full h-full" style={{ height: '100%' }} />;
    }
    return <pre className="whitespace-pre-wrap break-words">{fileContent}</pre>;
  };

  return <div className="h-full w-full">{renderContent()}</div>;
};

export default FileRenderer;
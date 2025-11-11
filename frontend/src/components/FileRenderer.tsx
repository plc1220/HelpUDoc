import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import ReactMarkdown from 'react-markdown';
import type { File } from '../types';

interface FileRendererProps {
  file: File | null;
  fileContent: string;
}

const FileRenderer: React.FC<FileRendererProps> = ({ file, fileContent }) => {
  const mermaidRef = useRef<HTMLDivElement>(null);
  const [isMermaidRendered, setIsMermaidRendered] = useState(false);

  useEffect(() => {
    const renderMermaid = async () => {
      if (file?.name.endsWith('.mermaid') && mermaidRef.current) {
        setIsMermaidRendered(false);
        try {
          // Ensure the container is empty before rendering
          mermaidRef.current.innerHTML = '';
          const { svg } = await mermaid.render('mermaid-graph', fileContent);
          if (mermaidRef.current) {
            mermaidRef.current.innerHTML = svg;
            setIsMermaidRendered(true);
          }
        } catch (e) {
          console.error('Mermaid rendering error:', e);
          if (mermaidRef.current) {
            // Display the raw content as a fallback
            mermaidRef.current.textContent = fileContent;
          }
        }
      }
    };
    renderMermaid();
  }, [file, fileContent]);

  const handleCopyImage = () => {
    if (!mermaidRef.current) return;

    const svgElement = mermaidRef.current.querySelector('svg');
    if (!svgElement) return;

    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgElement);
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(async (blob) => {
          if (blob) {
            try {
              await navigator.clipboard.write([
                new ClipboardItem({
                  'image/png': blob,
                }),
              ]);
              alert('Diagram copied to clipboard as image!');
            } catch (err) {
              console.error('Failed to copy image: ', err);
              alert('Failed to copy image to clipboard.');
            }
          }
        }, 'image/png');
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = (err) => {
      console.error('Failed to load SVG image for copying', err);
      alert('Could not load diagram image for copying.');
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

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
        <div className="prose max-w-none break-words overflow-x-hidden h-full overflow-y-auto p-4" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          <ReactMarkdown
            components={{
              img: ({ node, ...props }) => (
                <img
                  className="max-w-full h-auto rounded-lg shadow-md"
                  loading="lazy"
                  {...props}
                  src={props.src || undefined}
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
        <div className="relative h-full">
          <div ref={mermaidRef} className="mermaid-container w-full h-full"></div>
          {isMermaidRendered && (
            <button
              onClick={handleCopyImage}
              className="absolute top-2 right-2 bg-gray-700 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg shadow-md transition-colors duration-200"
              title="Copy as Image"
            >
              Copy as Image
            </button>
          )}
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
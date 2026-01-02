import React, { useEffect, useMemo, useRef, useState } from 'react';
import mermaid from 'mermaid';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Papa from 'papaparse';
import PlotlyChart, { type PlotlySpec } from './PlotlyChart';
import type { File } from '../types';

interface FileRendererProps {
  file: File | null;
  fileContent: string;
}

const MermaidDiagram: React.FC<{ chart: string }> = ({ chart }) => {
  const diagramRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mermaid-md-${Math.random().toString(36).slice(2, 11)}`);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const renderDiagram = async () => {
      if (!diagramRef.current) {
        return;
      }
      try {
        setHasError(false);
        diagramRef.current.innerHTML = '';
        // Validate syntax first to avoid mermaid's inline error SVG
        mermaid.parse(chart);
        const renderId = `${idRef.current}-${Date.now()}`;
        const { svg } = await mermaid.render(renderId, chart);
        if (!cancelled && diagramRef.current) {
          diagramRef.current.innerHTML = svg;
        }
      } catch (error) {
        console.error('Mermaid markdown rendering error:', error);
        if (!cancelled && diagramRef.current) {
          setHasError(true);
          diagramRef.current.textContent = chart;
        }
      }
    };

    renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [chart]);

  return (
    <div
      ref={diagramRef}
      className="mermaid-container my-4 overflow-auto rounded-xl border border-gray-200 bg-white p-4"
    >
      {hasError && (
        <p className="mb-2 text-sm text-red-600">
          Unable to render diagram, showing source instead.
        </p>
      )}
    </div>
  );
};

const FileRenderer: React.FC<FileRendererProps> = ({ file, fileContent }) => {
  const mermaidRef = useRef<HTMLDivElement>(null);
  const mermaidIdRef = useRef(`mermaid-graph-${Math.random().toString(36).slice(2, 11)}`);
  const [isMermaidRendered, setIsMermaidRendered] = useState(false);
  const [mermaidError, setMermaidError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  useEffect(() => {
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  const lowerName = (file?.name || '').toLowerCase();
  const isMarkdownFile = lowerName.endsWith('.md');
  const isMermaidFile = lowerName.endsWith('.mermaid');
  const isHtmlFile = lowerName.endsWith('.html') || lowerName.endsWith('.htm');
  const isImageFile = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].some((ext) =>
    lowerName.endsWith(ext),
  );
  const isPdfFile = lowerName.endsWith('.pdf') || file?.mimeType === 'application/pdf';
  const isCsvFile = lowerName.endsWith('.csv');
  const isPlotlyFile =
    lowerName.endsWith('.plotly.json') ||
    lowerName.endsWith('.plot.json') ||
    lowerName.endsWith('.chart.json') ||
    lowerName.endsWith('.plotly');

  const parsedCsv = useMemo(() => {
    if (!isCsvFile) return null;
    try {
      return Papa.parse(fileContent, { header: true, skipEmptyLines: true });
    } catch (error) {
      console.error('CSV parse error', error);
      return { data: [], errors: [{ message: 'Parse failed' }] };
    }
  }, [fileContent, isCsvFile]);

  useEffect(() => {
    let cancelled = false;

    const renderMermaid = async () => {
      if (isMermaidFile && mermaidRef.current) {
        setIsMermaidRendered(false);
        setMermaidError(null);
        try {
          mermaidRef.current.innerHTML = '';
          // Validate syntax before rendering to avoid Mermaid's error SVG
          mermaid.parse(fileContent);
          const renderId = `${mermaidIdRef.current}-${Date.now()}`;
          const { svg } = await mermaid.render(renderId, fileContent);
          if (!cancelled && mermaidRef.current) {
            mermaidRef.current.innerHTML = svg;
            setIsMermaidRendered(true);
          }
        } catch (e) {
          console.error('Mermaid rendering error:', e);
          if (!cancelled && mermaidRef.current) {
            setMermaidError('Mermaid syntax error. Showing source instead.');
            mermaidRef.current.textContent = fileContent;
          }
        }
      }
    };
    renderMermaid();
    return () => {
      cancelled = true;
    };
  }, [fileContent, isMermaidFile]);

  if (!file) {
    return (
      <div className="text-center text-gray-400">
        <p>Select a file to view its content</p>
      </div>
    );
  }

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
              if (!navigator.clipboard?.write) {
                setCopyStatus('Clipboard not supported in this browser.');
                return;
              }
              await navigator.clipboard.write([
                new ClipboardItem({
                  'image/png': blob,
                }),
              ]);
              setCopyStatus('Diagram copied to clipboard.');
            } catch (err) {
              console.error('Failed to copy image: ', err);
              setCopyStatus('Failed to copy image.');
            }
          }
        }, 'image/png');
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = (err) => {
      console.error('Failed to load SVG image for copying', err);
      setCopyStatus('Could not load diagram image.');
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const renderContent = () => {
    if (isMarkdownFile) {
      return (
        <div className="prose max-w-none break-words overflow-x-hidden h-full overflow-y-auto p-4">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <div className="mb-4 last:mb-0">{children}</div>,
              img: ({ node, ...props }) => (
                <img
                  className="max-w-full h-auto rounded-lg shadow-md"
                  loading="lazy"
                  {...props}
                  src={props.src || undefined}
                />
              ),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              code: ({ inline, className, children, ...props }: any) => {
                const language = /language-(\w+)/.exec(className || '');
                const codeContent = (
                  Array.isArray(children) ? children.join('') : String(children ?? '')
                ).replace(/\n$/, '');

                if (!inline && language?.[1] === 'mermaid') {
                  return <MermaidDiagram chart={codeContent} />;
                }

                if (!inline && language?.[1] === 'plotly') {
                  try {
                    const spec = JSON.parse(codeContent) as PlotlySpec;
                    if (!spec || typeof spec !== 'object') {
                      throw new Error('Plotly spec must be a JSON object.');
                    }
                    if (!Array.isArray(spec.data)) {
                      throw new Error('Plotly spec must include a top-level "data" array.');
                    }
                    return (
                      <div className="my-4 overflow-hidden rounded-xl border border-gray-200 bg-white p-2">
                        <PlotlyChart spec={spec} minHeight={360} />
                      </div>
                    );
                  } catch (error) {
                    return (
                      <pre className="my-4 overflow-x-auto rounded-xl bg-red-50 p-4 text-sm text-red-700">
                        Invalid Plotly JSON: {error instanceof Error ? error.message : 'Unknown error'}
                      </pre>
                    );
                  }
                }

                if (inline) {
                  return (
                    <code
                      className={`rounded-md bg-gray-200 px-1.5 py-0.5 font-mono text-xs text-gray-800 ${className || ''}`}
                      {...props}
                    >
                      {children}
                    </code>
                  );
                }

                return (
                  <pre className="my-4 overflow-x-auto rounded-xl bg-gray-900 p-4 text-sm text-gray-100">
                    <code className={`font-mono ${className || ''}`} {...props}>
                      {children}
                    </code>
                  </pre>
                );
              },
            }}
          >
            {fileContent}
          </ReactMarkdown>
        </div>
      );
    }
    if (isPlotlyFile) {
      try {
        const spec = JSON.parse(fileContent) as PlotlySpec;
        if (!spec || typeof spec !== 'object') {
          throw new Error('Plotly spec must be a JSON object.');
        }
        if (!Array.isArray(spec.data)) {
          throw new Error('Plotly spec must include a top-level "data" array.');
        }
        return <PlotlyChart spec={spec} />;
      } catch (error) {
        return (
          <div className="flex h-full items-center justify-center px-4 text-sm text-red-600">
            Failed to parse Plotly JSON: {error instanceof Error ? error.message : 'Unknown error'}
          </div>
        );
      }
    }
    if (isMermaidFile) {
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
          {mermaidError && (
            <p className="absolute bottom-2 left-2 rounded bg-red-50 px-3 py-1 text-xs text-red-700 shadow">
              {mermaidError}
            </p>
          )}
          {copyStatus && (
            <p className="absolute bottom-2 right-2 rounded bg-gray-900/80 px-3 py-1 text-xs text-white shadow">
              {copyStatus}
            </p>
          )}
        </div>
      );
    }
    if (isHtmlFile) {
      return (
        <iframe
          srcDoc={fileContent}
          title={file.name}
          className="w-full h-full border-none"
          style={{ height: '100%' }}
          sandbox="allow-same-origin allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      );
    }
    if (isImageFile) {
      const dataSrc = fileContent ? `data:${file.mimeType || 'image/*'};base64,${fileContent}` : undefined;
      const imageSrc = file.publicUrl || dataSrc;
      if (!imageSrc) {
        return (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            Unable to display image preview.
          </div>
        );
      }
      const handleCopyUrl = async () => {
        if (!file.publicUrl || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
          return;
        }
        try {
          await navigator.clipboard.writeText(file.publicUrl);
          setCopiedUrl(true);
          window.setTimeout(() => setCopiedUrl(false), 1500);
        } catch (error) {
          console.error('Failed to copy image URL', error);
        }
      };
      const canCopyUrl = Boolean(file.publicUrl);
      return (
        <div className="group relative flex h-full items-center justify-center">
          <img src={imageSrc} alt={file.name} className="max-w-full max-h-full object-contain" />
          {canCopyUrl && (
            <button
              type="button"
              title={copiedUrl ? 'Copied!' : 'Copy public URL'}
              onClick={handleCopyUrl}
              className="absolute right-3 top-3 hidden rounded-full bg-black/60 px-3 py-1 text-xs font-semibold text-white shadow-md transition group-hover:flex"
            >
              {copiedUrl ? 'Copied' : 'Copy URL'}
            </button>
          )}
        </div>
      );
    }
    if (isPdfFile) {
      const pdfSrc = file.publicUrl || (fileContent ? `data:application/pdf;base64,${fileContent}` : undefined);
      if (!pdfSrc) {
        return (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            Unable to display PDF preview.
          </div>
        );
      }
      const handleOpenNewTab = () => {
        window.open(pdfSrc, '_blank', 'noreferrer');
      };
      return (
        <div className="relative h-full w-full">
          <iframe
            src={pdfSrc}
            title={file.name}
            className="h-full w-full border-none"
            style={{ height: '100%' }}
          />
          <button
            type="button"
            onClick={handleOpenNewTab}
            className="absolute right-3 top-3 rounded-full bg-black/60 px-3 py-1 text-xs font-semibold text-white shadow-md transition hover:bg-black/75"
          >
            Open in new tab
          </button>
        </div>
      );
    }
    if (isCsvFile) {
      const parseError = parsedCsv?.errors?.[0]?.message;
      if (parseError) {
        return (
          <div className="flex h-full items-center justify-center px-4 text-sm text-red-600">
            Failed to parse CSV: {parseError}
          </div>
        );
      }
      const data = parsedCsv?.data as Record<string, unknown>[] | undefined;
      if (!data || data.length === 0) {
        return (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            Empty or invalid CSV file.
          </div>
        );
      }
      const headers = Object.keys(data[0] as object);
      return (
        <div className="overflow-auto h-full w-full">
          <table className="min-w-full divide-y divide-gray-200 border-collapse">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                {headers.map((header) => (
                  <th
                    key={header}
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-b border-gray-200 bg-gray-50"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {data.map((row: any, idx: number) => (
                <tr key={idx} className="hover:bg-gray-50">
                  {headers.map((header) => (
                    <td
                      key={`${idx}-${header}`}
                      className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 border-b border-gray-200"
                    >
                      {row[header]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return <pre className="whitespace-pre-wrap break-words">{fileContent}</pre>;
  };

  return <div className="h-full w-full">{renderContent()}</div>;
};

export default FileRenderer;

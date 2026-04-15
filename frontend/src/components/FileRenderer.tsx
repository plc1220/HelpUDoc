import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Papa from 'papaparse';
import type { File } from '../types';
import { parsePlotlySpec } from '../utils/plotlySpec';
import {
  configureMermaid,
  createMarkdownComponents,
  useMermaidColorMode,
} from './markdown/MarkdownShared';

const PlotlyChart = lazy(() => import('./PlotlyChart'));

interface FileRendererProps {
  file: File | null;
  fileContent: string;
  disableInternalScroll?: boolean;
  workspaceId?: string;
}

type TabularPreview = {
  headers: string[];
  rows: string[][];
  totalRows: number;
  totalColumns: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
};

const PARQUET_PREVIEW_MAX_ROWS = 100;
const PARQUET_PREVIEW_MAX_COLUMNS = 20;
let parquetRuntimePromise: Promise<{
  parquetMetadataAsync: any;
  parquetReadObjects: any;
  parquetSchema: any;
  compressors: any;
}> | null = null;

const loadParquetRuntime = async () => {
  if (!parquetRuntimePromise) {
    parquetRuntimePromise = (async () => {
      const [parquetModule, compressorModule] = await Promise.all([
        import('hyparquet'),
        import('hyparquet-compressors'),
      ]);

      return {
        parquetMetadataAsync: parquetModule.parquetMetadataAsync,
        parquetReadObjects: parquetModule.parquetReadObjects,
        parquetSchema: parquetModule.parquetSchema,
        compressors: compressorModule.compressors,
      };
    })();
  }

  return parquetRuntimePromise;
};

const decodeBase64ToArrayBuffer = (value: string) => {
  const normalized = value.trim();
  const binary = window.atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
};

const formatPreviewCell = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name}]`;
  if (value instanceof Map) return JSON.stringify(Object.fromEntries(value));
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

const FileRenderer: React.FC<FileRendererProps> = ({
  file,
  fileContent,
  disableInternalScroll = false,
  workspaceId,
}) => {
  const mermaidRef = useRef<HTMLDivElement>(null);
  const mermaidIdRef = useRef(`mermaid-graph-${Math.random().toString(36).slice(2, 11)}`);
  const [isMermaidRendered, setIsMermaidRendered] = useState(false);
  const [mermaidError, setMermaidError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const colorMode = useMermaidColorMode();

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
  const isParquetFile =
    lowerName.endsWith('.parquet') ||
    lowerName.endsWith('.pq') ||
    (file?.mimeType || '').toLowerCase().includes('parquet');
  const isPlotlyFile =
    lowerName.endsWith('.plotly.json') ||
    lowerName.endsWith('.plot.json') ||
    lowerName.endsWith('.chart.json') ||
    lowerName.endsWith('.plotly');
  const [parquetPreview, setParquetPreview] = useState<TabularPreview | null>(null);
  const [parquetError, setParquetError] = useState<string | null>(null);
  const [isParquetLoading, setIsParquetLoading] = useState(false);

  const parsedCsv = useMemo(() => {
    if (!isCsvFile || !fileContent.trim()) return null;
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
          const mermaid = await configureMermaid(colorMode);
          // Validate syntax before rendering to avoid Mermaid's error SVG
          await mermaid.parse(fileContent);
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
  }, [colorMode, fileContent, isMermaidFile]);

  useEffect(() => {
    if (!isParquetFile) {
      setParquetPreview(null);
      setParquetError(null);
      setIsParquetLoading(false);
      return;
    }

    if (!fileContent.trim()) {
      setParquetPreview(null);
      setParquetError(null);
      setIsParquetLoading(true);
      return;
    }

    let cancelled = false;

    const loadParquetPreview = async () => {
      setIsParquetLoading(true);
      setParquetError(null);

      try {
        const { parquetMetadataAsync, parquetReadObjects, parquetSchema, compressors } = await loadParquetRuntime();

        const parquetBuffer = decodeBase64ToArrayBuffer(fileContent);
        const metadata = await parquetMetadataAsync(parquetBuffer);
        const schema = parquetSchema(metadata);
        const rows = await parquetReadObjects({
          file: parquetBuffer,
          rowFormat: 'object',
          rowStart: 0,
          rowEnd: PARQUET_PREVIEW_MAX_ROWS,
          compressors,
        });
        const allHeaders = (schema.children as Array<{ element: { name: string } }>).map(
          (field) => field.element.name,
        );
        const headers = allHeaders.slice(0, PARQUET_PREVIEW_MAX_COLUMNS);
        const previewRows = (rows as Record<string, unknown>[]).map((row) =>
          headers.map((header) => formatPreviewCell(row?.[header])),
        );

        if (!cancelled) {
          setParquetPreview({
            headers,
            rows: previewRows,
            totalRows: Number(metadata.num_rows),
            totalColumns: allHeaders.length,
            truncatedRows: Number(metadata.num_rows) > PARQUET_PREVIEW_MAX_ROWS,
            truncatedColumns: allHeaders.length > PARQUET_PREVIEW_MAX_COLUMNS,
          });
        }
      } catch (error) {
        console.error('Parquet parse error', error);
        if (!cancelled) {
          setParquetPreview(null);
          setParquetError(
            error instanceof Error ? error.message : 'Failed to parse Parquet preview.',
          );
        }
      } finally {
        if (!cancelled) {
          setIsParquetLoading(false);
        }
      }
    };

    void loadParquetPreview();

    return () => {
      cancelled = true;
    };
  }, [fileContent, isParquetFile]);

  const markdownComponents = useMemo(
    () => createMarkdownComponents({
      workspaceId,
      colorMode,
      paragraphClassName: 'mb-4 last:mb-0',
    }),
    [workspaceId, colorMode]
  );

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
      const markdownContainerClassName = [
        colorMode === 'dark' ? 'prose prose-invert' : 'prose prose-slate',
        'max-w-none break-words overflow-x-hidden p-4',
        disableInternalScroll ? 'h-auto overflow-y-visible' : 'h-full overflow-y-auto',
      ].join(' ');

      return (
        <div className={`${markdownContainerClassName} helpudoc-markdown`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {fileContent}
          </ReactMarkdown>
        </div>
      );
    }
    if (isPlotlyFile) {
      const normalizedPlotlyContent = fileContent.trim();
      if (!normalizedPlotlyContent) {
        return (
          <div className="flex h-full items-center justify-center px-4 text-sm text-slate-500">
            Loading chart…
          </div>
        );
      }
      try {
        const spec = parsePlotlySpec(fileContent);
        if (!spec || typeof spec !== 'object') {
          throw new Error('Plotly spec must be a JSON object.');
        }
        return (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-slate-500">Loading chart…</div>}>
            <PlotlyChart spec={spec} />
          </Suspense>
        );
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
          <div
            ref={mermaidRef}
            className={`mermaid-container h-full w-full rounded-xl ${colorMode === 'dark' ? 'bg-slate-950' : 'bg-white'}`}
          ></div>
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
      const imageSrc = dataSrc || file.publicUrl;
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
      const pdfSrc = fileContent ? `data:application/pdf;base64,${fileContent}` : file.publicUrl || undefined;
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
      if (!fileContent.trim()) {
        return (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            Loading CSV preview...
          </div>
        );
      }
      const parseError = parsedCsv?.errors?.find(
        (error) => !/auto-detect/i.test(error.message),
      )?.message;
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
              {data.map((row: Record<string, unknown>, idx: number) => (
                <tr key={idx} className="hover:bg-gray-50">
                  {headers.map((header) => (
                    <td
                      key={`${idx}-${header}`}
                      className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 border-b border-gray-200"
                    >
                      {row[header] == null
                        ? ''
                        : typeof row[header] === 'object'
                          ? JSON.stringify(row[header])
                          : String(row[header])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    if (isParquetFile) {
      if (isParquetLoading) {
        return (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            Loading Parquet preview...
          </div>
        );
      }
      if (parquetError) {
        return (
          <div className="flex h-full items-center justify-center px-4 text-sm text-red-600">
            Failed to parse Parquet: {parquetError}
          </div>
        );
      }
      if (!parquetPreview || parquetPreview.headers.length === 0) {
        return (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            Empty or unsupported Parquet file.
          </div>
        );
      }

      const summary = [
        `${parquetPreview.totalRows} row${parquetPreview.totalRows === 1 ? '' : 's'}`,
        `${parquetPreview.totalColumns} column${parquetPreview.totalColumns === 1 ? '' : 's'}`,
      ].join(' • ');

      const truncationLabel = [
        parquetPreview.truncatedRows ? `showing first ${PARQUET_PREVIEW_MAX_ROWS} rows` : null,
        parquetPreview.truncatedColumns
          ? `first ${PARQUET_PREVIEW_MAX_COLUMNS} columns visible`
          : null,
      ]
        .filter(Boolean)
        .join(' • ');

      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-gray-200 px-4 py-3 text-xs text-gray-500">
            <span className="font-medium text-gray-700">Parquet preview</span> • {summary}
            {truncationLabel ? ` • ${truncationLabel}` : ''}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="min-w-full divide-y divide-gray-200 border-collapse">
              <thead className="sticky top-0 z-10 bg-gray-50">
                <tr>
                  {parquetPreview.headers.map((header) => (
                    <th
                      key={header}
                      className="border-b border-gray-200 bg-gray-50 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {parquetPreview.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="hover:bg-gray-50">
                    {row.map((cell, cellIndex) => (
                      <td
                        key={`${rowIndex}-${parquetPreview.headers[cellIndex]}`}
                        className="border-b border-gray-200 px-6 py-4 text-sm text-gray-900"
                      >
                        <div className="max-w-md whitespace-pre-wrap break-words">{cell}</div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    return <pre className="whitespace-pre-wrap break-words">{fileContent}</pre>;
  };

  return <div className="h-full w-full">{renderContent()}</div>;
};

export default FileRenderer;

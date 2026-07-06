import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Papa from 'papaparse';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/light';
import bash from 'react-syntax-highlighter/dist/esm/languages/hljs/bash';
import cpp from 'react-syntax-highlighter/dist/esm/languages/hljs/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/hljs/csharp';
import css from 'react-syntax-highlighter/dist/esm/languages/hljs/css';
import dockerfile from 'react-syntax-highlighter/dist/esm/languages/hljs/dockerfile';
import go from 'react-syntax-highlighter/dist/esm/languages/hljs/go';
import ini from 'react-syntax-highlighter/dist/esm/languages/hljs/ini';
import java from 'react-syntax-highlighter/dist/esm/languages/hljs/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/hljs/json';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/hljs/kotlin';
import less from 'react-syntax-highlighter/dist/esm/languages/hljs/less';
import lua from 'react-syntax-highlighter/dist/esm/languages/hljs/lua';
import php from 'react-syntax-highlighter/dist/esm/languages/hljs/php';
import plaintext from 'react-syntax-highlighter/dist/esm/languages/hljs/plaintext';
import powershell from 'react-syntax-highlighter/dist/esm/languages/hljs/powershell';
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python';
import r from 'react-syntax-highlighter/dist/esm/languages/hljs/r';
import ruby from 'react-syntax-highlighter/dist/esm/languages/hljs/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/hljs/rust';
import scss from 'react-syntax-highlighter/dist/esm/languages/hljs/scss';
import sql from 'react-syntax-highlighter/dist/esm/languages/hljs/sql';
import typescript from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript';
import xml from 'react-syntax-highlighter/dist/esm/languages/hljs/xml';
import yaml from 'react-syntax-highlighter/dist/esm/languages/hljs/yaml';
import atomOneDark from 'react-syntax-highlighter/dist/esm/styles/hljs/atom-one-dark';
import github from 'react-syntax-highlighter/dist/esm/styles/hljs/github';
import type JSZipType from 'jszip';
import type { File } from '../types';
import { parsePlotlySpec } from '../utils/plotlySpec';
import {
  configureMermaid,
  createMarkdownComponents,
  useMermaidColorMode,
} from './markdown/MarkdownShared';
import {
  getOfficeDocumentKind,
  isOfficeDocument,
  isPowerPointDocument,
  isSpreadsheetDocument,
  officeOnlineEmbedUrl,
} from '../utils/officeFiles';

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

type PptxSlidePreview = {
  slideNumber: number;
  title: string;
  lines: string[];
};

const PARQUET_PREVIEW_MAX_ROWS = 100;
const PARQUET_PREVIEW_MAX_COLUMNS = 20;
const SPREADSHEET_PREVIEW_MAX_ROWS = 100;
const SPREADSHEET_PREVIEW_MAX_COLUMNS = 20;
const PPTX_PREVIEW_MAX_SLIDES = 80;
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('c', cpp);
SyntaxHighlighter.registerLanguage('cpp', cpp);
SyntaxHighlighter.registerLanguage('csharp', csharp);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('docker', dockerfile);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('ini', ini);
SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('kotlin', kotlin);
SyntaxHighlighter.registerLanguage('less', less);
SyntaxHighlighter.registerLanguage('lua', lua);
SyntaxHighlighter.registerLanguage('php', php);
SyntaxHighlighter.registerLanguage('powershell', powershell);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('r', r);
SyntaxHighlighter.registerLanguage('ruby', ruby);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('scss', scss);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('text', plaintext);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('xml', xml);
SyntaxHighlighter.registerLanguage('yaml', yaml);
const CODE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.py': 'python',
  '.pyw': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'scss',
  '.less': 'less',
  '.json': 'json',
  '.jsonl': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.sql': 'sql',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.fish': 'bash',
  '.ps1': 'powershell',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.r': 'r',
  '.lua': 'lua',
  '.vue': 'xml',
  '.svelte': 'xml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.env': 'ini',
  '.dockerfile': 'docker',
};
let parquetRuntimePromise: Promise<{
  parquetMetadataAsync: typeof import('hyparquet').parquetMetadataAsync;
  parquetReadObjects: typeof import('hyparquet').parquetReadObjects;
  parquetSchema: typeof import('hyparquet').parquetSchema;
  compressors: import('hyparquet').Compressors;
}> | null = null;

let spreadsheetRuntimePromise: Promise<typeof import('xlsx')> | null = null;
let pptxZipRuntimePromise: Promise<typeof JSZipType> | null = null;

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

const loadSpreadsheetRuntime = async () => {
  if (!spreadsheetRuntimePromise) {
    spreadsheetRuntimePromise = import('xlsx');
  }

  return spreadsheetRuntimePromise;
};

const loadPptxZipRuntime = async () => {
  if (!pptxZipRuntimePromise) {
    pptxZipRuntimePromise = import('jszip').then((module) => module.default || module);
  }

  return pptxZipRuntimePromise;
};

const getFileExtension = (fileName: string): string => {
  const normalized = fileName.trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.endsWith('dockerfile')) return '.dockerfile';
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const baseName = normalized.slice(lastSlash + 1);
  const dotIndex = baseName.lastIndexOf('.');
  return dotIndex >= 0 ? baseName.slice(dotIndex) : '';
};

const getCodeLanguage = (fileName: string, mimeType?: string | null): string | null => {
  const extension = getFileExtension(fileName);
  if (CODE_LANGUAGE_BY_EXTENSION[extension]) {
    return CODE_LANGUAGE_BY_EXTENSION[extension];
  }

  if (isOfficeDocument(fileName, mimeType)) {
    return null;
  }

  const m = (mimeType || '').toLowerCase();
  if (m.includes('python')) return 'python';
  if (m.includes('typescript')) return 'typescript';
  if (m.includes('javascript') || m.includes('ecmascript')) return 'javascript';
  if (m.includes('json')) return 'json';
  if (m.includes('yaml') || m.includes('yml')) return 'yaml';
  const baseMime = m.split(';')[0].trim();
  if (baseMime === 'application/xml' || baseMime === 'text/xml' || baseMime.endsWith('+xml')) {
    return 'xml';
  }
  if (m.includes('css')) return 'css';
  if (m.includes('x-shellscript') || m.includes('shell')) return 'bash';
  if (m.startsWith('text/x-')) return 'text';

  return null;
};

const decodeBase64ToArrayBuffer = (value: string) => {
  let normalized = value.trim();
  const base64Marker = 'base64,';
  const markerIndex = normalized.indexOf(base64Marker);
  if (markerIndex !== -1) {
    normalized = normalized.slice(markerIndex + base64Marker.length);
  }
  normalized = normalized.replace(/\s+/g, '');
  const binary = window.atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
};

/** Mammoth may emit empty or whitespace-only markup for minimal docs. */
const isDocxHtmlEffectivelyEmpty = (html: string): boolean => {
  if (!html.trim()) return true;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const text = doc.body?.textContent ?? '';
    return text.replace(/\u00a0/g, ' ').trim().length === 0;
  } catch {
    return false;
  }
};

const parseXmlDocument = (xml: string): Document => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const parseError = doc.getElementsByTagName('parsererror')[0];
  if (parseError) {
    throw new Error(parseError.textContent || 'Invalid XML in PowerPoint file.');
  }
  return doc;
};

const getXmlAttr = (element: Element, name: string): string => {
  return element.getAttribute(name) || element.getAttribute(name.split(':').pop() || name) || '';
};

const normalizePptxText = (value: string): string => {
  return value.replace(/\s+/g, ' ').trim();
};

const extractPptxParagraphs = (slideXml: string): string[] => {
  const doc = parseXmlDocument(slideXml);
  const paragraphNodes = Array.from(doc.getElementsByTagName('a:p'));
  const paragraphs = paragraphNodes
    .map((paragraph) => {
      const pieces = Array.from(paragraph.getElementsByTagName('a:t')).map(
        (node) => node.textContent || '',
      );
      return normalizePptxText(pieces.join(''));
    })
    .filter(Boolean);

  const deduped: string[] = [];
  for (const paragraph of paragraphs) {
    if (deduped[deduped.length - 1] !== paragraph) {
      deduped.push(paragraph);
    }
  }
  return deduped;
};

const resolvePptxSlidePaths = async (
  zip: JSZipType,
): Promise<string[]> => {
  const presentationXml = await zip.file('ppt/presentation.xml')?.async('string');
  const relsXml = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (!presentationXml || !relsXml) {
    return Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((left, right) => {
        const leftIndex = Number(left.match(/slide(\d+)\.xml$/i)?.[1] || 0);
        const rightIndex = Number(right.match(/slide(\d+)\.xml$/i)?.[1] || 0);
        return leftIndex - rightIndex;
      });
  }

  const presentationDoc = parseXmlDocument(presentationXml);
  const relsDoc = parseXmlDocument(relsXml);
  const relTargetById = new Map(
    Array.from(relsDoc.getElementsByTagName('Relationship')).map((relationship) => [
      getXmlAttr(relationship, 'Id'),
      getXmlAttr(relationship, 'Target'),
    ]),
  );

  return Array.from(presentationDoc.getElementsByTagName('p:sldId'))
    .map((slideId) => relTargetById.get(getXmlAttr(slideId, 'r:id')) || '')
    .filter(Boolean)
    .map((target) => {
      const normalized = target.replace(/\\/g, '/').replace(/^\/+/, '');
      return normalized.startsWith('ppt/') ? normalized : `ppt/${normalized}`;
    });
};

const extractPptxPreview = async (fileContent: string): Promise<PptxSlidePreview[]> => {
  const JSZip = await loadPptxZipRuntime();
  const zip = await JSZip.loadAsync(decodeBase64ToArrayBuffer(fileContent));
  const slidePaths = (await resolvePptxSlidePaths(zip)).slice(0, PPTX_PREVIEW_MAX_SLIDES);
  const slides: PptxSlidePreview[] = [];

  for (const [index, slidePath] of slidePaths.entries()) {
    const slideXml = await zip.file(slidePath)?.async('string');
    if (!slideXml) continue;
    const lines = extractPptxParagraphs(slideXml);
    slides.push({
      slideNumber: index + 1,
      title: lines[0] || `Slide ${index + 1}`,
      lines,
    });
  }

  return slides;
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

const renderTabularPreview = (
  title: string,
  preview: TabularPreview,
  maxRows: number,
  maxColumns: number,
) => {
  const summary = [
    `${preview.totalRows} row${preview.totalRows === 1 ? '' : 's'}`,
    `${preview.totalColumns} column${preview.totalColumns === 1 ? '' : 's'}`,
  ].join(' • ');

  const truncationLabel = [
    preview.truncatedRows ? `showing first ${maxRows} rows` : null,
    preview.truncatedColumns ? `first ${maxColumns} columns visible` : null,
  ]
    .filter(Boolean)
    .join(' • ');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-gray-200 px-4 py-3 text-xs text-gray-500">
        <span className="font-medium text-gray-700">{title}</span> • {summary}
        {truncationLabel ? ` • ${truncationLabel}` : ''}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full divide-y divide-gray-200 border-collapse">
          <thead className="sticky top-0 z-10 bg-gray-50">
            <tr>
              {preview.headers.map((header) => (
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
            {preview.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-gray-50">
                {row.map((cell, cellIndex) => (
                  <td
                    key={`${rowIndex}-${preview.headers[cellIndex]}`}
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
  const isDocxFile =
    lowerName.endsWith('.docx') ||
    (file?.mimeType || '').toLowerCase().includes(
      'wordprocessingml',
    );
  const isOfficeFile = isOfficeDocument(lowerName, file?.mimeType);
  const isPptxFile =
    isPowerPointDocument(lowerName) ||
    (file?.mimeType || '').toLowerCase().includes('presentationml');
  const isSpreadsheetFile =
    isSpreadsheetDocument(lowerName) ||
    (file?.mimeType || '').toLowerCase().includes('spreadsheetml') ||
    (file?.mimeType || '').toLowerCase().includes('ms-excel');
  const codeLanguage = getCodeLanguage(file?.name || '', file?.mimeType);
  const [parquetPreview, setParquetPreview] = useState<TabularPreview | null>(null);
  const [parquetError, setParquetError] = useState<string | null>(null);
  const [isParquetLoading, setIsParquetLoading] = useState(false);
  const [spreadsheetPreview, setSpreadsheetPreview] = useState<TabularPreview | null>(null);
  const [spreadsheetPreviewTitle, setSpreadsheetPreviewTitle] = useState('Spreadsheet preview');
  const [spreadsheetError, setSpreadsheetError] = useState<string | null>(null);
  const [isSpreadsheetLoading, setIsSpreadsheetLoading] = useState(false);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [docxHtmlSource, setDocxHtmlSource] = useState<string | null>(null);
  const [docxError, setDocxError] = useState<string | null>(null);
  const [isDocxLoading, setIsDocxLoading] = useState(false);
  const [pptxPreview, setPptxPreview] = useState<PptxSlidePreview[] | null>(null);
  const [pptxPreviewSource, setPptxPreviewSource] = useState<string | null>(null);
  const [pptxError, setPptxError] = useState<string | null>(null);
  const [isPptxLoading, setIsPptxLoading] = useState(false);

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

  useEffect(() => {
    if (!isSpreadsheetFile) {
      setSpreadsheetPreview(null);
      setSpreadsheetError(null);
      setIsSpreadsheetLoading(false);
      return;
    }

    if (!fileContent.trim()) {
      setSpreadsheetPreview(null);
      setSpreadsheetError(null);
      setIsSpreadsheetLoading(true);
      return;
    }

    let cancelled = false;

    const loadSpreadsheetPreview = async () => {
      setIsSpreadsheetLoading(true);
      setSpreadsheetError(null);

      try {
        const XLSX = await loadSpreadsheetRuntime();
        const workbook = XLSX.read(decodeBase64ToArrayBuffer(fileContent), { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = firstSheetName ? workbook.Sheets[firstSheetName] : null;
        const sheetRange = worksheet?.['!ref'] ? XLSX.utils.decode_range(worksheet['!ref']) : null;
        const values = worksheet
          ? (XLSX.utils.sheet_to_json(worksheet, {
              header: 1,
              raw: false,
              defval: '',
              blankrows: false,
            }) as unknown[][])
          : [];

        if (!worksheet || values.length === 0) {
          if (!cancelled) {
            setSpreadsheetPreview({
              headers: [],
              rows: [],
              totalRows: 0,
              totalColumns: 0,
              truncatedRows: false,
              truncatedColumns: false,
            });
            setSpreadsheetPreviewTitle(firstSheetName ? `${firstSheetName} preview` : 'Spreadsheet preview');
          }
          return;
        }

        const totalRows = sheetRange ? sheetRange.e.r + 1 : values.length;
        const totalColumns = sheetRange
          ? sheetRange.e.c + 1
          : values.reduce((max, row) => Math.max(max, row.length), 0);
        const visibleColumnCount = Math.min(totalColumns, SPREADSHEET_PREVIEW_MAX_COLUMNS);
        const headers = Array.from({ length: visibleColumnCount }, (_, index) => {
          const headerValue = values[0]?.[index];
          const formatted = formatPreviewCell(headerValue).trim();
          return formatted || `Column ${index + 1}`;
        });
        const visibleRows = values
          .slice(1, SPREADSHEET_PREVIEW_MAX_ROWS + 1)
          .map((row) =>
            headers.map((_, columnIndex) => formatPreviewCell(row[columnIndex])),
          );

        if (!cancelled) {
          setSpreadsheetPreview({
            headers,
            rows: visibleRows,
            totalRows,
            totalColumns,
            truncatedRows: totalRows > SPREADSHEET_PREVIEW_MAX_ROWS + 1,
            truncatedColumns: totalColumns > SPREADSHEET_PREVIEW_MAX_COLUMNS,
          });
          setSpreadsheetPreviewTitle(
            firstSheetName ? `${firstSheetName} preview` : 'Spreadsheet preview',
          );
        }
      } catch (error) {
        console.error('Spreadsheet parse error', error);
        if (!cancelled) {
          setSpreadsheetPreview(null);
          setSpreadsheetError(
            error instanceof Error ? error.message : 'Failed to parse spreadsheet preview.',
          );
        }
      } finally {
        if (!cancelled) {
          setIsSpreadsheetLoading(false);
        }
      }
    };

    void loadSpreadsheetPreview();

    return () => {
      cancelled = true;
    };
  }, [fileContent, isSpreadsheetFile]);

  useEffect(() => {
    if (!isDocxFile) {
      setDocxHtml(null);
      setDocxHtmlSource(null);
      setDocxError(null);
      setIsDocxLoading(false);
      return;
    }

    if (!fileContent.trim()) {
      setDocxHtml(null);
      setDocxHtmlSource(null);
      setDocxError(null);
      setIsDocxLoading(false);
      return;
    }

    let cancelled = false;

    const run = async () => {
      setIsDocxLoading(true);
      setDocxHtml(null);
      setDocxHtmlSource(null);
      setDocxError(null);
      try {
        const mammoth = await import('mammoth');
        const arrayBuffer = decodeBase64ToArrayBuffer(fileContent);
        const { value } = await mammoth.convertToHtml({ arrayBuffer });
        if (!cancelled) {
          setDocxHtml(value);
          setDocxHtmlSource(fileContent);
        }
      } catch (error) {
        console.error('DOCX preview error', error);
        if (!cancelled) {
          setDocxHtml(null);
          setDocxHtmlSource(null);
          setDocxError(
            error instanceof Error
              ? error.message
              : 'Could not convert this Word file to HTML.',
          );
        }
      } finally {
        if (!cancelled) {
          setIsDocxLoading(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [fileContent, isDocxFile]);

  useEffect(() => {
    if (!isPptxFile) {
      setPptxPreview(null);
      setPptxPreviewSource(null);
      setPptxError(null);
      setIsPptxLoading(false);
      return;
    }

    if (!fileContent.trim()) {
      setPptxPreview(null);
      setPptxPreviewSource(null);
      setPptxError(null);
      setIsPptxLoading(false);
      return;
    }

    let cancelled = false;

    const run = async () => {
      setIsPptxLoading(true);
      setPptxPreview(null);
      setPptxPreviewSource(null);
      setPptxError(null);
      try {
        const slides = await extractPptxPreview(fileContent);
        if (!cancelled) {
          setPptxPreview(slides);
          setPptxPreviewSource(fileContent);
        }
      } catch (error) {
        console.error('PPTX preview error', error);
        if (!cancelled) {
          setPptxPreview(null);
          setPptxPreviewSource(null);
          setPptxError(
            error instanceof Error
              ? error.message
              : 'Could not read this PowerPoint file.',
          );
        }
      } finally {
        if (!cancelled) {
          setIsPptxLoading(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [fileContent, isPptxFile]);

  const markdownComponents = useMemo(
    () => createMarkdownComponents({
      workspaceId,
      colorMode,
      paragraphClassName: 'mb-4 last:mb-0',
    }),
    [workspaceId, colorMode]
  );

  const downloadBinaryFile = (
    fallbackMimeType = 'application/octet-stream',
    fallbackFileName = 'download',
  ) => {
    try {
      const buffer = decodeBase64ToArrayBuffer(fileContent);
      const blob = new Blob([buffer], {
        type: file?.mimeType || fallbackMimeType,
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file?.name || fallbackFileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('File download failed', e);
    }
  };

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
      const pdfSrc = file.publicUrl || (fileContent ? `data:application/pdf;base64,${fileContent}` : undefined);
      const pdfSourceKey = file.publicUrl || `${fileContent.length}:${fileContent.slice(0, 24)}`;
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
            key={`${file.id || file.name}:${pdfSourceKey}`}
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
    if (codeLanguage) {
      const syntaxTheme = colorMode === 'dark' ? atomOneDark : github;
      const lineCount = fileContent ? fileContent.split(/\r\n|\r|\n/).length : 0;
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div
            className={`shrink-0 border-b px-4 py-2 text-xs ${
              colorMode === 'dark'
                ? 'border-slate-700 text-slate-400'
                : 'border-gray-200 text-gray-500'
            }`}
          >
            <span className={`font-medium ${colorMode === 'dark' ? 'text-slate-200' : 'text-gray-700'}`}>
              Code preview
            </span>
            {' · '}
            {codeLanguage}
            {lineCount ? ` · ${lineCount} line${lineCount === 1 ? '' : 's'}` : ''}
          </div>
          <div className={disableInternalScroll ? 'h-auto overflow-x-auto' : 'min-h-0 flex-1 overflow-auto'}>
            <SyntaxHighlighter
              language={codeLanguage}
              style={syntaxTheme}
              showLineNumbers
              wrapLongLines
              customStyle={{
                margin: 0,
                minHeight: '100%',
                borderRadius: 0,
                fontSize: '0.8125rem',
                lineHeight: 1.55,
              }}
              codeTagProps={{
                style: {
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                },
              }}
            >
              {fileContent || ' '}
            </SyntaxHighlighter>
          </div>
        </div>
      );
    }
    if (isDocxFile) {
      const docxBanner = (
        <div
          className={`shrink-0 border-b px-4 py-2 text-xs ${
            colorMode === 'dark'
              ? 'border-slate-700 text-slate-400'
              : 'border-gray-200 text-gray-500'
          }`}
        >
          <span
            className={`font-medium ${colorMode === 'dark' ? 'text-slate-200' : 'text-gray-700'}`}
          >
            Word preview
          </span>
          {' · '}
          Approximate layout
        </div>
      );
      const docxProse = [
        colorMode === 'dark' ? 'prose prose-invert' : 'prose prose-slate',
        'max-w-none break-words p-4 text-sm',
        disableInternalScroll ? 'h-auto overflow-y-visible' : 'min-h-0 flex-1 overflow-y-auto',
      ].join(' ');
      /** Converts async; first paint may run before useEffect sets isDocxLoading. */
      const docxAwaitingPreview =
        isDocxLoading
        || (fileContent.trim().length > 0 && (docxHtml === null || docxHtmlSource !== fileContent) && !docxError);
      if (docxAwaitingPreview) {
        return (
          <div className="flex h-full min-h-0 flex-col">
            {docxBanner}
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-gray-500">
              Loading preview…
            </div>
          </div>
        );
      }
      if (docxError) {
        return (
          <div className="flex h-full min-h-0 flex-col">
            {docxBanner}
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-red-600">
              Preview failed: {docxError}
            </div>
          </div>
        );
      }
      if (docxHtml == null) {
        return (
          <div className="flex h-full min-h-0 flex-col">
            {docxBanner}
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-gray-500">
              No file content loaded. Preview is unavailable.
            </div>
          </div>
        );
      }
      if (isDocxHtmlEffectivelyEmpty(docxHtml)) {
        return (
          <div className="flex h-full min-h-0 flex-col">
            {docxBanner}
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-gray-500">
              No previewable text in this document.
            </div>
          </div>
        );
      }
      return (
        <div className="flex h-full min-h-0 flex-col">
          {docxBanner}
          <div
            className={`helpudoc-docx-preview min-h-0 flex-1 ${docxProse}`}
            // mammoth emits semantic HTML; images may be embedded or omitted by the converter
            dangerouslySetInnerHTML={{ __html: docxHtml }}
          />
        </div>
      );
    }
    if (isSpreadsheetFile) {
      if (isSpreadsheetLoading) {
        return (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            Loading spreadsheet preview...
          </div>
        );
      }
      if (spreadsheetError) {
        return (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-sm text-red-600">
            <p>Failed to parse spreadsheet: {spreadsheetError}</p>
            {fileContent.trim() ? (
              <button
                type="button"
                onClick={() => downloadBinaryFile(
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  file?.name || 'spreadsheet',
                )}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${
                  colorMode === 'dark'
                    ? 'bg-slate-600 hover:bg-slate-500'
                    : 'bg-slate-800 hover:bg-slate-700'
                }`}
              >
                Download file
              </button>
            ) : null}
          </div>
        );
      }
      if (!spreadsheetPreview || spreadsheetPreview.headers.length === 0) {
        return (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            Empty or unsupported spreadsheet file.
          </div>
        );
      }

      return renderTabularPreview(
        spreadsheetPreviewTitle,
        spreadsheetPreview,
        SPREADSHEET_PREVIEW_MAX_ROWS,
        SPREADSHEET_PREVIEW_MAX_COLUMNS,
      );
    }
    if (isPptxFile) {
      const banner = (
        <div
          className={`shrink-0 border-b px-4 py-2 text-xs ${
            colorMode === 'dark'
              ? 'border-slate-700 text-slate-400'
              : 'border-gray-200 text-gray-500'
          }`}
        >
          <span className={`font-medium ${colorMode === 'dark' ? 'text-slate-200' : 'text-gray-700'}`}>
            PowerPoint preview
          </span>
          {' · '}
          Text extraction
        </div>
      );
      const awaitingPreview =
        isPptxLoading
        || (fileContent.trim().length > 0 && (pptxPreview === null || pptxPreviewSource !== fileContent) && !pptxError);

      if (awaitingPreview) {
        return (
          <div className="flex h-full min-h-0 flex-col">
            {banner}
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-gray-500">
              Loading preview...
            </div>
          </div>
        );
      }

      if (pptxError) {
        return (
          <div className="flex h-full min-h-0 flex-col">
            {banner}
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center text-sm text-red-600">
              <p>Preview failed: {pptxError}</p>
              {fileContent.trim() ? (
                <button
                  type="button"
                  onClick={() => downloadBinaryFile(
                    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                    file?.name || 'presentation.pptx',
                  )}
                  className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${
                    colorMode === 'dark'
                      ? 'bg-slate-600 hover:bg-slate-500'
                      : 'bg-slate-800 hover:bg-slate-700'
                  }`}
                >
                  Download file
                </button>
              ) : null}
            </div>
          </div>
        );
      }

      if (!pptxPreview || pptxPreview.length === 0) {
        return (
          <div className="flex h-full min-h-0 flex-col">
            {banner}
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center text-sm text-gray-500">
              <p>No previewable slide text found.</p>
              {fileContent.trim() ? (
                <button
                  type="button"
                  onClick={() => downloadBinaryFile(
                    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                    file?.name || 'presentation.pptx',
                  )}
                  className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${
                    colorMode === 'dark'
                      ? 'bg-slate-600 hover:bg-slate-500'
                      : 'bg-slate-800 hover:bg-slate-700'
                  }`}
                >
                  Download file
                </button>
              ) : null}
            </div>
          </div>
        );
      }

      return (
        <div className="flex h-full min-h-0 flex-col">
          {banner}
          <div
            className={`min-h-0 flex-1 overflow-y-auto px-5 py-4 ${
              colorMode === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-gray-50 text-gray-900'
            }`}
          >
            <div className="mx-auto flex max-w-4xl flex-col gap-4">
              <div className={`text-xs ${colorMode === 'dark' ? 'text-slate-400' : 'text-gray-500'}`}>
                {pptxPreview.length} slide{pptxPreview.length === 1 ? '' : 's'}
                {pptxPreview.length === PPTX_PREVIEW_MAX_SLIDES ? ` shown, capped at ${PPTX_PREVIEW_MAX_SLIDES}` : ''}
              </div>
              {pptxPreview.map((slide) => (
                <section
                  key={slide.slideNumber}
                  className={`rounded-lg border p-4 shadow-sm ${
                    colorMode === 'dark'
                      ? 'border-slate-800 bg-slate-900'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className={`mb-3 text-xs font-medium ${colorMode === 'dark' ? 'text-slate-400' : 'text-gray-500'}`}>
                    Slide {slide.slideNumber}
                  </div>
                  <h3 className={`mb-3 text-base font-semibold ${colorMode === 'dark' ? 'text-slate-100' : 'text-gray-900'}`}>
                    {slide.title}
                  </h3>
                  {slide.lines.length > 0 ? (
                    <div className={`space-y-2 text-sm leading-6 ${colorMode === 'dark' ? 'text-slate-200' : 'text-gray-700'}`}>
                      {slide.lines.map((line, index) => (
                        <p key={`${slide.slideNumber}-${index}`} className="whitespace-pre-wrap break-words">
                          {line}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className={`text-sm ${colorMode === 'dark' ? 'text-slate-400' : 'text-gray-500'}`}>
                      No text on this slide.
                    </p>
                  )}
                </section>
              ))}
            </div>
          </div>
        </div>
      );
    }
    if (isOfficeFile) {
      const officeKind = getOfficeDocumentKind(file?.name || '', file?.mimeType);
      const embedSrc = officeOnlineEmbedUrl(file?.publicUrl ?? null);
      if (embedSrc) {
        return (
          <div className="relative flex h-full min-h-0 flex-col">
            <div
              className={`border-b px-4 py-2 text-xs ${
                colorMode === 'dark'
                  ? 'border-slate-700 text-slate-400'
                  : 'border-gray-200 text-gray-500'
              }`}
            >
              <span className={`font-medium ${colorMode === 'dark' ? 'text-slate-200' : 'text-gray-700'}`}>
                {officeKind} preview
              </span>
              {' · '}
              Via Microsoft Office Online (requires a public HTTPS file URL).
            </div>
            <iframe
              title={file.name}
              src={embedSrc}
              className="min-h-0 w-full flex-1 border-none"
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          </div>
        );
      }
      const fallbackMimeType = isPptxFile
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : isSpreadsheetFile
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/octet-stream';
      return (
        <div
          className={`flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-sm ${
            colorMode === 'dark' ? 'text-slate-300' : 'text-gray-600'
          }`}
        >
          <p>
            Inline {officeKind.toLowerCase()} preview needs a public{' '}
            <strong className="font-semibold">https</strong> URL to your file. Download it and open it
            locally, or use a workspace with public file URLs.
          </p>
          {fileContent.trim() ? (
            <button
              type="button"
              onClick={() => downloadBinaryFile(fallbackMimeType, file?.name || 'office-file')}
              className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${
                colorMode === 'dark'
                  ? 'bg-slate-600 hover:bg-slate-500'
                  : 'bg-slate-800 hover:bg-slate-700'
              }`}
            >
              Download file
            </button>
          ) : null}
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

      return renderTabularPreview(
        'Parquet preview',
        parquetPreview,
        PARQUET_PREVIEW_MAX_ROWS,
        PARQUET_PREVIEW_MAX_COLUMNS,
      );
    }
    return <pre className="whitespace-pre-wrap break-words">{fileContent}</pre>;
  };

  return <div className="h-full w-full">{renderContent()}</div>;
};

export default FileRenderer;

/* eslint-disable react-refresh/only-export-components */
import { Children, Suspense, isValidElement, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import { getWorkspaceFilePreview } from '../../services/fileApi';
import type { PlotlySpec } from '../PlotlyChart';

const PlotlyChart = lazy(() => import('../PlotlyChart'));

let mermaidRuntimePromise: Promise<typeof import('mermaid')> | null = null;

const loadMermaidRuntime = async () => {
  if (!mermaidRuntimePromise) {
    mermaidRuntimePromise = import('mermaid');
  }
  return mermaidRuntimePromise;
};

export type MermaidColorMode = 'light' | 'dark';

type WorkspaceImagePreview = {
  mimeType?: string | null;
  encoding: 'text' | 'base64';
  content: string;
};

type MarkdownComponentOptions = {
  workspaceId?: string;
  colorMode: MermaidColorMode;
  codeBlockClassName?: string;
  inlineCodeClassName?: string;
  imageClassName?: string;
  paragraphClassName?: string;
  enablePlotly?: boolean;
  codeBlockShell?: (args: {
    blockId: string;
    codeContent: string;
    languageLabel: string;
    className?: string;
    children: ReactNode;
  }) => ReactNode;
};

const BLOCK_LEVEL_TAGS = ['div', 'pre', 'table', 'blockquote', 'ul', 'ol', 'hr'];

const buildMermaidTheme = (mode: MermaidColorMode) => (
  mode === 'dark'
    ? {
        background: '#0f172a',
        primaryColor: '#818cf8',
        primaryBorderColor: '#6366f1',
        primaryTextColor: '#e2e8f0',
        secondaryColor: '#1e293b',
        secondaryBorderColor: '#334155',
        secondaryTextColor: '#cbd5e1',
        tertiaryColor: '#111827',
        tertiaryBorderColor: '#374151',
        tertiaryTextColor: '#cbd5e1',
        lineColor: '#94a3b8',
        textColor: '#e2e8f0',
        mainBkg: '#0b1220',
        edgeLabelBackground: '#0b1220',
        actorBorder: '#6366f1',
        actorBkg: '#1e293b',
        actorTextColor: '#e2e8f0',
        labelBoxBkgColor: '#1e293b',
        labelBoxBorderColor: '#334155',
        gridColor: '#334155',
        section0: '#1e293b',
        section1: '#1f2937',
        section2: '#0f172a',
        sectionBkgColor: '#111827',
        cScale0: '#818cf8',
        cScale1: '#60a5fa',
        cScale2: '#34d399',
      }
    : {
        background: '#ffffff',
        primaryColor: '#4f46e5',
        primaryBorderColor: '#3730a3',
        primaryTextColor: '#0f172a',
        secondaryColor: '#dbeafe',
        secondaryBorderColor: '#93c5fd',
        secondaryTextColor: '#0f172a',
        tertiaryColor: '#eef2ff',
        tertiaryBorderColor: '#a5b4fc',
        tertiaryTextColor: '#0f172a',
        lineColor: '#334155',
        textColor: '#0f172a',
        mainBkg: '#ffffff',
        edgeLabelBackground: '#f8fafc',
        actorBorder: '#3730a3',
        actorBkg: '#c7d2fe',
        actorTextColor: '#0f172a',
        labelBoxBkgColor: '#f8fafc',
        labelBoxBorderColor: '#94a3b8',
        gridColor: '#cbd5e1',
        section0: '#e0e7ff',
        section1: '#f1f5f9',
        section2: '#e2e8f0',
        sectionBkgColor: '#f8fafc',
        cScale0: '#3730a3',
        cScale1: '#1d4ed8',
        cScale2: '#0f766e',
      }
);

export const normalizeWorkspaceRelativePath = (rawPath: string) => (
  String(rawPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
);

export const getMermaidColorMode = (): MermaidColorMode => {
  if (typeof document === 'undefined') {
    return 'light';
  }
  const mode = document.documentElement.getAttribute('data-theme');
  if (mode === 'dark' || mode === 'light') {
    return mode;
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export const useMermaidColorMode = () => {
  const [colorMode, setColorMode] = useState<MermaidColorMode>(() => getMermaidColorMode());

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setColorMode(getMermaidColorMode());
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      observer.disconnect();
    };
  }, []);

  return colorMode;
};

export const configureMermaid = async (mode: MermaidColorMode) => {
  const mermaid = (await loadMermaidRuntime()).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'base',
    themeVariables: buildMermaidTheme(mode),
    fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
  });
  return mermaid;
};

export const extractCodeText = (value: ReactNode): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map((child) => extractCodeText(child)).join('');
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return '';
};

export const inferInlineCode = (
  inline: boolean | undefined,
  className: string | undefined,
  content: string,
  node?: { position?: { start?: { line?: number }; end?: { line?: number } } }
) => {
  if (typeof inline === 'boolean') {
    return inline;
  }
  const startLine = node?.position?.start?.line;
  const endLine = node?.position?.end?.line;
  if (typeof startLine === 'number' && typeof endLine === 'number' && endLine > startLine) {
    return false;
  }
  if (className && /language-\w+/i.test(className)) {
    return false;
  }
  if (content.includes('\n')) {
    return false;
  }
  return true;
};

export const classifyCodeBlockLabel = (languageMatch: RegExpExecArray | null, content: string) => {
  const language = languageMatch?.[1]?.toUpperCase();
  if (language) {
    return language;
  }
  const trimmed = content.trim();
  if (!trimmed) {
    return 'TEXT';
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'JSON';
  }
  if (/^(graph|flowchart|sequenceDiagram|classDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|stateDiagram|quadrantChart|requirementDiagram|xychart-beta|block-beta)\b/i.test(trimmed)) {
    return 'MERMAID';
  }
  return 'CODE';
};

const isExternalSource = (src: string) => /^(https?:|data:|blob:)/i.test(src);

const MermaidFallback = ({
  chart,
  colorMode,
}: {
  chart: string;
  colorMode: MermaidColorMode;
}) => (
  <pre className={`my-4 overflow-x-auto rounded-2xl border p-4 text-sm ${colorMode === 'dark'
    ? 'border-rose-500/20 bg-rose-950/20 text-slate-200'
    : 'border-rose-200 bg-rose-50 text-rose-700'}`}>
    {chart}
  </pre>
);

export const MermaidDiagram = ({
  chart,
  colorMode,
  className,
  fallbackClassName,
}: {
  chart: string;
  colorMode: MermaidColorMode;
  className?: string;
  fallbackClassName?: string;
}) => {
  const diagramRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mermaid-md-${Math.random().toString(36).slice(2, 11)}`);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const renderDiagram = async () => {
      if (!diagramRef.current) {
        return;
      }
      try {
        setErrorMessage(null);
        diagramRef.current.innerHTML = '';
        const mermaid = await configureMermaid(colorMode);
        await mermaid.parse(chart);
        const renderId = `${idRef.current}-${Date.now()}`;
        const { svg } = await mermaid.render(renderId, chart);
        if (!cancelled && diagramRef.current) {
          diagramRef.current.innerHTML = svg;
        }
      } catch (error) {
        console.error('Mermaid rendering error:', error);
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : 'Unable to render Mermaid diagram.');
        }
      }
    };

    void renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [chart, colorMode]);

  if (errorMessage) {
    return (
      <div className={fallbackClassName}>
        <p className={`mb-2 text-sm font-medium ${colorMode === 'dark' ? 'text-rose-300' : 'text-rose-600'}`}>
          Unable to render Mermaid diagram.
        </p>
        <MermaidFallback chart={chart} colorMode={colorMode} />
      </div>
    );
  }

  return (
    <div
      ref={diagramRef}
      className={className || `mermaid-container my-4 overflow-auto rounded-xl border p-4 ${colorMode === 'dark' ? 'border-slate-700 bg-slate-950' : 'border-gray-200 bg-white'}`}
    />
  );
};

export const WorkspaceMarkdownImage = ({
  src,
  alt,
  workspaceId,
  className,
}: {
  src?: string;
  alt?: string;
  workspaceId?: string;
  className?: string;
}) => {
  const resolvedSrc = typeof src === 'string' ? src.trim() : '';
  const [preview, setPreview] = useState<WorkspaceImagePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!resolvedSrc || isExternalSource(resolvedSrc) || !workspaceId) {
      setPreview(null);
      setLoadError(null);
      return undefined;
    }

    const loadPreview = async () => {
      try {
        setLoadError(null);
        const data = await getWorkspaceFilePreview(workspaceId, normalizeWorkspaceRelativePath(resolvedSrc));
        if (!cancelled) {
          setPreview(data as WorkspaceImagePreview);
        }
      } catch (error) {
        console.error('Failed to resolve markdown image path:', error);
        if (!cancelled) {
          setLoadError(resolvedSrc);
          setPreview(null);
        }
      }
    };

    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [resolvedSrc, workspaceId]);

  if (!resolvedSrc) {
    return null;
  }

  if (isExternalSource(resolvedSrc)) {
    return (
      <img
        className={className || 'max-w-full h-auto rounded-lg shadow-md'}
        loading="lazy"
        src={resolvedSrc}
        alt={alt || 'Image'}
      />
    );
  }

  if (!workspaceId) {
    return (
      <span className="text-xs text-slate-500">
        Image path: <code>{resolvedSrc}</code>
      </span>
    );
  }

  if (preview?.content) {
    const previewSrc = preview.encoding === 'base64'
      ? `data:${preview.mimeType || 'image/*'};base64,${preview.content}`
      : preview.content;
    return (
      <img
        className={className || 'max-w-full h-auto rounded-lg shadow-md'}
        loading="lazy"
        src={previewSrc}
        alt={alt || 'Image'}
      />
    );
  }

  if (loadError) {
    return (
      <span className="text-xs text-rose-600">
        Unable to load image: <code>{loadError}</code>
      </span>
    );
  }

  return <span className="text-xs text-slate-500">Loading image...</span>;
};

export const createMarkdownComponents = ({
  workspaceId,
  colorMode,
  codeBlockClassName = 'my-4 overflow-x-auto rounded-xl bg-gray-900 p-4 text-sm text-gray-100',
  inlineCodeClassName = 'inline-code rounded-md px-1.5 py-0.5 font-mono text-xs',
  imageClassName = 'max-w-full h-auto rounded-lg shadow-md',
  paragraphClassName = 'mb-4 last:mb-0',
  enablePlotly = true,
  codeBlockShell,
}: MarkdownComponentOptions): Components => ({
  p({ children }) {
    const childArray = Children.toArray(children);
    const containsBlockChild = childArray.some((child) => {
      if (!isValidElement(child)) {
        return false;
      }
      const childProps = child.props as {
        inline?: boolean;
        node?: { tagName?: string; position?: { start?: { line?: number }; end?: { line?: number } } };
        className?: string;
        children?: ReactNode;
      };
      if (typeof child.type === 'string') {
        return BLOCK_LEVEL_TAGS.includes(child.type);
      }
      if (childProps.inline === false) {
        return true;
      }
      if (childProps.node?.tagName && BLOCK_LEVEL_TAGS.includes(childProps.node.tagName)) {
        return true;
      }
      if (childProps.node?.tagName === 'code') {
        return !inferInlineCode(
          childProps.inline,
          childProps.className,
          extractCodeText(childProps.children),
          childProps.node
        );
      }
      return false;
    });
    const Element: 'p' | 'div' = containsBlockChild ? 'div' : 'p';
    return <Element className={paragraphClassName}>{children}</Element>;
  },
  img({ src, alt }) {
    return (
      <WorkspaceMarkdownImage
        src={src}
        alt={alt}
        workspaceId={workspaceId}
        className={imageClassName}
      />
    );
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  code({ inline, className, children, node, ...props }: any) {
    const codeContent = extractCodeText(children).replace(/\n$/, '');
    const isInline = inferInlineCode(inline, className, codeContent, node);

    if (isInline) {
      return (
        <code className={`${inlineCodeClassName} ${className || ''}`.trim()} {...props}>
          {children}
        </code>
      );
    }

    const languageMatch = /language-(\w[\w-]*)/.exec(className || '');
    const language = languageMatch?.[1]?.toLowerCase();

    if (language === 'mermaid') {
      return (
        <MermaidDiagram
          chart={codeContent}
          colorMode={colorMode}
          fallbackClassName="my-4"
        />
      );
    }

    if (enablePlotly && language === 'plotly') {
      try {
        const spec = JSON.parse(codeContent) as PlotlySpec;
        if (!spec || typeof spec !== 'object' || !Array.isArray(spec.data)) {
          throw new Error('Plotly spec must include a top-level "data" array.');
        }
        return (
          <div className="my-4 overflow-hidden rounded-xl border border-gray-200 bg-white p-2">
            <Suspense fallback={<div className="flex min-h-[360px] items-center justify-center text-sm text-slate-500">Loading chart…</div>}>
              <PlotlyChart spec={spec} minHeight={360} />
            </Suspense>
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

    const languageLabel = classifyCodeBlockLabel(languageMatch, codeContent);
    const blockId = `${languageLabel}-${codeContent.length}-${codeContent.charCodeAt(0) || 0}`;

    if (codeBlockShell) {
      return codeBlockShell({
        blockId,
        codeContent,
        languageLabel,
        className,
        children,
      });
    }

    return (
      <pre className={codeBlockClassName}>
        <code className={`font-mono ${className || ''}`.trim()} {...props}>
          {children}
        </code>
      </pre>
    );
  },
});

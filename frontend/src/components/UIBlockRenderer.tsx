import React from 'react';
import type { File } from '../types';
import FileRenderer from './FileRenderer';
import PlotlyChart, { type PlotlySpec } from './PlotlyChart';

type BlockId = string | number;

export type UIBlock =
  | { kind: 'file'; id?: BlockId; file: File; content: string }
  | { kind: 'markdown'; id?: BlockId; content: string; name?: string }
  | { kind: 'html'; id?: BlockId; content: string; name?: string }
  | { kind: 'plotly'; id?: BlockId; spec: PlotlySpec; title?: string }
  | { kind: 'text'; id?: BlockId; content: string; name?: string };

interface UIBlockRendererProps {
  blocks: UIBlock[];
  className?: string;
  emptyState?: React.ReactNode;
}

const createVirtualFile = (name: string, id?: BlockId): File => ({
  id: id ? String(id) : `virtual-${name}`,
  name,
});

const getBlockKey = (block: UIBlock, index: number) =>
  block.id ? String(block.id) : `${block.kind}-${index}`;

const UIBlockRenderer: React.FC<UIBlockRendererProps> = ({ blocks, className, emptyState }) => {
  const containerClassName = [className ?? 'h-full w-full', blocks.length > 1 ? 'space-y-4' : '']
    .filter(Boolean)
    .join(' ');

  if (blocks.length === 0) {
    return <div className={containerClassName}>{emptyState ?? null}</div>;
  }

  return (
    <div className={containerClassName}>
      {blocks.map((block, index) => {
        const key = getBlockKey(block, index);
        switch (block.kind) {
          case 'file':
            return (
              <div key={key} className="h-full w-full">
                <FileRenderer
                  file={block.file}
                  fileContent={block.content}
                  disableInternalScroll
                />
              </div>
            );
          case 'markdown':
            return (
              <div key={key} className="h-full w-full">
                <FileRenderer
                  file={createVirtualFile(block.name ?? 'block.md', block.id)}
                  fileContent={block.content}
                  disableInternalScroll
                />
              </div>
            );
          case 'html':
            return (
              <div key={key} className="h-full w-full">
                <FileRenderer
                  file={createVirtualFile(block.name ?? 'block.html', block.id)}
                  fileContent={block.content}
                />
              </div>
            );
          case 'plotly':
            return (
              <div key={key} className="h-full w-full">
                <PlotlyChart spec={block.spec} />
              </div>
            );
          case 'text':
            return (
              <pre key={key} className="whitespace-pre-wrap break-words">
                {block.content}
              </pre>
            );
          default:
            return (
              <div key={key} className="text-sm text-gray-500">
                Unsupported block type.
              </div>
            );
        }
      })}
    </div>
  );
};

export default UIBlockRenderer;

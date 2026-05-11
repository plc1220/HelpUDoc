import { X } from 'lucide-react';
import {
  PAPER2SLIDES_STAGE_ORDER,
  PAPER2SLIDES_STYLE_PRESETS,
} from '../../../constants/workspace';
import type { PresentationOptionsState } from '../types';

type PresentationModalProps = {
  isOpen: boolean;
  draft: PresentationOptionsState | null;
  onChange: <K extends keyof PresentationOptionsState>(key: K, value: PresentationOptionsState[K]) => void;
  onClose: () => void;
  onSave: () => void;
};

export default function PresentationModal({
  isOpen,
  draft,
  onChange,
  onClose,
  onSave,
}: PresentationModalProps) {
  if (!isOpen || !draft) {
    return null;
  }
  const showCustomStyle = draft.stylePreset === 'custom';

  const selectClass =
    'w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800';
  const labelClass = 'flex flex-col gap-1 text-xs font-semibold text-slate-600';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Configure Paper2Slides</p>
            <p className="text-xs text-slate-500">Choose output, style, and pipeline controls.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-500 hover:bg-slate-100"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <label className={labelClass}>
            <span>Output</span>
            <select
              className={selectClass}
              value={draft.output}
              onChange={(event) => onChange('output', event.target.value as PresentationOptionsState['output'])}
            >
              <option value="slides">Slides</option>
              <option value="poster">Poster</option>
            </select>
          </label>
          <label className={labelClass}>
            <span>Length</span>
            <select
              className={selectClass}
              value={draft.length}
              onChange={(event) => onChange('length', event.target.value as PresentationOptionsState['length'])}
            >
              <option value="short">Short</option>
              <option value="medium">Medium</option>
              <option value="long">Long</option>
            </select>
          </label>
          <label className={labelClass}>
            <span>Mode</span>
            <select
              className={selectClass}
              value={draft.mode}
              onChange={(event) => onChange('mode', event.target.value as PresentationOptionsState['mode'])}
            >
              <option value="fast">Fast</option>
              <option value="normal">Normal</option>
            </select>
          </label>
          <label className={labelClass}>
            <span>Style</span>
            <select
              className={selectClass}
              value={draft.stylePreset}
              onChange={(event) =>
                onChange('stylePreset', event.target.value as PresentationOptionsState['stylePreset'])
              }
            >
              {PAPER2SLIDES_STYLE_PRESETS.map((style) => (
                <option key={style} value={style}>
                  {style === 'custom' ? 'Custom prompt' : style.charAt(0).toUpperCase() + style.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            <span>Content</span>
            <select
              className={selectClass}
              value={draft.content}
              onChange={(event) => onChange('content', event.target.value as PresentationOptionsState['content'])}
            >
              <option value="paper">Paper</option>
              <option value="general">General</option>
            </select>
          </label>
          <label className={labelClass}>
            <span>Parallel</span>
            <input
              type="number"
              min={1}
              className={selectClass}
              value={draft.parallel}
              onChange={(event) => onChange('parallel', Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
          <label className={labelClass}>
            <span>Restart from</span>
            <select
              className={selectClass}
              value={draft.fromStage || ''}
              onChange={(event) =>
                onChange('fromStage', event.target.value ? (event.target.value as PresentationOptionsState['fromStage']) : undefined)
              }
            >
              <option value="">Auto</option>
              {PAPER2SLIDES_STAGE_ORDER.map((stage) => (
                <option key={stage} value={stage}>
                  {stage === 'rag' ? 'RAG' : stage.charAt(0).toUpperCase() + stage.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs font-semibold text-slate-600">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-blue-600"
              checked={draft.exportPptx}
              onChange={(event) => onChange('exportPptx', event.target.checked)}
            />
            <span>Export PPTX (slow)</span>
          </label>
          <span className="text-[11px] text-slate-500">Run after slide render. You can also export later from a PDF.</span>
        </div>
        {showCustomStyle && (
          <div className="mt-3">
            <label className="text-xs font-semibold text-slate-600">Style prompt</label>
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800"
              placeholder="e.g., Studio Ghibli watercolor with warm tones"
              value={draft.customStyle}
              onChange={(event) => onChange('customStyle', event.target.value)}
            />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

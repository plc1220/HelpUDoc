import React, { useState, useEffect, useMemo } from 'react';
import { Check, CheckCircle2, ImageIcon, Loader2 } from 'lucide-react';
import { buildApiUrl } from '../services/apiClient';

type A2UIDecision = 'approve' | 'edit' | 'reject' | 'submit' | 'cancel';

type A2UIQuestionOption = {
  value?: string;
  label?: string;
  description?: string;
};

type A2UIQuestion = {
  id: string;
  header?: string;
  title?: string;
  question?: string;
  options?: Array<A2UIQuestionOption | string>;
  placeholder?: string;
};

type A2UIChoice = {
  id?: string;
  choiceId?: string;
  label?: string;
  name?: string;
  title?: string;
  value?: string;
  description?: string;
  summary?: string;
  path?: string;
  file?: string;
  filePath?: string;
  previewPath?: string;
  html?: string;
  srcDoc?: string;
  srcdoc?: string;
  content?: string;
};

type A2UIAction = {
  id?: string;
  label?: string;
  value?: string;
  payload?: Record<string, unknown>;
  inputMode?: 'none' | 'text' | string;
  style?: 'primary' | 'danger' | string;
  placeholder?: string;
  submitLabel?: string;
};

type A2UIPlanStep = {
  state?: string;
  status?: string;
  title?: string;
  label?: string;
  description?: string;
  detail?: string;
};

export interface A2UIComponentProps {
  props: Record<string, unknown>;
  onSubmit: (payload: {
    actionId: string;
    values?: Record<string, unknown>;
    decision?: A2UIDecision;
    message?: string;
    metadata?: Record<string, unknown>;
  }) => void;
  isSubmitting?: boolean;
  error?: string;
  workspaceId?: string;
  colorMode?: 'light' | 'dark';
}

// 1. Clarification Form Component (clarification.form)
export const ClarificationForm: React.FC<A2UIComponentProps> = ({
  props,
  onSubmit,
  isSubmitting = false,
  error,
}) => {
  const questions = useMemo<A2UIQuestion[]>(
    () => (Array.isArray(props.questions)
      ? props.questions.filter((item): item is A2UIQuestion => Boolean(item && typeof item === 'object' && 'id' in item))
      : []),
    [props.questions],
  );
  const submitLabel = String(props.submitLabel || 'Submit answers');

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [wizardStep, setWizardStep] = useState(0);

  const isMultiStep = questions.length > 1;

  const currentQuestion = isMultiStep && wizardStep < questions.length ? questions[wizardStep] : null;
  const isReviewStep = isMultiStep && wizardStep >= questions.length;

  const isComplete = useMemo(() => {
    if (questions.length === 0) return true;
    return questions.every((q) => {
      const ans = answers[q.id]?.trim();
      return ans && ans.length > 0;
    });
  }, [questions, answers]);

  const supportingText = String(
    props.outlineMarkdown ||
      props.slideOutline ||
      props.outline ||
      props.previewMarkdown ||
      props.contextMarkdown ||
      props.markdown ||
      props.summary ||
      '',
  ).trim();

  const supportingLabel = String(props.previewLabel || props.contextLabel || 'Review material');

  const renderSupportingText = () => {
    if (!supportingText) return null;
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          {supportingLabel}
        </span>
        <div className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm leading-relaxed text-slate-800 whitespace-pre-wrap">
          {supportingText}
        </div>
      </div>
    );
  };

  const handleNext = () => {
    if (currentQuestion) {
      const currentAns = answers[currentQuestion.id]?.trim();
      if (!currentAns) return;
    }
    setWizardStep((prev) => Math.min(questions.length, prev + 1));
  };

  const handleBack = () => {
    setWizardStep((prev) => Math.max(0, prev - 1));
  };

  const handleSubmit = () => {
    onSubmit({
      actionId: 'submit',
      values: {
        answers,
        notes,
      },
      decision: 'submit',
    });
  };

  if (questions.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-center text-slate-500">
        No questions provided.
      </div>
    );
  }

  const renderQuestionEditor = (q: A2UIQuestion) => {
    const currentAns = answers[q.id] || '';
    const options = Array.isArray(q.options) ? q.options : [];

    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 shadow-sm">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            {q.header || q.title || 'Question'}
          </span>
          <p className="mt-1 text-sm font-semibold text-slate-800">{q.question}</p>

          {options.length > 0 && (
            <div className="mt-3 grid gap-2">
              {options.map((opt) => {
                const optVal = String(typeof opt === 'string' ? opt : opt.value || opt.label || '');
                const optLabel = String(typeof opt === 'string' ? opt : opt.label || optVal);
                const optDescription = typeof opt === 'string' ? '' : opt.description;
                const isSelected = currentAns === optVal;
                return (
                  <button
                    key={optVal}
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: optVal }))}
                    className={`w-full rounded-lg border px-4 py-3 text-left transition-all duration-200 ${
                      isSelected
                        ? 'border-sky-400 bg-sky-50 text-sky-900 shadow-[0_0_0_1px_rgba(14,165,233,0.15)] font-medium'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <span>{optLabel}</span>
                    {optDescription && (
                      <span className="mt-1 block text-xs font-normal text-slate-500 leading-normal">
                        {optDescription}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-4">
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1.5">
              Your detailed response
            </label>
            <textarea
              rows={options.length > 0 ? 3 : 5}
              disabled={isSubmitting}
              value={currentAns}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
              placeholder="Provide details or write-in your custom answer..."
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400/30"
            />
          </div>
        </div>
      </div>
    );
  };

  if (isMultiStep) {
    if (isReviewStep) {
      const answeredCount = questions.filter((q) => answers[q.id]?.trim()).length;
      return (
        <div className="space-y-4">
          {renderSupportingText()}

          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Review Answers</span>
              <span className="rounded-full bg-slate-200/60 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                {answeredCount}/{questions.length} answered
              </span>
            </div>

            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-sky-500 transition-all duration-300" style={{ width: '100%' }} />
            </div>

            <div className="mt-4 space-y-3 max-h-60 overflow-y-auto pr-1">
              {questions.map((q) => (
                <div key={q.id} className="rounded-lg border border-slate-100 bg-white p-3 shadow-sm">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{q.header || q.title || 'Question'}</span>
                  <p className="text-xs font-semibold text-slate-700 mt-0.5">{q.question}</p>
                  <p className="text-sm font-medium text-slate-900 mt-1.5 bg-slate-50 p-2 rounded border border-slate-100/50">
                    {answers[q.id] || 'Not answered'}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-4">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1.5">
                Additional notes or guidelines for the agent
              </label>
              <textarea
                rows={3}
                disabled={isSubmitting}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Any special requests or constraints before the agent generates slide outputs..."
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400/30"
              />
            </div>
          </div>

          {error && <div className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-100 p-2.5 rounded-lg">{error}</div>}

          <div className="flex justify-between items-center">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={handleBack}
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
            >
              Back
            </button>
            <button
              type="button"
              disabled={isSubmitting || !isComplete}
              onClick={handleSubmit}
              className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition shadow flex items-center gap-1.5"
            >
              {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : null}
              {submitLabel}
            </button>
          </div>
        </div>
      );
    }

    const progress = ((wizardStep + 1) / (questions.length + 1)) * 100;
    const answeredCount = questions.filter((q) => answers[q.id]?.trim()).length;

    return (
      <div className="space-y-4">
        {renderSupportingText()}

        <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Question {wizardStep + 1} of {questions.length}
            </span>
            <span className="rounded-full bg-slate-200/60 px-2.5 py-0.5 text-xs font-medium text-slate-600">
              {answeredCount}/{questions.length} answered
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-sky-500 transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
        </div>

        {currentQuestion && renderQuestionEditor(currentQuestion)}

        {error && <div className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-100 p-2.5 rounded-lg">{error}</div>}

        <div className="flex justify-between items-center">
          <button
            type="button"
            disabled={isSubmitting || wizardStep === 0}
            onClick={handleBack}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Back
          </button>
          <button
            type="button"
            disabled={isSubmitting || !answers[currentQuestion?.id || '']?.trim()}
            onClick={handleNext}
            className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-600 transition shadow"
          >
            {wizardStep === questions.length - 1 ? 'Review answers' : 'Next'}
          </button>
        </div>
      </div>
    );
  }

  // Single Question Form
  const singleQ = questions[0];
  return (
    <div className="space-y-4">
      {renderSupportingText()}

      {renderQuestionEditor(singleQ)}

      <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 shadow-sm">
        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1.5">
          Additional notes
        </label>
        <textarea
          rows={3}
          disabled={isSubmitting}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add any extra context that should travel with your answers..."
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 focus:border-sky-400 focus:outline-none"
        />
      </div>

      {error && <div className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-100 p-2.5 rounded-lg">{error}</div>}

      <div className="flex justify-end">
        <button
          type="button"
          disabled={isSubmitting || !isComplete}
          onClick={handleSubmit}
          className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition shadow flex items-center gap-1.5"
        >
          {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : null}
          {submitLabel}
        </button>
      </div>
    </div>
  );
};

const normalizeStylePreviewKey = (value: string): string => (
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
);

const asStylePreviewChoices = (value: unknown): A2UIChoice[] => (
  Array.isArray(value)
    ? value.filter((item): item is A2UIChoice => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : []
);

const getChoiceText = (choice: Partial<A2UIChoice>, keys: Array<keyof A2UIChoice>): string => {
  for (const key of keys) {
    const value = choice[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

const escapeHtmlText = (value: string): string => (
  value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] || char))
);

const buildFallbackStylePreviewHtml = (item: {
  id: string;
  label: string;
  description?: string;
}): string => {
  const paletteById: Record<string, { bg: string; fg: string; accent: string; panel: string; muted: string }> = {
    'style-a': { bg: '#f8fafc', fg: '#0f172a', accent: '#0ea5e9', panel: '#ffffff', muted: '#475569' },
    'style-b': { bg: '#07111f', fg: '#f8fafc', accent: '#22c55e', panel: '#0f172a', muted: '#cbd5e1' },
    'style-c': { bg: '#fff7ed', fg: '#1f2937', accent: '#f97316', panel: '#ffffff', muted: '#64748b' },
  };
  const palette = paletteById[item.id] || paletteById['style-a'];
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
    body { font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif; background: ${palette.bg}; color: ${palette.fg}; }
    .slide { width: 100vw; height: 100vh; display: grid; grid-template-columns: 1.1fr .9fr; gap: 5vw; align-items: center; padding: 9vh 8vw; }
    .eyebrow { color: ${palette.accent}; font: 800 14px/1.1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 18px 0 22px; max-width: 920px; font-size: clamp(52px, 8vw, 112px); line-height: .9; letter-spacing: 0; }
    p { margin: 0; max-width: 680px; color: ${palette.muted}; font: 500 clamp(20px, 2.1vw, 32px)/1.28 ui-sans-serif, system-ui, sans-serif; }
    .card { min-height: 52vh; border: 2px solid ${palette.accent}; background: ${palette.panel}; display: grid; align-content: end; padding: 5vw; box-shadow: 18px 18px 0 ${palette.accent}; }
    .number { font: 900 clamp(72px, 10vw, 150px)/.85 ui-sans-serif, system-ui, sans-serif; color: ${palette.accent}; }
    .label { margin-top: 16px; color: ${palette.muted}; font: 800 16px/1.2 ui-sans-serif, system-ui, sans-serif; text-transform: uppercase; letter-spacing: .12em; }
  </style>
</head>
<body>
  <main class="slide">
    <section>
      <div class="eyebrow">Presentation direction</div>
      <h1>${escapeHtmlText(item.label)}</h1>
      <p>${escapeHtmlText(item.description || 'A generated direction for the full presentation design.')}</p>
    </section>
    <aside class="card">
      <div class="number">01</div>
      <div class="label">Title slide</div>
    </aside>
  </main>
</body>
</html>`;
};

const buildStylePreviewMetadata = (sources: unknown[]) => {
  const metadata = new Map<string, Partial<A2UIChoice>>();
  sources
    .flatMap((source) => asStylePreviewChoices(source))
    .forEach((item, index) => {
      const id = getChoiceText(item, ['id', 'choiceId']) || `choice-${index + 1}`;
      const label = getChoiceText(item, ['label', 'name', 'title']);
      const value = getChoiceText(item, ['value']) || label;
      [id, label, value].forEach((key) => {
        const normalizedKey = normalizeStylePreviewKey(key);
        if (normalizedKey) {
          metadata.set(normalizedKey, item);
        }
      });
    });
  return metadata;
};

const getStylePreviewUrl = (
  workspaceId: string | undefined,
  path: string,
  options?: { inline?: boolean },
): string | undefined => {
  if (!workspaceId || !path.trim()) {
    return undefined;
  }
  const url = buildApiUrl(`/workspaces/${workspaceId}/files/preview/raw`);
  url.searchParams.set('path', path.trim());
  if (options?.inline) {
    url.searchParams.set('disposition', 'inline');
  }
  return url.toString();
};

// 2. Style Preview Chooser Component (style.previewChooser)
export const StylePreviewChooser: React.FC<A2UIComponentProps> = ({
  props,
  onSubmit,
  isSubmitting = false,
  workspaceId,
}) => {
  const propsChoices = props.choices;
  const propsPreviews = props.previews;
  const propsStylePreviews = props.stylePreviews;
  const propsPreviewStyles = props.previewStyles;
  const propsPreviewFiles = props.previewFiles;

  const choices = useMemo<A2UIChoice[]>(
    () => {
      for (const source of [propsChoices, propsPreviews, propsStylePreviews, propsPreviewStyles, propsPreviewFiles]) {
        const candidates = asStylePreviewChoices(source);
        if (candidates.length) {
          return candidates;
        }
      }
      return [];
    },
    [propsChoices, propsPreviews, propsStylePreviews, propsPreviewStyles, propsPreviewFiles],
  );
  const previewMetadata = useMemo(
    () => buildStylePreviewMetadata([propsPreviews, propsStylePreviews, propsPreviewStyles, propsPreviewFiles, propsChoices]),
    [propsChoices, propsPreviews, propsStylePreviews, propsPreviewStyles, propsPreviewFiles],
  );
  const multiple = Boolean(props.multiple);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activePreviewId, setActiveStylePreviewId] = useState<string | null>(null);

  // Parse styles with preview files
  const items = useMemo(() => {
    return choices.map((c, idx: number) => {
      const id = String(c.id || c.choiceId || `choice-${idx + 1}`);
      const choiceLabel = getChoiceText(c, ['label', 'name', 'title']);
      const choiceValue = getChoiceText(c, ['value']) || choiceLabel;
      const matchingMetadata =
        previewMetadata.get(normalizeStylePreviewKey(id)) ||
        previewMetadata.get(normalizeStylePreviewKey(choiceLabel)) ||
        previewMetadata.get(normalizeStylePreviewKey(choiceValue)) ||
        {};
      const label = choiceLabel || getChoiceText(matchingMetadata, ['label', 'name', 'title']) || `Option ${idx + 1}`;
      const value = choiceValue || getChoiceText(matchingMetadata, ['value']) || label;
      const description = getChoiceText(c, ['description', 'summary']) || getChoiceText(matchingMetadata, ['description', 'summary']);
      const path = getChoiceText(c, ['path', 'file', 'filePath', 'previewPath']) || getChoiceText(matchingMetadata, ['path', 'file', 'filePath', 'previewPath']);
      const payloadHtml = getChoiceText(c, ['html', 'srcDoc', 'srcdoc', 'content']) || getChoiceText(matchingMetadata, ['html', 'srcDoc', 'srcdoc', 'content']);
      const html = payloadHtml || (path ? '' : buildFallbackStylePreviewHtml({ id, label, description }));

      let previewUrl: string | undefined = undefined;
      let downloadUrl: string | undefined = undefined;
      const isHtmlPreview = Boolean(path && /\.html?$/i.test(path)) || Boolean(html);

      if (!html && path && workspaceId) {
        previewUrl = getStylePreviewUrl(workspaceId, path, { inline: isHtmlPreview });
        downloadUrl = getStylePreviewUrl(workspaceId, path);
      }

      return {
        id,
        label,
        value,
        description,
        path,
        html,
        previewUrl,
        downloadUrl,
        isHtmlPreview,
      };
    });
  }, [choices, previewMetadata, workspaceId]);

  const activeItem = useMemo(() => {
    if (items.length === 0) return null;
    return items.find((i) => i.id === activePreviewId) || items.find((i) => selectedIds.includes(i.id)) || items[0];
  }, [items, activePreviewId, selectedIds]);

  useEffect(() => {
    if (items.length > 0 && !activePreviewId) {
      setActiveStylePreviewId(items[0].id);
    }
  }, [items, activePreviewId]);

  const handleSelect = (item: typeof items[0]) => {
    if (multiple) {
      setSelectedIds((prev) => {
        const exists = prev.includes(item.id);
        const next = exists ? prev.filter((id) => id !== item.id) : [...prev, item.id];
        return next;
      });
    } else {
      setSelectedIds([item.id]);
      onSubmit({
        actionId: 'select',
        values: {
          choiceId: item.id,
          value: item.value,
        },
        decision: 'submit',
      });
    }
  };

  const handleMultipleSubmit = () => {
    if (selectedIds.length === 0) return;
    const selectedItems = items.filter((i) => selectedIds.includes(i.id));
    onSubmit({
      actionId: 'submit_multiple',
      values: {
        choices: selectedItems.map((i) => ({ id: i.id, value: i.value })),
      },
      decision: 'submit',
    });
  };

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-center text-slate-500">
        No style previews available to display.
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-4">
      {activeItem && (
        <div className="overflow-hidden rounded-2xl border border-slate-200/95 bg-slate-950 shadow-md">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-slate-900 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{activeItem.label}</p>
              {activeItem.description && (
                <p className="mt-0.5 truncate text-xs text-slate-400">{activeItem.description}</p>
              )}
            </div>
            {activeItem.downloadUrl && (
              <a
                href={activeItem.downloadUrl}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/15"
              >
                Download Preview
              </a>
            )}
          </div>
          <div className="relative aspect-[16/10] min-h-[280px] bg-slate-950 sm:min-h-[380px]">
            {activeItem.html ? (
              <iframe
                key={`${activeItem.id}:inline`}
                title={`${activeItem.label} live preview`}
                srcDoc={activeItem.html}
                loading="lazy"
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                className="h-full w-full border-0 bg-white"
              />
            ) : activeItem.previewUrl ? (
              <iframe
                key={activeItem.previewUrl}
                title={`${activeItem.label} live preview`}
                src={activeItem.previewUrl}
                loading="lazy"
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                className="h-full w-full border-0 bg-white"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-slate-400">
                <ImageIcon size={32} />
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        {items.map((item) => {
          const isSelected = selectedIds.includes(item.id);
          const isActive = activeItem?.id === item.id;
          return (
            <div
              key={item.id}
              role="button"
              tabIndex={isSubmitting ? -1 : 0}
              onClick={() => !isSubmitting && setActiveStylePreviewId(item.id)}
              className={`overflow-hidden rounded-xl border bg-white text-left transition-all duration-200 cursor-pointer ${
                isSelected || isActive
                  ? 'border-sky-400 shadow-[0_0_0_1px_rgba(14,165,233,0.15)] ring-1 ring-sky-400/20'
                  : 'border-slate-200 hover:border-slate-300 shadow-sm'
              }`}
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-slate-950 border-b border-slate-100">
                {item.html ? (
                  <iframe
                    title={`${item.label} snapshot`}
                    srcDoc={item.html}
                    loading="lazy"
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    className="pointer-events-none h-[250%] w-[250%] origin-top-left scale-[0.4] border-0 bg-white"
                  />
                ) : item.previewUrl ? (
                  <iframe
                    title={`${item.label} snapshot`}
                    src={item.previewUrl}
                    loading="lazy"
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    className="pointer-events-none h-[250%] w-[250%] origin-top-left scale-[0.4] border-0 bg-white"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center bg-slate-900 text-slate-400">
                    <ImageIcon size={28} />
                  </div>
                )}
                {isSelected && (
                  <div className="absolute right-3 top-3 rounded-full bg-sky-500 p-1 text-white shadow shadow-sky-500/30">
                    <Check size={14} strokeWidth={3} />
                  </div>
                )}
              </div>
              <div className="p-4 space-y-3">
                <div>
                  <h4 className="text-xs font-bold text-slate-800 leading-snug">{item.label}</h4>
                  {item.description && (
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-500 line-clamp-2">{item.description}</p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelect(item);
                  }}
                  className={`w-full rounded-lg px-3 py-1.5 text-xs font-semibold text-center transition-all ${
                    isSelected
                      ? 'bg-sky-500 text-white shadow shadow-sky-500/25'
                      : 'border border-slate-900 text-slate-900 bg-white hover:bg-slate-50'
                  }`}
                >
                  {isSelected ? 'Selected' : multiple ? 'Select Style' : 'Use this Style'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {multiple && selectedIds.length > 0 && (
        <div className="flex justify-end mt-4">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleMultipleSubmit}
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition shadow flex items-center gap-1.5"
          >
            {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : null}
            Confirm Choices ({selectedIds.length})
          </button>
        </div>
      )}
    </div>
  );
};

// 3. Approval Card Component (approval.card)
export const ApprovalCard: React.FC<A2UIComponentProps> = ({
  props,
  onSubmit,
  isSubmitting = false,
  error,
}) => {
  const title = String(props.title || 'Approval Required');
  const description = String(props.description || 'Please review and approve before the agent proceeds.');
  const customActions = useMemo<A2UIAction[]>(
    () => (Array.isArray(props.actions)
      ? props.actions.filter((item): item is A2UIAction => Boolean(item && typeof item === 'object'))
      : []),
    [props.actions],
  );
  const [notes, setNotes] = useState('');
  const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view');
  const [activeActionId, setActiveActionId] = useState<string | null>(null);

  const activeAction = customActions.find((action) => action?.id === activeActionId);

  const submitCustomAction = (action: A2UIAction, message = '') => {
    const actionId = String(action?.id || '').trim();
    if (!actionId) return;
    const decision = ['approve', 'edit', 'reject', 'submit', 'cancel'].includes(actionId)
      ? (actionId as A2UIDecision)
      : 'submit';
    onSubmit({
      actionId,
      decision,
      message,
      values: {
        action: {
          id: actionId,
          label: action?.label,
          value: action?.value,
          payload: action?.payload,
        },
      },
    });
  };

  const handleCustomActionClick = (action: A2UIAction) => {
    if (action?.inputMode === 'text') {
      setNotes('');
      setActiveActionId(String(action.id));
      return;
    }
    submitCustomAction(action);
  };

  const handleCustomTextSubmit = () => {
    if (!activeAction || !notes.trim()) return;
    submitCustomAction(activeAction, notes);
  };

  const handleApprove = () => {
    onSubmit({
      actionId: 'approve',
      decision: 'approve',
    });
  };

  const handleEditSubmit = () => {
    if (!notes.trim()) return;
    onSubmit({
      actionId: 'edit',
      decision: 'edit',
      message: notes,
    });
  };

  const handleRejectSubmit = () => {
    onSubmit({
      actionId: 'reject',
      decision: 'reject',
      message: notes,
    });
  };

  return (
    <div className="rounded-xl border border-slate-200/90 bg-white px-5 py-5 shadow-sm space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-800">
            <CheckCircle2 size={12} />
            Needs Attention
          </span>
          <h3 className="mt-2.5 text-base font-bold text-slate-800 leading-snug tracking-tight">{title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">{description}</p>
        </div>
      </div>

      {customActions.length > 0 && activeAction && (
        <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-3 space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            {activeAction.submitLabel || activeAction.label || 'Provide details'}
          </label>
          <textarea
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={activeAction.placeholder || 'Type your response...'}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 focus:outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400/20"
          />
          <div className="flex justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={() => setActiveActionId(null)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!notes.trim() || isSubmitting}
              onClick={handleCustomTextSubmit}
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-600 transition shadow"
            >
              {activeAction.submitLabel || 'Submit'}
            </button>
          </div>
        </div>
      )}

      {mode === 'edit' && (
        <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-3 space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            What should the agent change?
          </label>
          <textarea
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Type instructions or feedback on what needs to be changed..."
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 focus:outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400/20"
          />
          <div className="flex justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={() => setMode('view')}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!notes.trim() || isSubmitting}
              onClick={handleEditSubmit}
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-600 transition shadow"
            >
              Submit Feedback
            </button>
          </div>
        </div>
      )}

      {mode === 'reject' && (
        <div className="rounded-lg border border-red-100 bg-red-50/20 p-3 space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-red-700/80">
            Reason for rejection (Optional)
          </label>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Describe why you are rejecting this plan..."
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 focus:outline-none focus:border-red-400 focus:ring-1 focus:ring-red-400/20"
          />
          <div className="flex justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={() => setMode('view')}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={handleRejectSubmit}
              className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600 transition shadow"
            >
              Reject Plan
            </button>
          </div>
        </div>
      )}

      {mode === 'view' && !activeAction && customActions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {customActions.map((action) => {
            const actionId = String(action?.id || action?.label || '').trim();
            const style = action?.style === 'danger'
              ? 'border-red-200 bg-white text-red-700 hover:bg-red-50'
              : action?.style === 'primary'
                ? 'bg-slate-900 text-white hover:bg-slate-800'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50';
            return (
              <button
                key={actionId}
                type="button"
                disabled={isSubmitting || !actionId}
                onClick={() => handleCustomActionClick(action)}
                className={`rounded-lg px-4 py-2 text-xs font-semibold transition shadow-sm flex items-center gap-1.5 ${style}`}
              >
                {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : null}
                {action?.label || actionId}
              </button>
            );
          })}
        </div>
      )}

      {mode === 'view' && !activeAction && customActions.length === 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleApprove}
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition shadow flex items-center gap-1.5"
          >
            {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : null}
            Approve Plan
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => setMode('edit')}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition shadow-sm"
          >
            Request Changes
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => setMode('reject')}
            className="rounded-lg border border-red-200 bg-white px-4 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 transition shadow-sm ml-auto"
          >
            Reject
          </button>
        </div>
      )}

      {error && <div className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-100 p-2.5 rounded-lg">{error}</div>}
    </div>
  );
};

// 4. Plan Review Component (plan.review)
export const PlanReview: React.FC<A2UIComponentProps> = ({
  props,
  onSubmit,
  isSubmitting = false,
  error,
}) => {
  const [notes, setNotes] = useState('');
  const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view');

  const steps = useMemo<A2UIPlanStep[]>(
    () => (Array.isArray(props.steps)
      ? props.steps.filter((item): item is A2UIPlanStep => Boolean(item && typeof item === 'object'))
      : []),
    [props.steps],
  );
  const planFilePath = String(props.planFilePath || props.filePath || 'proposal-plan.md');
  const summaryMarkdown = String(props.summaryMarkdown || props.summary || props.description || '');
  const riskyActions = String(props.riskyActions || '');

  const handleApprove = () => {
    onSubmit({
      actionId: 'approve',
      decision: 'approve',
    });
  };

  const handleEditSubmit = () => {
    if (!notes.trim()) return;
    onSubmit({
      actionId: 'edit',
      decision: 'edit',
      message: notes,
    });
  };

  const handleRejectSubmit = () => {
    onSubmit({
      actionId: 'reject',
      decision: 'reject',
      message: notes,
    });
  };

  return (
    <div className="rounded-xl border border-slate-200/90 bg-white px-5 py-5 shadow-sm space-y-4 text-slate-900">
      <div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-800">
          <CheckCircle2 size={12} />
          Plan Review Needed
        </span>
        <h3 className="mt-2.5 text-base font-bold text-slate-800 leading-snug tracking-tight">Proposed Research/Execution Plan</h3>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">Please review the steps of the plan before continuous execution.</p>
      </div>

      <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3">
        <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          <span>Plan File</span>
          <span className="rounded-full bg-slate-200/60 px-2.5 py-0.5 font-mono text-[10px] normal-case tracking-normal text-slate-700">
            {planFilePath}
          </span>
        </div>
        {summaryMarkdown && (
          <div className="mt-2 text-xs leading-relaxed text-slate-600 whitespace-pre-wrap">
            {summaryMarkdown}
          </div>
        )}
      </div>

      {steps.length > 0 && (
        <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Execution Map</p>
          <div className="mt-3 space-y-2 max-h-64 overflow-y-auto pr-1">
            {steps.map((step, idx: number) => {
              const isComp = step.state === 'completed' || step.status === 'completed';
              return (
                <div key={idx} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="flex items-start gap-3">
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                      isComp ? 'bg-emerald-500 text-white' : 'bg-slate-900 text-white'
                    }`}>
                      {isComp ? <Check size={12} strokeWidth={3} /> : idx + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-800 leading-snug">{step.title}</p>
                      {step.detail && <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{step.detail}</p>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {riskyActions && (
        <div className="rounded-xl border border-rose-200 bg-rose-50/30 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-rose-700">Risk Notes</p>
          <p className="mt-1.5 text-xs leading-relaxed text-rose-950">{riskyActions}</p>
        </div>
      )}

      {mode === 'edit' && (
        <div className="rounded-lg border border-slate-150 bg-slate-50 p-3 space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
            Instructions/Changes
          </label>
          <textarea
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Specify what parts of the plan the agent should edit or change..."
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 focus:outline-none focus:border-sky-400"
          />
          <div className="flex justify-end gap-2 mt-2">
            <button type="button" onClick={() => setMode('view')} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition">Cancel</button>
            <button type="button" disabled={!notes.trim() || isSubmitting} onClick={handleEditSubmit} className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-600 transition shadow">Submit Instructions</button>
          </div>
        </div>
      )}

      {mode === 'reject' && (
        <div className="rounded-lg border border-red-100 bg-red-50/20 p-3 space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-red-700/85 block mb-1">Reason for Rejection</label>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why are you rejecting this research/execution plan?"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 focus:outline-none focus:border-red-400"
          />
          <div className="flex justify-end gap-2 mt-2">
            <button type="button" onClick={() => setMode('view')} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition">Cancel</button>
            <button type="button" disabled={isSubmitting} onClick={handleRejectSubmit} className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600 transition shadow">Reject Plan</button>
          </div>
        </div>
      )}

      {mode === 'view' && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleApprove}
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition shadow flex items-center gap-1.5"
          >
            {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : null}
            Approve Plan
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => setMode('edit')}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition shadow-sm"
          >
            Request Changes
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => setMode('reject')}
            className="rounded-lg border border-red-200 bg-white px-4 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 transition shadow-sm ml-auto"
          >
            Reject Plan
          </button>
        </div>
      )}

      {error && <div className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-100 p-2.5 rounded-lg">{error}</div>}
    </div>
  );
};

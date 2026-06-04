import { Check, CheckCircle2, ChevronRight, Copy, FilePenLine, ImageIcon, Loader2, RotateCcw } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useCallback, useEffect, useMemo, useState, type Dispatch, type KeyboardEvent, type ReactNode, type SetStateAction } from 'react';
import { A2UISurfaceRenderer } from '../../a2ui/A2UISurfaceRenderer';
import type { A2UIRequest, A2UIResponse } from '@helpudoc/contracts/types';

import type {
  ConversationMessage,
  ConversationMessageMetadata,
  InterruptAnswersByQuestionId,
} from '../../types';
import type { RenderableInterruptAction } from './interruptActions';
import { buildApprovalReview } from './approvalReview';
import {
  areStructuredClarificationQuestionsComplete,
  buildClarificationDraftStorageKey,
  extractStructuredAnswersFromMessage,
  readInterruptAnswerText,
} from '../../utils/clarifications';
import {
  summarizeToolActivity,
  getFriendlyToolName,
  isBenignToolNoise,
  isOperationalThinkingText,
  stripOperationalThinkingBlocks,
} from '../../utils/toolActivitySummary';
import { buildApiUrl } from '../../services/apiClient';
import {
  getAttachmentFileIcon,
  getAttachmentTypeLabel,
  renderFormattedUserText,
} from './messageContentFormatting';

const DEFAULT_THINKING_PLACEHOLDER = 'Working through your request based on the current workspace context.';
const ATTACHMENT_MARKER_PATTERN = /\n*\[Attachments:\s*([^\]]+)\]\s*$/i;

type MessageAttachmentPreview = {
  name: string;
  isDrive: boolean;
  isImage: boolean;
  previewUrl?: string;
};

type StylePreviewChoice = {
  id: string;
  label: string;
  value: string;
  description?: string;
  path?: string;
  html?: string;
  previewUrl?: string;
  downloadUrl?: string;
  isHtmlPreview?: boolean;
};

type RerunMessageOptions = {
  replacementText?: string;
  skipConfirm?: boolean;
};

const IMAGE_EXTENSION_PATTERN = /\.(apng|avif|gif|jpe?g|png|svg|webp)$/i;

const stripAttachmentMarker = (text: string) => text.replace(ATTACHMENT_MARKER_PATTERN, '').trimEnd();

const parseAttachmentNames = (text: string): Array<{ name: string; isDrive: boolean }> => {
  const match = text.match(ATTACHMENT_MARKER_PATTERN);
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split(',')
    .map((rawName) => rawName.trim())
    .filter(Boolean)
    .map((rawName) => {
      const isDrive = /\s+\(Drive\)$/i.test(rawName);
      return {
        name: rawName.replace(/\s+\(Drive\)$/i, '').trim(),
        isDrive,
      };
    })
    .filter((attachment) => attachment.name.length > 0);
};

const getAttachmentPreviewUrl = (
  workspaceId: string | undefined,
  sourceName: string,
  options?: { inline?: boolean },
): string | undefined => {
  if (!workspaceId || !sourceName.trim()) {
    return undefined;
  }
  const url = buildApiUrl(`/workspaces/${workspaceId}/files/preview/raw`);
  url.searchParams.set('path', sourceName.trim());
  if (options?.inline) {
    url.searchParams.set('disposition', 'inline');
  }
  return url.toString();
};

const formatElapsedTime = (
  startedAt?: string,
  now = Date.now(),
  endedAt?: string,
): string => {
  if (!startedAt) {
    return '';
  }
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) {
    return '';
  }
  const ended = endedAt ? new Date(endedAt).getTime() : Number.NaN;
  const effectiveNow = Number.isNaN(ended) ? now : ended;
  const elapsedSeconds = Math.max(0, Math.floor((effectiveNow - started) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
};

const isSkippedToolEvent = (event: NonNullable<ConversationMessage['toolEvents']>[number]): boolean => {
  const summary = typeof event.summary === 'string' ? event.summary.trim() : '';
  return /^Skipped\b/i.test(summary);
};

const isSummaryLikeAgentText = (value?: string): boolean => {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  return (
    /^Updated file\s+\//i.test(text) ||
    /^Completed successfully\.?$/i.test(text) ||
    /^The run (failed|was stopped)/i.test(text) ||
    /^Artifact contract failed\.?$/i.test(text) ||
    /^Missing:/i.test(text) ||
    /^PLAN_(APPROVAL|EDIT|REJECTION|REJECT|CLARIFICATION|ACTION)_[A-Z_]+/i.test(text) ||
    /^Command\s*\(/i.test(text)
  );
};

type ClarificationQuestionOption = {
  id: string;
  label: string;
  value: string;
  description?: string;
};

type ClarificationQuestion = {
  id: string;
  header: string;
  question: string;
  options: ClarificationQuestionOption[];
};



const normalizePreviewKey = (value: string): string => (
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
);

const inferStylePreviewPath = (label: string, value: string): string | undefined => {
  const source = `${label} ${value}`;
  const styleMatch = source.match(/\bstyle\s*([a-c])\b/i);
  if (!styleMatch?.[1]) {
    return undefined;
  }
  return `.claude-design/slide-previews/style-${styleMatch[1].toLowerCase()}.html`;
};

const parseStylePreviewChoiceMetadata = (
  payload?: Record<string, unknown>,
): Map<string, Partial<StylePreviewChoice>> => {
  const previewItems = (() => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return [];
    }
    const candidates = [
      payload.stylePreviews,
      payload.previewStyles,
      payload.previews,
      payload.previewFiles,
    ];
    return candidates.find((candidate): candidate is unknown[] => Array.isArray(candidate)) || [];
  })();
  const metadata = new Map<string, Partial<StylePreviewChoice>>();
  previewItems.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return;
    }
    const raw = item as Record<string, unknown>;
    const id = String(raw.id || raw.choiceId || `style-${index + 1}`).trim();
    const label = String(raw.label || raw.name || raw.title || '').trim();
    const value = String(raw.value || label).trim();
    const description = String(raw.description || raw.summary || '').trim();
    const path = String(raw.path || raw.file || raw.filePath || raw.previewPath || '').trim();
    const html = String(raw.html || raw.srcDoc || raw.srcdoc || raw.content || '').trim();
    const entry: Partial<StylePreviewChoice> = {
      ...(id ? { id } : {}),
      ...(label ? { label } : {}),
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      ...(path ? { path } : {}),
      ...(html ? { html } : {}),
    };
    [id, label, value].forEach((key) => {
      const normalized = normalizePreviewKey(key || '');
      if (normalized) {
        metadata.set(normalized, entry);
      }
    });
  });
  return metadata;
};

const buildStylePreviewChoices = (
  pendingInterrupt: ConversationMessageMetadata['pendingInterrupt'] | undefined,
  workspaceId: string | undefined,
): StylePreviewChoice[] => {
  if (pendingInterrupt?.uiRequest) {
    if (pendingInterrupt.uiRequest.component !== 'style_preview_chooser') {
      return [];
    }
    const choices = Array.isArray(pendingInterrupt.uiRequest.props.choices)
      ? pendingInterrupt.uiRequest.props.choices
      : [];
    if (!choices.length) {
      return [];
    }
    const metadata = parseStylePreviewChoiceMetadata(pendingInterrupt.uiRequest.props);
    const previewChoices = choices
      .map((choice: any): StylePreviewChoice | null => {
        const choiceId = String(choice.id || '').trim();
        const choiceLabel = String(choice.label || '').trim();
        const choiceValue = String(choice.value || choiceLabel).trim();
        if (!choiceId || !choiceLabel || !choiceValue) {
          return null;
        }
        const matchingMetadata =
          metadata.get(normalizePreviewKey(choiceId)) ||
          metadata.get(normalizePreviewKey(choiceLabel)) ||
          metadata.get(normalizePreviewKey(choiceValue)) ||
          {};
        const label = matchingMetadata.label || choiceLabel;
        const value = matchingMetadata.value || choiceValue;
        const path = matchingMetadata.path || inferStylePreviewPath(label, value);
        const description = matchingMetadata.description || choice.description;
        const html = matchingMetadata.html;
        const isHtmlPreview = Boolean(path && /\.html?$/i.test(path));
        return {
          id: choiceId,
          label,
          value,
          description,
          path,
          html,
          previewUrl: path ? getAttachmentPreviewUrl(workspaceId, path, { inline: isHtmlPreview }) : undefined,
          downloadUrl: path ? getAttachmentPreviewUrl(workspaceId, path) : undefined,
          isHtmlPreview: isHtmlPreview || Boolean(html),
        };
      })
      .filter((choice): choice is StylePreviewChoice => Boolean(choice));

    const stylePreviewCount = previewChoices.filter((choice) => Boolean(choice.path || choice.html)).length;
    return stylePreviewCount >= 2 ? previewChoices : [];
  }
  return [];
};

const stripDeadFrontendSlidesUiReferences = (text: string): string => (
  text
    .replace(/\b(?:I have|I've)\s+(?:created|prepared|provided|opened|set up)\b[^.!?]*(?:Presentation Context|context)[^.!?]*\bform\b[^.!?]*[.!?]/gis, '')
    .replace(/\bPlease\s+(?:fill out|complete|submit)\b[^.!?]*\b(?:form|questions?)\s+(?:above|below)\b[^.!?]*[.!?]/gis, '')
    .replace(/\bPlease\s+(?:review\s+and\s+)?(?:select|choose|pick)\b[^.!?]*\b(?:interactive\s+)?(?:selector|chooser|form)\s+(?:above|below)\b[^.!?]*[.!?]/gis, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
);

const getThinkingPlaceholder = (
  metadata?: ConversationMessageMetadata,
  toolEvents: ConversationMessage['toolEvents'] = [],
): string => {
  const activeSkill = metadata?.runPolicy?.skill?.trim().toLowerCase();
  if (activeSkill === 'frontend-slides') {
    return 'Preparing the presentation workflow from your prompt and workspace content.';
  }
  const toolNames = new Set((toolEvents || []).map((event) => event.name?.trim().toLowerCase()).filter(Boolean));
  if (toolNames.has('request_clarification')) {
    return 'Waiting for the presentation details needed to continue.';
  }
  if (activeSkill === 'research' || toolNames.has('google_search')) {
    return 'Formulating a research plan based on your prompt and available context.';
  }
  return DEFAULT_THINKING_PLACEHOLDER;
};

const formatInterruptValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const normalizePayloadKey = (key: string): string => key.trim().toLowerCase().replace(/[_\s-]+/g, '');

const isEmptyPayloadValue = (value: unknown): boolean => {
  if (value == null) return true;
  if (typeof value === 'string') return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
};

const isMetadataOnlyPayloadRecord = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>).map(normalizePayloadKey);
  return keys.length > 0 && keys.every((key) => ['skill', 'source', 'synthetic'].includes(key));
};

const isQuestionOnlyPayloadRecord = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const hasQuestion = typeof record.question === 'string' || typeof record.prompt === 'string';
  const hasChoices = Array.isArray(record.options) || Array.isArray(record.choices);
  const hasDisplayContent = ['slides', 'slideOutline', 'outlineItems', 'items', 'sections', 'content', 'summary', 'markdown']
    .some((key) => !isEmptyPayloadValue(record[key]));
  return hasQuestion && hasChoices && !hasDisplayContent;
};

const getRenderableDisplayPayloadEntries = (
  payload?: Record<string, unknown>,
): Array<[string, unknown]> => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  const hiddenKeys = new Set([
    'questions',
    'context',
    'skill',
    'source',
    'synthetic',
    'stylepreviews',
    'previewstyles',
    'previews',
    'previewfiles',
  ]);
  return Object.entries(payload).filter(([key, value]) => {
    const normalizedKey = normalizePayloadKey(key);
    if (hiddenKeys.has(normalizedKey)) {
      return false;
    }
    if (isEmptyPayloadValue(value) || isMetadataOnlyPayloadRecord(value) || isQuestionOnlyPayloadRecord(value)) {
      return false;
    }
    return true;
  });
};

const renderDisplayPayload = (
  payload?: Record<string, unknown>,
  heading = 'Details',
  tone: 'dark' | 'light' = 'dark',
) => {
  const entries = getRenderableDisplayPayloadEntries(payload);
  if (!entries.length) {
    return null;
  }
  const containerClass =
    tone === 'dark'
      ? 'rounded-2xl border border-white/10 bg-white/5 p-4 text-left'
      : 'rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 text-left';
  const headingClass =
    tone === 'dark'
      ? 'text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55'
      : 'text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500';
  const keyClass =
    tone === 'dark'
      ? 'text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45'
      : 'text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500';
  const valueClass =
    tone === 'dark'
      ? 'mt-1 whitespace-pre-wrap text-sm leading-relaxed text-white/88'
      : 'mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-700';
  return (
    <div className={containerClass}>
      <p className={headingClass}>{heading}</p>
      <div className="mt-3 space-y-3">
        {entries.map(([key, value]) => (
          <div key={key}>
            <p className={keyClass}>{key}</p>
            <p className={valueClass}>{formatInterruptValue(value)}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

const parseClarificationQuestions = (
  pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
): ClarificationQuestion[] => {
  if (pendingInterrupt?.uiRequest) {
    if (pendingInterrupt.uiRequest.component !== 'clarification_form') {
      return [];
    }
    const responseQuestions = Array.isArray(pendingInterrupt.uiRequest.props.questions)
      ? pendingInterrupt.uiRequest.props.questions
      : [];
    if (responseQuestions.length) {
      return responseQuestions.reduce<ClarificationQuestion[]>((acc, question: any) => {
        if (!question || typeof question !== 'object' || !question.question) {
          return acc;
        }
        acc.push({
          id: question.id,
          header: question.header || question.title || '',
          question: question.question,
          options: Array.isArray(question.options)
            ? (question.options as unknown[]).reduce<ClarificationQuestionOption[]>((optionAcc, option) => {
                const optionRecord = option && typeof option === 'object'
                  ? option as Record<string, unknown>
                  : {};
                const label = typeof option === 'string' ? option : optionRecord.label;
                const value = typeof option === 'string' ? option : optionRecord.value;
                if (!label || !value) {
                  return optionAcc;
                }
                const labelText = String(label);
                const valueText = String(value);
                optionAcc.push({
                  id: typeof optionRecord.id === 'string'
                    ? optionRecord.id
                    : labelText.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                  label: labelText,
                  value: valueText,
                  description: typeof optionRecord.description === 'string' ? optionRecord.description : undefined,
                });
                return optionAcc;
              }, [])
            : [],
        });
        return acc;
      }, []);
    }
    return [];
  }
  return [];
};

const isA2UINativeEnabled = import.meta.env.VITE_A2UI_NATIVE_ENABLED !== 'false';

export default function ChatMessageBubble({
  colorMode,
  message,
  isLatestAgentMessage,
  personaDisplayName,
  messageBubbleMaxWidth,
  markdownComponents,
  expandedToolMessages,
  expandedThinkingMessages,
  copiedMessageId,
  interruptInputByMessageId,
  interruptStructuredAnswersByMessageId,
  interruptSelectedChoicesByMessageId,
  interruptSubmittingByMessageId,
  interruptErrorByMessageId,
  interruptFieldKey,
  interruptActionFieldKey,
  formatMessageTimestamp,
  getInterruptKind,
  getInterruptActions,
  getPrimaryInterruptAction,
  isPlanApprovalInterrupt,
  setInterruptInputByMessageId,
  setInterruptStructuredAnswersByMessageId,
  toggleInterruptSelectedChoice,
  toggleThinkingVisibility,
  toggleToolActivityVisibility,
  handleCopyMessageText,
  handleRerunMessage,
  handlePrepareInterruptAction,
  handleInterruptAction,
  isStreaming,
  workspaceId,
  onA2UISubmit,
}: {
  colorMode: 'light' | 'dark';
  message: ConversationMessage;
  isLatestAgentMessage?: boolean;
  personaDisplayName: string;
  messageBubbleMaxWidth: string;
  markdownComponents: Components;
  expandedToolMessages: Set<ConversationMessage['id']>;
  expandedThinkingMessages: Set<ConversationMessage['id']>;
  copiedMessageId: ConversationMessage['id'] | null;
  interruptInputByMessageId: Record<string, string>;
  interruptStructuredAnswersByMessageId: Record<string, InterruptAnswersByQuestionId>;
  interruptSelectedChoicesByMessageId: Record<string, string[]>;
  interruptSubmittingByMessageId: Record<string, boolean>;
  interruptErrorByMessageId: Record<string, string>;
  interruptFieldKey: (
    messageKey: string,
    field: 'feedback' | 'edit-json' | 'reject-note' | 'clarification-text',
  ) => string;
  interruptActionFieldKey: (messageKey: string, actionId: string) => string;
  formatMessageTimestamp: (value?: string) => string;
  getInterruptKind: (
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => 'approval' | 'clarification';
  getInterruptActions: (
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => RenderableInterruptAction[];
  getPrimaryInterruptAction: (
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => { name?: string; args?: Record<string, unknown> } | undefined;
  isPlanApprovalInterrupt: (pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt']) => boolean;
  setInterruptInputByMessageId: Dispatch<SetStateAction<Record<string, string>>>;
  setInterruptStructuredAnswersByMessageId: Dispatch<SetStateAction<Record<string, InterruptAnswersByQuestionId>>>;
  toggleInterruptSelectedChoice: (messageKey: string, choiceId: string, multiple: boolean) => void;
  toggleThinkingVisibility: (messageId: ConversationMessage['id']) => void;
  toggleToolActivityVisibility: (messageId: ConversationMessage['id']) => void;
  handleCopyMessageText: (message: ConversationMessage) => void;
  handleRerunMessage: (messageId: ConversationMessage['id'], options?: RerunMessageOptions) => void;
  handlePrepareInterruptAction: (
    message: ConversationMessage,
    action: RenderableInterruptAction,
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => void;
  handleInterruptAction: (
    message: ConversationMessage,
    action: RenderableInterruptAction,
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => void;
  isStreaming: boolean;
  workspaceId?: string;
  onA2UISubmit?: (response: A2UIResponse, request: A2UIRequest, message?: any) => Promise<void>;
}) {
  const isDarkMode = colorMode === 'dark';
  const isAgentMessage = message.sender === 'agent';
  const [now, setNow] = useState(() => Date.now());
  const messageMetadata = (message.metadata as ConversationMessageMetadata | null | undefined) || undefined;
  const progressEvents = useMemo(() => messageMetadata?.progressEvents || [], [messageMetadata?.progressEvents]);
  const effectiveProgressEvents = useMemo(() => {
    const lastIndex = progressEvents.length - 1;
    return progressEvents.map((event, index) => {
      if (event.status !== 'running' || index >= lastIndex) {
        return event;
      }
      return { ...event, status: 'completed' as const };
    });
  }, [progressEvents]);
  const latestProgress = useMemo(() => [...effectiveProgressEvents].reverse().find(Boolean), [effectiveProgressEvents]);
  const activeProgress = useMemo(() => [...effectiveProgressEvents].reverse().find(
    (event) => event.status === 'running',
  ), [effectiveProgressEvents]);
  const timestampLabel = formatMessageTimestamp(message.updatedAt || message.createdAt);
  const toolEvents = useMemo(
    () => (message.toolEvents || []).filter((event) => !isSkippedToolEvent(event)),
    [message.toolEvents],
  );
  const hasToolEvents = toolEvents.length > 0;
  const runClockAnchor = toolEvents[0]?.startedAt || message.createdAt;
  const toolDigest = useMemo(
    () => summarizeToolActivity(toolEvents, formatMessageTimestamp),
    [formatMessageTimestamp, toolEvents],
  );
  const pendingInterrupt = messageMetadata?.pendingInterrupt;
  const a2uiRequest = useMemo(() => {
    if (!pendingInterrupt) return undefined;
    const displayPayload = pendingInterrupt.displayPayload || {};
    const gateId = typeof displayPayload.gateId === 'string' && displayPayload.gateId.trim()
      ? displayPayload.gateId.trim()
      : undefined;
    const stableSurfaceId = [
      'surface',
      message.id,
      gateId || pendingInterrupt.interruptId || pendingInterrupt.a2uiRequest?.component || pendingInterrupt.uiRequest?.component || 'interrupt',
    ].join(':');
    if (pendingInterrupt.a2uiRequest) {
      return {
        ...pendingInterrupt.a2uiRequest,
        surfaceId: stableSurfaceId,
      };
    }
    if (pendingInterrupt.uiRequest && isA2UINativeEnabled) {
      const legacy = pendingInterrupt.uiRequest;
      return {
        contract: 'a2ui' as const,
        version: '0.9' as const,
        surfaceId: stableSurfaceId,
        component: legacy.component,
        props: legacy.props,
        resumeAction: {
          endpoint: legacy.component === 'approval' ? ('decision' as const) : ('respond' as const),
          actionId: legacy.resume?.action,
        },
      } as A2UIRequest;
    }
    return undefined;
  }, [message.id, pendingInterrupt]);

  const interruptKind = getInterruptKind(pendingInterrupt);
  const isClarificationInterrupt = Boolean(
    (pendingInterrupt?.uiRequest &&
      (pendingInterrupt.uiRequest.component === 'clarification_form' ||
        pendingInterrupt.uiRequest.component === 'style_preview_chooser')) ||
    (a2uiRequest &&
      (a2uiRequest.component === 'clarification.form' ||
        a2uiRequest.component === 'style.previewChooser' ||
        a2uiRequest.component === 'clarification_form' ||
        a2uiRequest.component === 'style_preview_chooser'))
  );
  const interruptActions = getInterruptActions(pendingInterrupt);
  const primaryInterruptAction = getPrimaryInterruptAction(pendingInterrupt);
  const isPlanApprovalRequest = isPlanApprovalInterrupt(pendingInterrupt);
  const messageKey = String(message.id);
  const interruptBusy = Boolean(interruptSubmittingByMessageId[messageKey]);
  const interruptControlsDisabled = interruptBusy;
  const [activeTextActionId, setActiveTextActionId] = useState<string | null>(null);
  const [confirmActionId, setConfirmActionId] = useState<string | null>(null);
  const [clarificationDismissed, setClarificationDismissed] = useState(false);
  const isToolActivityExpanded = expandedToolMessages.has(message.id);
  const [showRawToolLog, setShowRawToolLog] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.text || '');
  const isThinkingExpanded = expandedThinkingMessages.has(message.id);
  const rawThinkingText = message.thinkingText?.trim() || '';
  const isSystemThinking = /available skills/i.test(rawThinkingText);
  const sanitizedThinkingText = stripOperationalThinkingBlocks(rawThinkingText);
  const displayThinkingText = isSystemThinking
    ? getThinkingPlaceholder(messageMetadata, toolEvents)
    : sanitizedThinkingText;
  const sanitizedAgentText = (() => {
    const raw = message.text || '';
    if (!raw) {
      return raw;
    }
    const shouldStripApprovalBoilerplate = Boolean(pendingInterrupt) && interruptKind === 'approval';
    const shouldStripTransientErrorLine = Boolean(pendingInterrupt)
      || messageMetadata?.status === 'awaiting_approval';
    if (!shouldStripApprovalBoilerplate && !shouldStripTransientErrorLine) {
      return raw;
    }
    return raw
      .split('\n')
      .filter((line) => {
        const value = line.trim();
        if (!value) return false;
        if (shouldStripApprovalBoilerplate) {
          if (/^\[human approval required\]$/i.test(value)) return false;
          if (/request_plan_approval\s*\(allowed:/i.test(value)) return false;
          if (/\(allowed:\s*approve,\s*edit,\s*reject\)/i.test(value)) return false;
          if (/use the approval controls to approve, edit, or reject before execution continues\.?/i.test(value)) return false;
        }
        if (shouldStripTransientErrorLine && /^Sorry,\s*something went wrong\.?$/i.test(value)) return false;
        if (/^PLAN_(APPROVAL|EDIT|REJECTION|REJECT|CLARIFICATION|ACTION)_[A-Z_]+/i.test(value)) return false;
        if (/^Command\s*\(/i.test(value)) return false;
        return true;
      })
      .join('\n')
      .trim();
  })();
  const userText = isAgentMessage ? '' : stripAttachmentMarker(message.text || '');
  const editableUserText = stripAttachmentMarker(message.text || '');
  const attachmentPreviews = useMemo<MessageAttachmentPreview[]>(() => {
    if (isAgentMessage) {
      return [];
    }
    const parsedAttachments = parseAttachmentNames(message.text || '');
    const refs = messageMetadata?.fileContextRefs || [];
    if (!parsedAttachments.length && !refs.length) {
      return [];
    }
    const attachments = parsedAttachments.length
      ? parsedAttachments
      : refs.map((ref) => ({
          name: ref.sourceName,
          isDrive: false,
        }));

    return attachments.map((attachment) => {
      const ref = refs.find((candidate) => {
        const sourceName = candidate.sourceName || '';
        return sourceName === attachment.name || sourceName.endsWith(`/${attachment.name}`);
      });
      const sourceName = ref?.sourceName || attachment.name;
      const mimeType = ref?.sourceMimeType || '';
      const isImage = mimeType.startsWith('image/') || IMAGE_EXTENSION_PATTERN.test(sourceName);
      return {
        name: attachment.name,
        isDrive: attachment.isDrive,
        isImage,
        previewUrl: isImage ? getAttachmentPreviewUrl(workspaceId, sourceName) : undefined,
      };
    });
  }, [isAgentMessage, message.text, messageMetadata?.fileContextRefs, workspaceId]);
  const effectiveStatus = pendingInterrupt ? 'awaiting_approval' : messageMetadata?.status;
  const isLiveAgentStatus = effectiveStatus === 'running' || effectiveStatus === 'awaiting_approval';
  const shouldHideThinkingDuringToolRun = Boolean(
    isAgentMessage
    && isLatestAgentMessage
    && isLiveAgentStatus
    && hasToolEvents
    && (isOperationalThinkingText(rawThinkingText) || !sanitizedThinkingText.trim()),
  );
  const bodySource = messageMetadata?.bodySource
    || (sanitizedAgentText ? (isSummaryLikeAgentText(sanitizedAgentText) ? 'summary' : 'assistant') : undefined);
  const isCopiedMessage = copiedMessageId === message.id;
  const copyTitle = isCopiedMessage ? 'Copied!' : 'Copy message';
  const planFeedbackKey = interruptFieldKey(messageKey, 'feedback');
  const genericEditKey = interruptFieldKey(messageKey, 'edit-json');
  const rejectNoteKey = interruptFieldKey(messageKey, 'reject-note');
  const clarificationTextKey = interruptFieldKey(messageKey, 'clarification-text');
  const interruptError = interruptErrorByMessageId[messageKey] || '';
  const allowDismiss = Boolean(pendingInterrupt?.responseSpec?.allowDismiss);
  const clarificationAllowsMultiple = Boolean(pendingInterrupt?.responseSpec?.multiple);
  const selectedChoiceIds = interruptSelectedChoicesByMessageId[messageKey] || [];
  const structuredClarificationQuestions = useMemo(
    () => parseClarificationQuestions(pendingInterrupt),
    [pendingInterrupt],
  );
  const stylePreviewChoices = useMemo(
    () => buildStylePreviewChoices(pendingInterrupt, workspaceId),
    [pendingInterrupt, workspaceId],
  );
  const hasStylePreviewChooser = isClarificationInterrupt && stylePreviewChoices.length > 0;
  const [activeStylePreviewId, setActiveStylePreviewId] = useState<string | null>(null);
  const activeStylePreviewChoice = useMemo(() => {
    if (!stylePreviewChoices.length) {
      return null;
    }
    return (
      stylePreviewChoices.find((choice) => choice.id === activeStylePreviewId)
      || stylePreviewChoices.find((choice) => selectedChoiceIds.includes(choice.id))
      || stylePreviewChoices.find((choice) => choice.previewUrl)
      || stylePreviewChoices[0]
    );
  }, [activeStylePreviewId, selectedChoiceIds, stylePreviewChoices]);
  const hasStructuredClarificationForm = isClarificationInterrupt && structuredClarificationQuestions.length > 0;
  const clarificationDraftValue = interruptInputByMessageId[clarificationTextKey] || '';
  const structuredClarificationSubmitActions = interruptActions.filter((action) => action.inputMode === 'text');
  const structuredAnswerMap = useMemo(
    () => interruptStructuredAnswersByMessageId[messageKey] || {},
    [interruptStructuredAnswersByMessageId, messageKey],
  );
  const setInterruptValue = useCallback((fieldKey: string, value: string) => {
    setInterruptInputByMessageId((prev) => ({
      ...prev,
      [fieldKey]: value,
    }));
  }, [setInterruptInputByMessageId]);
  const hasMultiQuestionClarificationWizard = hasStructuredClarificationForm && structuredClarificationQuestions.length > 1;
  const [wizardStepIndex, setWizardStepIndex] = useState(0);
  const stableInterruptDraftId = messageMetadata?.runId || message.turnId || message.id;
  const wizardStorageKey = pendingInterrupt?.interruptId
    ? buildClarificationDraftStorageKey(message.conversationId, stableInterruptDraftId, pendingInterrupt.interruptId)
    : '';
  const currentWizardQuestion = hasMultiQuestionClarificationWizard
    && wizardStepIndex < structuredClarificationQuestions.length
    ? structuredClarificationQuestions[wizardStepIndex]
    : null;
  const isWizardReviewStep = hasMultiQuestionClarificationWizard && wizardStepIndex >= structuredClarificationQuestions.length;
  const structuredAnswersComplete = hasStructuredClarificationForm
    ? areStructuredClarificationQuestionsComplete(structuredClarificationQuestions, structuredAnswerMap)
    : false;

  useEffect(() => {
    setClarificationDismissed(false);
  }, [pendingInterrupt?.interruptId]);

  useEffect(() => {
    if (!stylePreviewChoices.length) {
      setActiveStylePreviewId(null);
      return;
    }
    setActiveStylePreviewId((current) => {
      if (current && stylePreviewChoices.some((choice) => choice.id === current)) {
        return current;
      }
      return (
        stylePreviewChoices.find((choice) => selectedChoiceIds.includes(choice.id))?.id
        || stylePreviewChoices.find((choice) => choice.previewUrl)?.id
        || stylePreviewChoices[0]?.id
        || null
      );
    });
  }, [selectedChoiceIds, stylePreviewChoices]);

  const planText = useMemo(() => {
    const args = primaryInterruptAction?.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return '';
    }
    const stringCandidates = ['plan', 'proposal', 'draft', 'content', 'text', 'notes']
      .map((key) => args[key])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (stringCandidates.length) {
      return stringCandidates[0];
    }
    const stringValues = Object.values(args).filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    if (stringValues.length === 1) {
      return stringValues[0];
    }
    return JSON.stringify(args, null, 2);
  }, [primaryInterruptAction?.args]);
  const approvalReview = useMemo(
    () => buildApprovalReview(pendingInterrupt, primaryInterruptAction),
    [pendingInterrupt, primaryInterruptAction],
  );
  const shouldHideAgentBodyForApproval = Boolean(
    pendingInterrupt
    && !isClarificationInterrupt
    && (approvalReview || interruptKind === 'approval'),
  );
  const shouldHideAgentBodyForClarification = Boolean(
    pendingInterrupt
    && isClarificationInterrupt
    && (
      Array.isArray(pendingInterrupt.responseSpec?.questions)
      || hasStylePreviewChooser
      || Array.isArray(pendingInterrupt.displayPayload?.questions)
    ),
  );
  const agentTextForDisplay = stripDeadFrontendSlidesUiReferences(
    stripOperationalThinkingBlocks(sanitizedAgentText),
  );
  const visibleAgentText = shouldHideAgentBodyForApproval
    ? ''
    : shouldHideAgentBodyForClarification
      ? ''
      : bodySource === 'summary' && isLiveAgentStatus
      ? ''
      : shouldHideThinkingDuringToolRun && isOperationalThinkingText(agentTextForDisplay)
        ? ''
        : agentTextForDisplay;
  const inlineStatus = (() => {
    if (!isAgentMessage || !isLatestAgentMessage) {
      return null;
    }
    const rawStatus = effectiveStatus;
    if (rawStatus !== 'running' && rawStatus !== 'awaiting_approval') {
      return null;
    }
    if (rawStatus === 'awaiting_approval') {
      const awaitingDetail =
        pendingInterrupt?.title || pendingInterrupt?.description || 'The agent needs your input to continue.';
      return {
        status: rawStatus,
        title: 'Waiting for you',
        detail: awaitingDetail as ReactNode,
        elapsed: formatElapsedTime(message.createdAt, now),
      };
    }
    if (progressEvents.length > 0) {
      const stageLabel =
        activeProgress?.label ||
        latestProgress?.label ||
        toolDigest.activeStepLabel ||
        toolDigest.headline ||
        'Working through the current request.';
      return {
        status: rawStatus,
        title: 'Running',
        detail: stageLabel as ReactNode,
        elapsed: formatElapsedTime(runClockAnchor || message.createdAt, now),
      };
    }
    if (hasToolEvents) {
      const liveStepLabel = toolDigest.stepProgress
        ? rawStatus === 'running'
          ? `Step ${toolDigest.stepProgress.current}`
          : `Step ${toolDigest.stepProgress.current} of ${toolDigest.stepProgress.total}`
        : null;
      const timedDetail = (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className={`text-[15px] font-semibold leading-snug tracking-tight ${
              isDarkMode ? 'text-slate-50' : 'text-slate-900'
            }`}>
              {toolDigest.headline}
            </p>
            {liveStepLabel ? (
              <p className={`shrink-0 text-xs font-medium tabular-nums ${
                isDarkMode ? 'text-slate-400' : 'text-slate-500'
              }`}>
                {liveStepLabel}
              </p>
            ) : null}
          </div>
          {toolDigest.activeStepLabel ? (
            <p className={`inline-flex items-center gap-1.5 text-xs font-medium leading-relaxed ${
              isDarkMode ? 'text-sky-100' : 'text-sky-900'
            }`}>
              <span className={`inline-flex h-1.5 w-1.5 shrink-0 animate-pulse rounded-full ${
                isDarkMode ? 'bg-sky-300' : 'bg-sky-500'
              }`} />
              {toolDigest.activeStepLabel}
            </p>
          ) : null}
          {toolDigest.errorCount > 0 ? (
            <p className={`text-xs font-medium ${isDarkMode ? 'text-rose-300' : 'text-rose-600'}`}>
              {`${toolDigest.errorCount} issue${toolDigest.errorCount === 1 ? '' : 's'} may need attention.`}
            </p>
          ) : null}
        </div>
      );
      return {
        status: rawStatus,
        title: 'Running',
        detail: timedDetail,
        elapsed: formatElapsedTime(runClockAnchor, now),
      };
    }
    const latestToolEvent = [...toolEvents].reverse().find(Boolean);
    const fallbackDetail =
      latestToolEvent?.status === 'running'
        ? `${getFriendlyToolName(latestToolEvent.name)}…`
        : latestToolEvent?.summary
          ? latestToolEvent.summary
          : visibleAgentText || displayThinkingText || 'Working through the current request.';
    return {
      status: rawStatus,
      title: 'Running',
      detail: fallbackDetail as ReactNode,
      elapsed: formatElapsedTime(message.createdAt, now),
    };
  })();
  const canCopyMessage =
    Boolean((visibleAgentText && visibleAgentText.trim()) || (message.thinkingText && message.thinkingText.trim()));
  const shouldShowFallbackStatus = !visibleAgentText && !displayThinkingText && !hasToolEvents;
  useEffect(() => {
    if (!pendingInterrupt) {
      setActiveTextActionId(null);
      setConfirmActionId(null);
      setClarificationDismissed(false);
      setWizardStepIndex(0);
      return;
    }
    setActiveTextActionId(null);
    setConfirmActionId(null);
    setClarificationDismissed(false);
    setWizardStepIndex(0);
  }, [pendingInterrupt, messageKey]);

  useEffect(() => {
    if (!isToolActivityExpanded) {
      setShowRawToolLog(false);
    }
  }, [isToolActivityExpanded]);

  useEffect(() => {
    if (!isEditing) {
      setEditValue(editableUserText);
    }
  }, [editableUserText, isEditing]);

  useEffect(() => {
    if (!hasStructuredClarificationForm) {
      return;
    }
    const legacyAnswers = extractStructuredAnswersFromMessage(clarificationDraftValue, structuredClarificationQuestions);
    if (Object.keys(legacyAnswers).length === 0 || Object.keys(structuredAnswerMap).length > 0) {
      return;
    }
    setInterruptStructuredAnswersByMessageId((prev) => ({
      ...prev,
      [messageKey]: {
        ...(prev[messageKey] || {}),
        ...legacyAnswers,
      },
    }));
  }, [
    clarificationDraftValue,
    hasStructuredClarificationForm,
    messageKey,
    setInterruptStructuredAnswersByMessageId,
    structuredAnswerMap,
    structuredClarificationQuestions,
  ]);

  useEffect(() => {
    if (!hasStructuredClarificationForm || !wizardStorageKey || typeof window === 'undefined') {
      return;
    }
    try {
      const raw = window.localStorage.getItem(wizardStorageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as {
        answersByQuestionId?: InterruptAnswersByQuestionId;
        notes?: string;
        stepIndex?: number;
      };
      if (parsed.answersByQuestionId && Object.keys(structuredAnswerMap).length === 0) {
        setInterruptStructuredAnswersByMessageId((prev) => {
          if (prev[messageKey] && Object.keys(prev[messageKey]).length > 0) {
            return prev;
          }
          return {
            ...prev,
            [messageKey]: parsed.answersByQuestionId || {},
          };
        });
      }
      if (parsed.notes && !clarificationDraftValue.trim()) {
        setInterruptValue(clarificationTextKey, parsed.notes);
      }
      if (typeof parsed.stepIndex === 'number' && Number.isFinite(parsed.stepIndex)) {
        const maxStep = hasMultiQuestionClarificationWizard ? structuredClarificationQuestions.length : 0;
        setWizardStepIndex(Math.max(0, Math.min(parsed.stepIndex, maxStep)));
      }
    } catch (error) {
      console.error('Failed to restore clarification draft', error);
    }
  }, [
    clarificationDraftValue,
    clarificationTextKey,
    hasMultiQuestionClarificationWizard,
    hasStructuredClarificationForm,
    messageKey,
    setInterruptStructuredAnswersByMessageId,
    structuredAnswerMap,
    structuredClarificationQuestions.length,
    setInterruptValue,
    wizardStorageKey,
  ]);

  useEffect(() => {
    if (!hasStructuredClarificationForm || !wizardStorageKey || typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(
        wizardStorageKey,
        JSON.stringify({
          answersByQuestionId: structuredAnswerMap,
          notes: clarificationDraftValue,
          stepIndex: wizardStepIndex,
        }),
      );
    } catch (error) {
      console.error('Failed to persist clarification draft', error);
    }
  }, [
    clarificationDraftValue,
    hasStructuredClarificationForm,
    structuredAnswerMap,
    wizardStepIndex,
    wizardStorageKey,
  ]);

  const setStructuredAnswer = (questionId: string, value: string) => {
    setInterruptStructuredAnswersByMessageId((prev) => {
      const next = { ...prev };
      const current = { ...(next[messageKey] || {}) };
      const trimmedValue = value.trim();
      if (trimmedValue) {
        // Preserve internal spaces while still treating all-whitespace input as empty.
        current[questionId] = value;
      } else {
        delete current[questionId];
      }
      if (Object.keys(current).length === 0) {
        delete next[messageKey];
      } else {
        next[messageKey] = current;
      }
      return next;
    });
  };

  const getActionInputKey = (action: RenderableInterruptAction): string => {
    if (action.source === 'approval' && action.legacyDecision === 'edit') {
      return isPlanApprovalRequest ? planFeedbackKey : genericEditKey;
    }
    if (action.source === 'approval' && action.legacyDecision === 'reject') {
      return rejectNoteKey;
    }
    if (action.source === 'clarification-text') {
      return clarificationTextKey;
    }
    return interruptActionFieldKey(messageKey, action.id);
  };

  const handleActionTrigger = (action: RenderableInterruptAction) => {
    if (interruptControlsDisabled) {
      return;
    }
    if (action.source === 'clarification-choice' && clarificationAllowsMultiple && action.choiceId) {
      toggleInterruptSelectedChoice(messageKey, action.choiceId, true);
      return;
    }
    handlePrepareInterruptAction(message, action, pendingInterrupt);
    if (action.inputMode === 'text') {
      setActiveTextActionId(action.id);
      if (action.confirm) {
        setConfirmActionId(action.id);
      } else {
        setConfirmActionId(null);
      }
      return;
    }
    if (action.confirm && confirmActionId !== action.id) {
      setConfirmActionId(action.id);
      return;
    }
    void handleInterruptAction(message, action, pendingInterrupt);
  };

  const handleActionCancel = () => {
    setActiveTextActionId(null);
    setConfirmActionId(null);
  };

  const startInlineEdit = () => {
    setEditValue(editableUserText);
    setIsEditing(true);
  };

  const cancelInlineEdit = () => {
    setEditValue(editableUserText);
    setIsEditing(false);
  };

  const saveInlineEdit = () => {
    const trimmed = editValue.trim();
    if (!trimmed || isStreaming) {
      return;
    }
    setIsEditing(false);
    handleRerunMessage(message.id, {
      replacementText: trimmed,
      skipConfirm: true,
    });
  };

  const handleInlineEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelInlineEdit();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      saveInlineEdit();
    }
  };

  const clarificationDisplayPayload = renderDisplayPayload(
    pendingInterrupt?.displayPayload && typeof pendingInterrupt.displayPayload === 'object'
      ? Object.fromEntries(
          Object.entries(pendingInterrupt.displayPayload).filter(([key]) => key !== 'questions'),
        )
      : undefined,
    'Context',
    'light',
  );
  const approvalDisplayPayload = approvalReview
    ? null
    : renderDisplayPayload(pendingInterrupt?.displayPayload, 'Plan details', 'light');
  const isDynamicActionInterrupt = Boolean(pendingInterrupt?.actions?.length);

  const getActionButtonClass = (action: RenderableInterruptAction, tone: 'light' | 'dark'): string => {
    const isPrimary = action.style === 'primary';
    const isDanger = action.style === 'danger';
    if (tone === 'dark') {
      if (isPrimary) {
        return 'rounded-[1.2rem] border border-white/15 bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition-all duration-200 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40';
      }
      if (isDanger) {
        return 'rounded-[1.2rem] border border-white/14 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/88 transition-all duration-200 hover:border-white/24 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40';
      }
      return 'rounded-[1.2rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-semibold text-white/92 transition-all duration-200 hover:border-white/25 hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-40';
    }
    if (isPrimary) {
      return 'rounded-xl border border-slate-900/90 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60';
    }
    if (isDanger) {
      return 'rounded-xl border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 transition-all duration-200 hover:border-rose-300 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60';
    }
    return 'rounded-xl border border-slate-300/90 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-all duration-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60';
  };

  const renderStructuredSubmitButtons = (alignment: 'between' | 'end' = 'between') => (
    <div className={`flex flex-wrap gap-2 ${alignment === 'end' ? 'justify-end' : 'justify-between'}`}>
      {alignment === 'between' ? <div /> : null}
      <div className="flex flex-wrap gap-2">
        {structuredClarificationSubmitActions.map((action) => (
          <button
            key={action.id}
            type="button"
            disabled={interruptControlsDisabled || !structuredAnswersComplete}
            onClick={() => void handleInterruptAction(message, action, pendingInterrupt)}
            className={getActionButtonClass(
              {
                ...action,
                label: action.submitLabel || action.label,
                style: 'primary',
              },
              'light',
            )}
          >
            {interruptBusy ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={16} className="animate-spin" />
                {action.submitLabel || action.label}
              </span>
            ) : (
              action.submitLabel || action.label
            )}
          </button>
        ))}
      </div>
    </div>
  );

  const renderStructuredQuestionEditor = (question: ClarificationQuestion) => {
    const currentAnswer = readInterruptAnswerText(structuredAnswerMap[question.id]);
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            {question.header}
          </p>
          <p className="mt-2 text-sm font-semibold leading-relaxed text-slate-900">
            {question.question}
          </p>
          {question.options.length ? (
            <div className="mt-3 grid gap-2">
              {question.options.map((option) => {
                const isSelected = currentAnswer.trim().toLowerCase() === option.value.trim().toLowerCase();
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={interruptControlsDisabled}
                    onClick={() => setStructuredAnswer(question.id, option.value)}
                    className={`w-full rounded-lg border px-3 py-2.5 text-left transition-all duration-200 ${
                      isSelected
                        ? 'border-sky-300 bg-sky-50 text-sky-900 shadow-[0_0_0_1px_rgba(14,165,233,0.14)]'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
                    } ${interruptControlsDisabled ? 'cursor-not-allowed opacity-60' : ''}`}
                  >
                    <span className="block text-sm font-semibold">{option.label}</span>
                    {option.description ? (
                      <span className="mt-1 block text-xs leading-relaxed text-slate-500">
                        {option.description}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="mt-3">
            <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Your answer
            </label>
            <textarea
              value={currentAnswer}
              onChange={(event) => setStructuredAnswer(question.id, event.target.value)}
              rows={question.options.length ? 3 : 5}
              disabled={interruptControlsDisabled}
              placeholder="Add the exact answer you want the agent to use."
              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-700 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
            />
          </div>
        </div>
      </div>
    );
  };

  const renderStructuredClarificationForm = () => {
    if (!hasStructuredClarificationForm) {
      return null;
    }

    if (hasMultiQuestionClarificationWizard) {
      const answeredCount = structuredClarificationQuestions.filter(
        (question) => readInterruptAnswerText(structuredAnswerMap[question.id]).trim().length > 0,
      ).length;
      const progress = ((Math.min(wizardStepIndex, structuredClarificationQuestions.length) + 1)
        / (structuredClarificationQuestions.length + 1)) * 100;

      if (isWizardReviewStep) {
        return (
          <div className="mt-3 space-y-3">
            <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Review</p>
                </div>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
                  {answeredCount}/{structuredClarificationQuestions.length} answered
                </span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-sky-400 transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
              <div className="mt-3 space-y-2">
                {structuredClarificationQuestions.map((question) => (
                  <div key={question.id} className="rounded-lg border border-slate-200/80 bg-white px-3 py-2.5">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      {question.header}
                    </p>
                    <p className="mt-1 text-sm text-slate-700">
                      {readInterruptAnswerText(structuredAnswerMap[question.id]) || 'Not answered'}
                    </p>
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Notes for the agent
                </label>
                <textarea
                  value={clarificationDraftValue}
                  onChange={(event) => setInterruptValue(clarificationTextKey, event.target.value)}
                  rows={4}
                  disabled={interruptControlsDisabled}
                  placeholder="Add any extra constraints, preferences, or context."
                  className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-700 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                disabled={interruptControlsDisabled}
                onClick={() => setWizardStepIndex(Math.max(0, structuredClarificationQuestions.length - 1))}
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-all duration-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Back
              </button>
              {renderStructuredSubmitButtons('end')}
            </div>
          </div>
        );
      }

      const currentAnswer = currentWizardQuestion
        ? readInterruptAnswerText(structuredAnswerMap[currentWizardQuestion.id])
        : '';
      return (
        <div className="mt-3 space-y-3">
          <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Question {Math.min(wizardStepIndex + 1, structuredClarificationQuestions.length)} of {structuredClarificationQuestions.length}
                </p>
              </div>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
                {answeredCount}/{structuredClarificationQuestions.length} answered
              </span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-sky-400 transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
          </div>
          {currentWizardQuestion ? renderStructuredQuestionEditor(currentWizardQuestion) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              disabled={interruptControlsDisabled || wizardStepIndex === 0}
              onClick={() => setWizardStepIndex((current) => Math.max(0, current - 1))}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-all duration-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Back
            </button>
            <button
              type="button"
              disabled={interruptControlsDisabled || !currentAnswer.trim()}
              onClick={() => setWizardStepIndex((current) => Math.min(structuredClarificationQuestions.length, current + 1))}
              className="rounded-xl border border-sky-200 bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white transition-all duration-200 hover:bg-sky-500/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {wizardStepIndex === structuredClarificationQuestions.length - 1 ? 'Review answers' : 'Next'}
            </button>
          </div>
        </div>
      );
    }

    const singleQuestion = structuredClarificationQuestions[0];
    return (
      <div className="mt-3 space-y-3">
        {singleQuestion ? renderStructuredQuestionEditor(singleQuestion) : null}
        <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3">
          <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Notes for the agent
          </label>
          <textarea
            value={clarificationDraftValue}
            onChange={(event) => setInterruptValue(clarificationTextKey, event.target.value)}
            rows={4}
            disabled={interruptControlsDisabled}
            placeholder="Add any extra context that should travel with your answer."
            className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-700 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
          />
        </div>
        {renderStructuredSubmitButtons('end')}
      </div>
    );
  };

  const renderStylePreviewChooser = () => {
    if (!hasStylePreviewChooser) {
      return null;
    }

    return (
      <div className="mt-3 space-y-4">
        {activeStylePreviewChoice ? (
          <div className="overflow-hidden rounded-2xl border border-slate-200/90 bg-slate-950 shadow-[0_18px_48px_-32px_rgba(15,23,42,0.32)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-slate-900 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{activeStylePreviewChoice.label}</p>
                {activeStylePreviewChoice.description ? (
                  <p className="mt-0.5 truncate text-xs text-slate-300">{activeStylePreviewChoice.description}</p>
                ) : null}
              </div>
              {activeStylePreviewChoice.downloadUrl ? (
                <a
                  href={activeStylePreviewChoice.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/15"
                >
                  Download preview
                </a>
              ) : null}
            </div>
            <div className="relative aspect-[16/10] min-h-[260px] bg-slate-950 sm:min-h-[360px]">
              {activeStylePreviewChoice.previewUrl ? (
                <iframe
                  key={activeStylePreviewChoice.previewUrl}
                  title={`${activeStylePreviewChoice.label} live preview`}
                  src={activeStylePreviewChoice.previewUrl}
                  loading="lazy"
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  className="h-full w-full border-0 bg-white"
                />
              ) : activeStylePreviewChoice.html ? (
                <iframe
                  key={`${activeStylePreviewChoice.id}:inline`}
                  title={`${activeStylePreviewChoice.label} live preview`}
                  srcDoc={activeStylePreviewChoice.html}
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
        ) : null}

        <div className="grid gap-3 md:grid-cols-3">
          {stylePreviewChoices.map((choice) => {
            const isSelectedChoice = selectedChoiceIds.includes(choice.id);
            const isActiveChoice = activeStylePreviewChoice?.id === choice.id;
            const previewAction: RenderableInterruptAction = {
              id: `choice:${choice.id}`,
              label: choice.label,
              description: choice.description,
              style: 'secondary',
              inputMode: 'none',
              value: choice.value,
              source: 'clarification-choice',
              choiceId: choice.id,
            };
            return (
              <div
                key={choice.id}
                role="button"
                tabIndex={interruptControlsDisabled ? -1 : 0}
                onClick={() => {
                  if (!interruptControlsDisabled) {
                    setActiveStylePreviewId(choice.id);
                  }
                }}
                onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                  if (interruptControlsDisabled) {
                    return;
                  }
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setActiveStylePreviewId(choice.id);
                  }
                }}
                className={`overflow-hidden rounded-xl border bg-white text-left transition-all duration-200 ${
                  interruptControlsDisabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'
                } ${
                  isSelectedChoice || isActiveChoice
                    ? 'border-sky-300 shadow-[0_0_0_1px_rgba(14,165,233,0.18)]'
                    : 'border-slate-200/90 hover:border-slate-300'
                }`}
              >
                <div className="relative aspect-[16/10] overflow-hidden bg-slate-950">
                  {choice.previewUrl ? (
                    <iframe
                      title={`${choice.label} preview`}
                      src={choice.previewUrl}
                      loading="lazy"
                      sandbox="allow-scripts"
                      referrerPolicy="no-referrer"
                      className="pointer-events-none h-[250%] w-[250%] origin-top-left scale-[0.4] border-0 bg-white"
                    />
                  ) : choice.html ? (
                    <iframe
                      title={`${choice.label} preview`}
                      srcDoc={choice.html}
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
                  {isSelectedChoice ? (
                    <div className="absolute right-3 top-3 rounded-full bg-sky-500 p-1.5 text-white shadow-lg">
                      <CheckCircle2 size={16} />
                    </div>
                  ) : null}
                </div>
                <div className="space-y-3 p-4">
                  <div>
                    <p className="text-sm font-semibold leading-snug text-slate-900">{choice.label}</p>
                    {choice.description ? (
                      <p className="mt-1 text-xs leading-relaxed text-slate-500">{choice.description}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={interruptControlsDisabled}
                      onClick={() => handleActionTrigger(previewAction)}
                      className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60 ${
                        isSelectedChoice
                          ? 'border-sky-500 bg-sky-500 text-white'
                          : 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800'
                      }`}
                    >
                      {isSelectedChoice ? 'Selected' : 'Use this style'}
                    </button>
                    {choice.previewUrl ? (
                      <a
                        href={choice.previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition-all duration-200 hover:bg-slate-50 hover:text-slate-900"
                      >
                        Open preview
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {pendingInterrupt?.responseSpec?.multiple ? (
          <div className="mt-4">{renderStructuredSubmitButtons('end')}</div>
        ) : null}
      </div>
    );
  };

  const renderInterruptActions = (tone: 'light' | 'dark', layout: 'stack' | 'approval-row' = 'stack') => {
    if (!interruptActions.length) {
      return null;
    }

    return (
      <div className={
        layout === 'approval-row'
          ? 'mt-4 flex flex-wrap items-center gap-2'
          : tone === 'dark' ? 'mt-5 space-y-3' : 'mt-3 space-y-2'
      }>
        {interruptActions.map((action, index) => {
          const inputKey = getActionInputKey(action);
          const inputValue = interruptInputByMessageId[inputKey] || '';
          const isTextMode = activeTextActionId === action.id && action.inputMode === 'text';
          const needsExplicitConfirm = Boolean(action.confirm && confirmActionId === action.id);
          const showConfirmationOnly = needsExplicitConfirm && action.inputMode !== 'text';
          const showPrimaryRow = !isTextMode && !showConfirmationOnly;
          const numberedChoice = tone === 'dark' && action.source === 'clarification-choice';
          const isSelectedChoice = Boolean(
            action.source === 'clarification-choice' &&
            action.choiceId &&
            selectedChoiceIds.includes(action.choiceId),
          );
          const standardChoiceSelectionClass = !numberedChoice && isSelectedChoice
            ? tone === 'dark'
              ? 'ring-2 ring-[#94c5f8]/65 ring-offset-0'
              : 'border-[#94c5f8] bg-blue-50 text-blue-800 shadow-[0_0_0_1px_rgba(148,197,248,0.35)]'
            : '';

          return (
            <div
              key={action.id}
              className={
                layout === 'approval-row' && !isTextMode && !showConfirmationOnly
                  ? action.style === 'danger'
                    ? 'ml-1'
                    : ''
                  : layout === 'approval-row'
                    ? 'w-full space-y-2'
                    : tone === 'dark' ? 'space-y-3' : 'space-y-2'
              }
            >
              {showPrimaryRow ? (
                <button
                  type="button"
                  disabled={interruptControlsDisabled}
                  onClick={() => handleActionTrigger(action)}
                  className={
                    numberedChoice
                      ? `flex w-full items-start justify-between rounded-[1.35rem] border px-5 py-4 text-left transition-all duration-200 ${
                          isSelectedChoice
                            ? 'border-[#94c5f8] bg-[#94c5f8]/18 text-white shadow-[0_0_0_1px_rgba(148,197,248,0.35)]'
                            : action.style === 'primary'
                              ? 'border-[#94c5f8]/55 bg-[#94c5f8]/10 text-white hover:bg-[#94c5f8]/15'
                              : action.style === 'danger'
                                ? 'border-rose-400/25 bg-rose-500/10 text-rose-100 hover:bg-rose-500/15'
                                : 'border-white/10 bg-white/[0.03] text-white/92 hover:border-white/25 hover:bg-white/[0.07]'
                        } ${interruptControlsDisabled ? 'cursor-not-allowed opacity-70' : ''}`
                      : `${getActionButtonClass(action, tone)} ${standardChoiceSelectionClass}`
                  }
                >
                  {numberedChoice ? (
                    <>
                      <div className="min-w-0 pr-3">
                        <div className="flex items-center gap-3">
                          <span className="text-2xl font-semibold text-white/45">{index + 1}.</span>
                          <span className="text-[18px] font-semibold leading-snug">{action.label}</span>
                        </div>
                      </div>
                      <span className="mt-1 text-lg text-white/35">
                        {isSelectedChoice ? '✓' : needsExplicitConfirm ? '!' : ''}
                      </span>
                    </>
                  ) : (
                    <span className="min-w-0 text-left">
                      <span className="block">{action.label}</span>
                      {action.description ? (
                        <span className={tone === 'dark' ? 'mt-1 block text-xs font-normal text-white/58' : 'mt-1 block text-[11px] font-normal leading-relaxed text-slate-500'}>
                          {action.description}
                        </span>
                      ) : null}
                    </span>
                  )}
                </button>
              ) : null}
              {showConfirmationOnly ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={interruptControlsDisabled}
                    onClick={() => void handleInterruptAction(message, action, pendingInterrupt)}
                    className={getActionButtonClass(
                      {
                        ...action,
                        label: action.submitLabel || `Confirm ${action.label}`,
                        style: action.style === 'danger' ? 'danger' : 'primary',
                      },
                      tone,
                    )}
                  >
                    {action.submitLabel || `Confirm ${action.label}`}
                  </button>
                  <button
                    type="button"
                    disabled={interruptControlsDisabled}
                    onClick={handleActionCancel}
                    className={tone === 'dark'
                      ? 'rounded-full px-4 py-2 text-sm font-medium text-white/70 transition-all duration-200 hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-40'
                      : 'rounded-xl border border-slate-300/80 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-all duration-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60'}
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
              {isTextMode ? (
                <div className={tone === 'dark' ? 'space-y-3' : 'space-y-2'}>
                  <textarea
                    value={inputValue}
                    onChange={(event) => setInterruptValue(inputKey, event.target.value)}
                    rows={tone === 'dark' ? 4 : 4}
                    autoFocus
                    disabled={interruptControlsDisabled}
                    placeholder={action.placeholder || 'Enter your response'}
                    className={tone === 'dark'
                      ? 'w-full rounded-[1.35rem] border border-white/10 bg-white/[0.03] px-5 py-4 text-sm leading-relaxed text-white placeholder:text-white/32 focus:border-white/25 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70'
                      : 'w-full rounded-xl border border-slate-200/80 bg-white/85 p-3 text-sm text-slate-700 backdrop-blur-sm focus:border-sky-400 focus:outline-none'}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={interruptControlsDisabled}
                      onClick={() => void handleInterruptAction(message, action, pendingInterrupt)}
                      className={getActionButtonClass(
                        {
                          ...action,
                          label: action.submitLabel || action.label,
                          style: action.style === 'danger' ? 'danger' : 'primary',
                        },
                        tone,
                      )}
                    >
                      {interruptBusy ? (
                        <span className="inline-flex items-center gap-2">
                          <Loader2 size={16} className="animate-spin" />
                          {action.submitLabel || action.label}
                        </span>
                      ) : (
                        action.submitLabel || action.label
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={interruptControlsDisabled}
                      onClick={handleActionCancel}
                      className={tone === 'dark'
                        ? 'rounded-full px-4 py-2 text-sm font-medium text-white/70 transition-all duration-200 hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-40'
                        : 'rounded-xl border border-slate-300/80 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-all duration-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60'}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };

  const approvalCreateImpacts = approvalReview
    ? approvalReview.steps.flatMap((step) => step.fileImpacts.filter((impact) => impact.action === 'create'))
    : [];
  const approvalUpdateImpacts = approvalReview
    ? approvalReview.steps.flatMap((step) => step.fileImpacts.filter((impact) => impact.action === 'update'))
    : [];
  const shouldShowApprovalDescription = Boolean(approvalReview?.description && !approvalReview.summaryMarkdown);

  const agentContainerClassName = isDarkMode
    ? 'w-full rounded-xl border border-[#2a3850] bg-[#121c2e] px-4 py-4 text-slate-100 shadow-[0_16px_40px_-32px_rgba(2,6,23,0.88)]'
    : 'w-full rounded-xl border border-slate-200/90 bg-white px-4 py-4 text-slate-900 shadow-[0_16px_40px_-32px_rgba(15,23,42,0.16)]';
  const agentMetaClassName = isDarkMode
    ? 'flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wide text-slate-300'
    : 'flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wide text-slate-500';
  const agentPersonaClassName = isDarkMode ? 'text-slate-300' : 'text-slate-700';
  const toolPanelClassName = isDarkMode
    ? 'mt-3 border-t border-[#26354d] pt-3'
    : 'mt-3 border-t border-slate-200/80 pt-3';
  const toolButtonClassName = isDarkMode
    ? 'text-xs font-medium text-slate-400 transition-all duration-200 hover:text-slate-200'
    : 'text-xs font-medium text-slate-500 transition-all duration-200 hover:text-slate-700';
  const activitySummaryLabel = toolDigest.stepProgress
    ? effectiveStatus === 'awaiting_approval'
      ? interruptKind === 'clarification'
        ? 'Workflow status: Waiting for input'
        : 'Workflow status: Interrupted for approval'
      : toolDigest.lastActivityFormatted
      ? `Activity · updated ${toolDigest.lastActivityFormatted}`
      : 'Activity'
    : 'Activity';
  const liveAgentPreviewText = visibleAgentText;
  const latestToolFinishedAt = [...toolEvents].reverse().find((event) => event.finishedAt)?.finishedAt;
  const thoughtEndedAt = isLiveAgentStatus ? undefined : latestToolFinishedAt || message.updatedAt || message.createdAt;
  const thoughtElapsed = formatElapsedTime(runClockAnchor || message.createdAt, now, thoughtEndedAt);
  const compactThoughtElapsed = thoughtElapsed.replace(/^0m\s0?(\d+)s$/, '$1s');
  const shouldShowThoughtRow = Boolean(
    isAgentMessage
    && (isLiveAgentStatus || hasToolEvents || displayThinkingText || progressEvents.length > 0)
    && !shouldHideAgentBodyForApproval,
  );
  const thoughtSummaryItems = toolDigest.digestEvents.slice(-6);
  const recentToolSummaryItems = toolDigest.digestEvents.slice(-5);
  const canExpandThought = Boolean(
    progressEvents.length > 0 ||
    thoughtSummaryItems.length ||
    toolDigest.currentLabel ||
    displayThinkingText
  );
  const thoughtRowClassName = isDarkMode
    ? 'mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-slate-400 transition-colors hover:text-slate-200'
    : 'mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-700';
  const thoughtPanelClassName = isDarkMode
    ? 'mt-2 rounded-lg border border-[#26354d] bg-[#0d1524] px-3 py-3 text-xs text-slate-200'
    : 'mt-2 rounded-lg border border-slate-200/80 bg-slate-50/90 px-3 py-3 text-xs text-slate-700';
  const toolExpandedClassName = isDarkMode
    ? 'mt-3 space-y-3 text-xs text-slate-200'
    : 'mt-3 space-y-3 text-xs text-slate-600';
  const userPathPillClassName = 'inline-flex max-w-full items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-medium text-white';
  const userBubbleClassName = isDarkMode
    ? 'rounded-xl bg-[#2d5f9f] px-4 py-3 text-sm text-white shadow-[0_14px_34px_-28px_rgba(45,95,159,0.82)]'
    : 'rounded-xl bg-[#315f9f] px-4 py-3 text-sm text-white shadow-[0_14px_34px_-28px_rgba(49,95,159,0.42)]';
  const inlineEditTextareaClassName =
    'min-h-24 w-full resize-y rounded-lg border border-white/10 bg-black/15 px-3 py-2.5 text-sm leading-relaxed text-white placeholder:text-white/45 shadow-inner shadow-black/10 outline-none transition-all duration-150 focus:border-white/25 focus:bg-black/20 focus:ring-2 focus:ring-white/15';
  const inlineEditButtonBaseClassName =
    'inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 disabled:cursor-not-allowed disabled:opacity-50';
  const messageActionBarClassName = isDarkMode
    ? 'absolute -top-2.5 right-2 inline-flex items-center gap-0.5 rounded-lg border border-slate-600/90 bg-slate-900 p-0.5 text-slate-300 opacity-0 shadow-none transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100'
    : 'absolute -top-2.5 right-2 inline-flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white p-0.5 text-slate-500 opacity-0 shadow-none transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100';
  const messageActionButtonClassName = isDarkMode
    ? 'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150 hover:bg-slate-800 hover:text-white focus-visible:bg-slate-800 focus-visible:text-white focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50'
    : 'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900 focus-visible:bg-slate-100 focus-visible:text-slate-900 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';

  useEffect(() => {
    if (!inlineStatus) {
      return;
    }
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [inlineStatus]);

  return (
    <div className={`group flex items-start gap-3 motion-safe:animate-[chat-pane-message-in_220ms_ease-out] ${isAgentMessage ? '' : 'justify-end'}`}>
      <div style={{ width: '100%', maxWidth: messageBubbleMaxWidth }} className="relative flex-1 md:flex-initial">
        {isAgentMessage ? (
          <div className={agentContainerClassName}>
            <div className={agentMetaClassName}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className={agentPersonaClassName}>{personaDisplayName}</span>
              </div>
              {timestampLabel ? (
                <span className={`text-[10px] font-medium normal-case tracking-normal ${
                  isDarkMode ? 'text-slate-500' : 'text-slate-400'
                }`}>
                  {timestampLabel}
                </span>
              ) : null}
            </div>
            {shouldShowThoughtRow ? (
              <div>
                <button
                  type="button"
                  onClick={() => canExpandThought && toggleThinkingVisibility(message.id)}
                  className={`${thoughtRowClassName} ${canExpandThought ? '' : 'cursor-default hover:text-inherit'}`}
                  aria-expanded={canExpandThought ? isThinkingExpanded : undefined}
                >
                  <span>
                    {`Thought for ${compactThoughtElapsed || '0s'}`}
                  </span>
                  {canExpandThought ? (
                    <ChevronRight
                      size={15}
                      className={`transition-transform duration-150 ${isThinkingExpanded ? 'rotate-90' : ''}`}
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
                {canExpandThought && isThinkingExpanded ? (
                  <div className={thoughtPanelClassName}>
                    {progressEvents.length > 0 ? (
                      <div className="space-y-3">
                        <div className={`text-[10px] font-bold uppercase tracking-widest ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                          Process Execution Flow
                        </div>
                        <ul className="relative ml-1.5 space-y-4 border-l border-slate-200 pl-4 dark:border-slate-800/80">
                          {effectiveProgressEvents.map((event, index) => {
                            const isRunning = event.status === 'running';
                            const isCompleted = event.status === 'completed';
                            const isError = event.status === 'error';

                            return (
                              <li key={index} className="relative leading-relaxed">
                                <span className={`absolute -left-[21px] top-1.5 flex h-2 w-2 items-center justify-center rounded-full border ${
                                  isCompleted
                                    ? 'bg-sky-500 border-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.3)]'
                                    : isRunning
                                      ? 'bg-sky-500 border-sky-500 animate-pulse'
                                      : isError
                                        ? 'bg-rose-500 border-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.3)]'
                                        : 'bg-slate-200 border-slate-300 dark:bg-slate-800 dark:border-slate-700'
                                }`} />
                                
                                <div className="min-w-0">
                                  <p className={`font-semibold text-xs ${
                                    isRunning 
                                      ? 'text-sky-500 animate-pulse' 
                                      : isCompleted 
                                        ? isDarkMode ? 'text-slate-200' : 'text-slate-800'
                                        : isDarkMode ? 'text-slate-500' : 'text-slate-400'
                                  }`}>
                                    {event.label}
                                  </p>
                                  {event.detail ? (
                                    <p className={`mt-0.5 text-[11px] leading-normal ${
                                      isDarkMode ? 'text-slate-400' : 'text-slate-500'
                                    }`}>
                                      {event.detail}
                                    </p>
                                  ) : null}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                        {recentToolSummaryItems.length ? (
                          <div className={`rounded-md border px-3 py-2 ${
                            isDarkMode ? 'border-slate-800 bg-slate-950/45' : 'border-slate-200 bg-white/70'
                          }`}>
                            <div className={`mb-2 text-[10px] font-bold uppercase tracking-widest ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                              Recent Activity
                            </div>
                            <ul className="space-y-2">
                              {recentToolSummaryItems.map((event) => (
                                <li key={event.id} className="flex min-w-0 items-start gap-2 leading-relaxed">
                                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                                    event.status === 'error'
                                      ? 'bg-rose-500'
                                      : event.status === 'completed'
                                        ? 'bg-emerald-400'
                                        : 'animate-pulse bg-sky-500'
                                  }`} />
                                  <div className="min-w-0 flex-1">
                                    <p className={`font-semibold ${
                                      event.status === 'error'
                                        ? isDarkMode ? 'text-rose-300' : 'text-rose-700'
                                        : isDarkMode ? 'text-slate-200' : 'text-slate-800'
                                    }`}>
                                      {event.title}
                                    </p>
                                    {event.detail ? (
                                      <p className={`mt-0.5 line-clamp-2 text-[11px] leading-normal ${
                                        isDarkMode ? 'text-slate-400' : 'text-slate-500'
                                      }`}>
                                        {event.detail}
                                      </p>
                                    ) : null}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    ) : thoughtSummaryItems.length ? (
                      <ul className="space-y-2">
                        {thoughtSummaryItems.map((event) => (
                          <li key={event.id} className="leading-relaxed">
                            <span className="font-semibold">{event.title}</span>
                            {event.detail ? (
                              <span className={isDarkMode ? 'block text-slate-400' : 'block text-slate-500'}>
                                {event.detail}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="leading-relaxed">{toolDigest.currentLabel || DEFAULT_THINKING_PLACEHOLDER}</p>
                    )}
                    {toolDigest.errorCount ? (
                      <p className={`mt-2 font-semibold ${isDarkMode ? 'text-rose-300' : 'text-rose-700'}`}>
                        {`${toolDigest.errorCount} tool issue${toolDigest.errorCount === 1 ? '' : 's'} detected.`}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {inlineStatus ? (
              <div className={`mt-3 rounded-xl border p-3.5 backdrop-blur-md shadow-sm transition-all duration-300 ${
                isDarkMode 
                  ? 'border-slate-800/80 bg-slate-900/50 text-slate-100' 
                  : 'border-slate-200/80 bg-slate-50/80 text-slate-900'
              }`}>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="relative flex h-2 w-2">
                      {inlineStatus.status === 'running' ? (
                        <>
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-sky-500"></span>
                        </>
                      ) : (
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className={`text-sm font-semibold leading-snug tracking-tight ${
                        isDarkMode ? 'text-slate-100' : 'text-slate-900'
                      }`}>
                        {inlineStatus.status === 'awaiting_approval' 
                          ? 'Waiting for approval' 
                          : (activeProgress?.label || latestProgress?.label || inlineStatus.detail)}
                      </p>
                      {activeProgress?.detail ? (
                        <p className={`mt-0.5 text-xs ${
                          isDarkMode ? 'text-slate-400' : 'text-slate-500'
                        }`}>
                          {activeProgress.detail}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>

                {activeProgress?.stepIndex && activeProgress?.stepCount ? (
                  <div className="mt-3">
                    <div className={`h-1.5 w-full overflow-hidden rounded-full ${
                      isDarkMode ? 'bg-slate-800' : 'bg-slate-200'
                    }`}>
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-500 transition-all duration-500 ease-out"
                        style={{
                          width: `${Math.min(100, Math.max(0, Math.round((activeProgress.stepIndex / activeProgress.stepCount) * 100)))}%`,
                        }}
                      />
                    </div>
                    <p className={`mt-1.5 text-[11px] font-medium leading-none ${
                      isDarkMode ? 'text-slate-500' : 'text-slate-400'
                    }`}>
                      Step {activeProgress.stepIndex} of {activeProgress.stepCount}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {liveAgentPreviewText ? (
              <div className="agent-markdown mt-3 text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {liveAgentPreviewText}
                </ReactMarkdown>
              </div>
            ) : shouldShowFallbackStatus && !inlineStatus ? (
              <span className={`mt-3 block text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                {displayThinkingText ? 'Finalizing response...' : 'Thinking...'}
              </span>
            ) : null}
            {a2uiRequest && isA2UINativeEnabled ? (
              <div className="mt-3">
                <A2UISurfaceRenderer
                  request={a2uiRequest}
                  onSubmit={(response) => {
                    if (onA2UISubmit) {
                      return onA2UISubmit(response, a2uiRequest, message);
                    }
                    return Promise.reject(new Error('onA2UISubmit handler not provided'));
                  }}
                  workspaceId={workspaceId}
                />
              </div>
            ) : null}
            {pendingInterrupt && !isClarificationInterrupt && !(a2uiRequest && isA2UINativeEnabled) ? (
              <div className="mt-3">
                <div className="rounded-xl border border-slate-200/90 bg-white px-4 py-4 text-slate-900 shadow-[0_16px_40px_-32px_rgba(15,23,42,0.16)]">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-800">
                        <CheckCircle2 size={12} />
                        {approvalReview?.badgeLabel || 'Pending Approval'}
                      </span>
                      <p className="mt-3 text-[15px] font-semibold leading-snug tracking-tight text-slate-900">
                        {approvalReview?.planTitle || 'Proposed plan'}
                      </p>
                      {shouldShowApprovalDescription ? (
                        <p className="mt-1 text-xs leading-relaxed text-slate-500">
                          {approvalReview?.description || pendingInterrupt.description || 'Review the proposed action before execution continues.'}
                        </p>
                      ) : null}
                    </div>
                    {approvalReview?.stepCount && approvalReview.stepCount > 1 ? (
                      <div className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium text-slate-500">
                        Review needed
                      </div>
                    ) : null}
                  </div>

                  {approvalReview ? (
                    <div className="mt-3 space-y-3">
                      <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3">
                        <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                          <span>Plan File</span>
                          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-[10px] normal-case tracking-normal text-slate-700">
                            {approvalReview.planFilePath}
                          </span>
                        </div>
                        {approvalReview.summaryMarkdown ? (
                          <div className="agent-markdown mt-3 text-sm leading-relaxed text-slate-700">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                              {approvalReview.summaryMarkdown}
                            </ReactMarkdown>
                          </div>
                        ) : null}
                      </div>

                      {approvalReview.steps.length ? (
                        <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Execution Map
                          </p>
                          <div className="mt-3 space-y-2">
                            {approvalReview.steps.map((step, index) => (
                              <div key={`${step.title}-${index}`} className="rounded-lg border border-slate-200/80 bg-white p-2.5">
                                <div className="flex items-start gap-3">
                                  <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                                    step.state === 'completed'
                                      ? 'bg-emerald-500 text-white'
                                      : step.state === 'pending'
                                        ? 'bg-slate-200 text-slate-600'
                                        : 'bg-slate-900 text-white'
                                  }`}>
                                    {step.state === 'completed' ? <Check size={14} strokeWidth={2.4} /> : index + 1}
                                  </span>
                                  <div className="min-w-0">
                                    <p className="text-sm font-semibold leading-snug text-slate-900">{step.title}</p>
                                    {step.detail ? (
                                      <p className="mt-1 text-xs leading-relaxed text-slate-500">{step.detail}</p>
                                    ) : null}
                                    {step.toolNames.length ? (
                                      <div className="mt-3 flex flex-wrap gap-2">
                                        {step.toolNames.map((toolName) => (
                                          <span
                                            key={`${step.title}-${toolName}`}
                                            className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 shadow-sm"
                                          >
                                            {toolName}
                                          </span>
                                        ))}
                                      </div>
                                    ) : null}
                                    {step.fileImpacts.length ? (
                                      <div className="mt-3 flex flex-wrap gap-2">
                                        {step.fileImpacts.map((impact) => (
                                          <span
                                            key={`${step.title}-${impact.action}-${impact.path}`}
                                            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                                              impact.action === 'create'
                                                ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                                                : 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
                                            }`}
                                          >
                                            {impact.action === 'create' ? 'Create' : 'Update'}: {impact.path}
                                          </span>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {approvalCreateImpacts.length || approvalUpdateImpacts.length ? (
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Create</p>
                            <div className="mt-2 space-y-1.5 text-sm text-emerald-900">
                              {approvalCreateImpacts.length ? approvalCreateImpacts.map((impact, index) => (
                                <p key={`${impact.path}-${index}`}>{impact.path}</p>
                              )) : <p className="text-emerald-800/70">No new files.</p>}
                            </div>
                          </div>
                          <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Update</p>
                            <div className="mt-2 space-y-1.5 text-sm text-blue-900">
                              {approvalUpdateImpacts.length ? approvalUpdateImpacts.map((impact, index) => (
                                <p key={`${impact.path}-${index}`}>{impact.path}</p>
                              )) : <p className="text-blue-800/70">No existing files updated.</p>}
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {approvalReview.riskyActions ? (
                        <div className="rounded-xl border border-rose-200/80 bg-rose-50/70 p-3">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-rose-700">Risk Notes</p>
                          <p className="mt-2 text-sm leading-relaxed text-rose-900">{approvalReview.riskyActions}</p>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-3 grid gap-2">
                      {approvalDisplayPayload}
                      {isPlanApprovalRequest || planText ? (
                        <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-200/70 bg-white/60 p-3 text-sm whitespace-pre-wrap text-slate-700">
                          {planText || 'No plan details were provided.'}
                        </div>
                      ) : null}
                    </div>
                  )}


                  {interruptError ? (
                    <div className="mt-4 rounded-xl border border-rose-200/90 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                      {interruptError}
                    </div>
                  ) : null}

                  <div>{renderInterruptActions('light', 'approval-row')}</div>
                </div>
              </div>
            ) : null}
            {pendingInterrupt && isClarificationInterrupt && !clarificationDismissed && !(a2uiRequest && isA2UINativeEnabled) ? (
              <div className="mt-3 rounded-xl border border-slate-200/90 bg-white px-4 py-4 text-slate-900 shadow-[0_16px_40px_-32px_rgba(15,23,42,0.16)]">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-[10px] font-semibold text-sky-800">
                      <Loader2 size={12} className="animate-spin" />
                      Input needed
                    </span>
                    <p className="mt-3 text-[15px] font-semibold leading-snug tracking-tight text-slate-900">
                      {pendingInterrupt.title || (isDynamicActionInterrupt ? 'Select the next step' : 'The agent needs clarification')}
                    </p>
                    {pendingInterrupt.description && !hasStructuredClarificationForm && !hasStylePreviewChooser ? (
                      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">
                        {pendingInterrupt.description}
                      </p>
                    ) : null}
                  </div>
                  {pendingInterrupt.stepCount && pendingInterrupt.stepCount > 1 ? (
                    <div className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium text-slate-500">
                      Question {typeof pendingInterrupt.stepIndex === 'number' ? pendingInterrupt.stepIndex + 1 : 1}/{pendingInterrupt.stepCount}
                    </div>
                  ) : null}
                </div>
                {clarificationDisplayPayload ? <div className="mt-3">{clarificationDisplayPayload}</div> : null}
                {interruptError ? (
                  <div className="mt-3 rounded-xl border border-rose-200/90 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                    {interruptError}
                  </div>
                ) : null}
                {hasStructuredClarificationForm ? (
                  renderStructuredClarificationForm()
                ) : hasStylePreviewChooser ? (
                  renderStylePreviewChooser()
                ) : (
                  renderInterruptActions('light')
                )}
                <div className="mt-3 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    disabled={!allowDismiss || interruptBusy}
                    onClick={() => setClarificationDismissed(true)}
                    className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-all duration-200 ${
                      allowDismiss
                        ? 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                        : 'cursor-not-allowed text-slate-300'
                    }`}
                  >
                    {pendingInterrupt.responseSpec?.dismissLabel || 'Dismiss'}
                  </button>
                </div>
              </div>
            ) : null}
            {pendingInterrupt && isClarificationInterrupt && clarificationDismissed && !(a2uiRequest && isA2UINativeEnabled) ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200/80 bg-amber-50/70 px-4 py-3 text-slate-900">
                <div className="min-w-0">
                  <p className="text-sm font-semibold leading-snug text-slate-900">
                    Input is hidden
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-600">
                    The agent is still waiting for this response before it can continue.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={interruptBusy}
                  onClick={() => setClarificationDismissed(false)}
                  className="rounded-xl border border-amber-200 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 transition-all duration-200 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Show input
                </button>
              </div>
            ) : null}
            {hasToolEvents ? (
              <div className={toolPanelClassName}>
                <button
                  type="button"
                  onClick={() => toggleToolActivityVisibility(message.id)}
                  className={toolButtonClassName}
                >
                  {isToolActivityExpanded ? 'Hide activity' : activitySummaryLabel}
                </button>
                {isToolActivityExpanded ? (
                  <div className="mt-2 space-y-3">
                    <div className={toolExpandedClassName}>
                      <p className={`text-xs font-medium ${
                        isDarkMode ? 'text-slate-400' : 'text-slate-500'
                      }`}>
                        What changed
                      </p>
                      {toolDigest.reviewedFiles.length ? (
                        <div className="mt-3">
                          <p className={`text-xs font-medium ${
                            isDarkMode ? 'text-slate-400' : 'text-slate-500'
                          }`}>
                            Files reviewed
                          </p>
                          <ul className={`mt-1.5 list-inside list-disc space-y-1 text-sm leading-relaxed ${
                            isDarkMode ? 'text-slate-200' : 'text-slate-800'
                          }`}>
                            {toolDigest.reviewedFiles.map((name) => (
                              <li key={`review-${name}`} className="break-words">
                                {name}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {toolDigest.updatedFileBasenames.length ? (
                        <div className="mt-3">
                          <p className={`text-xs font-medium ${
                            isDarkMode ? 'text-slate-400' : 'text-slate-500'
                          }`}>
                            Files being updated
                          </p>
                          <ul className={`mt-1.5 list-inside list-disc space-y-1 text-sm leading-relaxed ${
                            isDarkMode ? 'text-slate-200' : 'text-slate-800'
                          }`}>
                            {toolDigest.updatedFileBasenames.map((name) => (
                              <li key={`upd-${name}`} className="break-words">
                                {name}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {toolDigest.updatesInProgress.length ? (
                        <div className="mt-3">
                          <p className={`text-xs font-medium ${
                            isDarkMode ? 'text-slate-400' : 'text-slate-500'
                          }`}>
                            Updates in progress
                          </p>
                          <ul className={`mt-1.5 list-inside list-disc space-y-1 text-sm leading-relaxed ${
                            isDarkMode ? 'text-slate-200' : 'text-slate-800'
                          }`}>
                            {toolDigest.updatesInProgress.map((line) => (
                              <li key={line} className="break-words">
                                {line}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {!toolDigest.reviewedFiles.length && !toolDigest.updatedFileBasenames.length && toolDigest.digestEvents.length ? (
                        <div className="mt-3 space-y-2">
                          <p className={`text-xs font-medium ${
                            isDarkMode ? 'text-slate-400' : 'text-slate-500'
                          }`}>
                            Recent steps
                          </p>
                          <ul className="space-y-2">
                            {toolDigest.digestEvents.slice(-12).reverse().map((evt) => (
                              <li
                                key={evt.id}
                                className={`border-b pb-2 text-sm last:border-b-0 ${
                                  isDarkMode ? 'border-slate-700/80' : 'border-slate-200'
                                }`}
                              >
                                <span className="font-semibold">{evt.title}</span>
                                {evt.detail ? (
                                  <span className={`mt-0.5 block text-xs leading-relaxed ${
                                    isDarkMode ? 'text-slate-300' : 'text-slate-600'
                                  }`}>
                                    {evt.detail}
                                  </span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <div className={`mt-3 text-sm font-medium ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                        Currently:&nbsp;
                        <span className={isDarkMode ? 'text-slate-100' : 'text-slate-900'}>{toolDigest.currentLabel}</span>
                      </div>
                      {toolDigest.reassuranceNotes.length ? (
                        <div className={`mt-3 border-t pt-3 text-xs leading-relaxed ${
                          isDarkMode ? 'border-slate-700/70 text-sky-100' : 'border-slate-200 text-sky-950'
                        }`}>
                          <p className="text-xs font-medium">Notes</p>
                          <ul className="mt-2 list-inside list-disc space-y-1">
                            {toolDigest.reassuranceNotes.map((note) => (
                              <li key={note}>{note}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {toolDigest.errorCount ? (
                        <p className={`mt-3 text-xs font-semibold ${isDarkMode ? 'text-rose-300' : 'text-rose-700'}`}>
                          {`${toolDigest.errorCount} tool issue${toolDigest.errorCount === 1 ? '' : 's'} detected. Open the developer log below for troubleshooting.`}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowRawToolLog((prev) => !prev)}
                      className={toolButtonClassName}
                    >
                      {showRawToolLog ? 'Hide developer log' : 'Developer details (raw activity log)'}
                    </button>
                    {showRawToolLog ? (
                      <div className={toolExpandedClassName}>
                        <p className={`mb-2 text-xs font-medium ${
                          isDarkMode ? 'text-slate-500' : 'text-slate-500'
                        }`}>
                          Raw tool timeline
                        </p>
                        {toolEvents.map((event, index) => {
                          const isLast = index === toolEvents.length - 1;
                          const softNote = isBenignToolNoise(event);
                          const statusDot = event.status === 'completed'
                            ? 'bg-emerald-400'
                            : event.status === 'error'
                              ? 'bg-rose-500'
                              : 'bg-amber-300';
                          return (
                            <div key={event.id || `${event.name}-${index}`} className="flex min-w-0 gap-3 pb-3 last:pb-0">
                              <div className="flex flex-col items-center">
                                <span className={`h-2.5 w-2.5 rounded-full ${statusDot}`} />
                                {!isLast ? (
                                  <span className={`h-full w-px flex-1 ${
                                    isDarkMode ? 'bg-slate-700/80' : 'bg-slate-300'
                                  }`}
                                  />
                                ) : null}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className={`break-words font-mono text-[11px] font-semibold uppercase tracking-wide ${
                                  event.status === 'error' && !softNote
                                    ? isDarkMode ? 'text-rose-300' : 'text-rose-600'
                                    : softNote
                                      ? isDarkMode ? 'text-sky-300' : 'text-sky-700'
                                      : isDarkMode ? 'text-slate-400' : 'text-slate-500'
                                }`}>
                                  {event.name}
                                </p>
                                <p className={`whitespace-pre-wrap break-words text-sm ${
                                  event.status === 'error' && !softNote
                                    ? isDarkMode ? 'text-rose-200' : 'text-rose-700'
                                    : isDarkMode ? 'text-slate-200' : 'text-slate-700'
                                }`}>
                                  {event.summary
                                    || (event.status === 'completed'
                                      ? 'Completed'
                                      : event.status === 'error' ? 'Reported error' : 'In progress…')}
                                </p>
                                <p className={`mt-1 text-[11px] uppercase tracking-wide ${
                                  isDarkMode ? 'text-slate-500' : 'text-slate-400'
                                }`}
                                >
                                  {formatMessageTimestamp(event.startedAt)}
                                  {event.finishedAt ? ` • ${formatMessageTimestamp(event.finishedAt)}` : ''}
                                </p>
                                {event.outputFiles?.length ? (
                                  <div className="mt-2 min-w-0 space-y-3">
                                    {event.outputFiles.map((file) => (
                                      <div
                                        key={`${event.id}-${file.path}`}
                                        className={`min-w-0 max-w-full overflow-hidden rounded-xl border p-2 ${
                                          isDarkMode ? 'border-slate-700/70 bg-slate-950/80' : 'border-slate-200 bg-white'
                                        }`}
                                      >
                                        <div className="flex items-center justify-between gap-3">
                                          <p className={`break-all text-xs font-semibold ${
                                            isDarkMode ? 'text-slate-200' : 'text-slate-700'
                                          }`}
                                          >
                                            {file.path}
                                          </p>
                                          {file.mimeType ? (
                                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                              isDarkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'
                                            }`}
                                            >
                                              {file.mimeType}
                                            </span>
                                          ) : null}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                                {event.relatedFiles?.length && !event.outputFiles?.length ? (
                                  <div className={`mt-2 rounded-xl border px-2 py-1.5 text-xs ${
                                    isDarkMode ? 'border-slate-700/70 bg-slate-950/60 text-slate-300' : 'border-slate-200 bg-white text-slate-600'
                                  }`}>
                                    <span className="font-semibold">Related files: </span>
                                    {event.relatedFiles.map((file) => file.path).join(', ')}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className={userBubbleClassName}>
            {isEditing ? (
              <div className="space-y-2.5">
                <textarea
                  value={editValue}
                  onChange={(event) => setEditValue(event.target.value)}
                  onKeyDown={handleInlineEditKeyDown}
                  disabled={isStreaming}
                  autoFocus
                  className={inlineEditTextareaClassName}
                  aria-label="Edit message text"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={cancelInlineEdit}
                    className={`${inlineEditButtonBaseClassName} bg-white/10 text-white/80 hover:bg-white/15 hover:text-white`}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveInlineEdit}
                    disabled={isStreaming || !editValue.trim()}
                    className={`${inlineEditButtonBaseClassName} bg-white text-[#255489] shadow-sm hover:bg-white/90`}
                  >
                    Retry
                  </button>
                </div>
              </div>
            ) : userText ? (
              renderFormattedUserText(userText, userPathPillClassName)
            ) : null}
            {!isEditing && attachmentPreviews.length ? (
              <div className="mt-2.5 overflow-hidden rounded-lg border border-white/15 bg-black/10">
                {attachmentPreviews.map((attachment, index) => (
                  <div
                    key={`${attachment.name}-${index}`}
                    className={`flex min-w-0 items-center gap-2.5 px-2.5 py-2 ${
                      index > 0 ? 'border-t border-white/10' : ''
                    }`}
                  >
                      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white/12 text-white/90">
                        {attachment.previewUrl ? (
                          <>
                            <ImageIcon size={16} />
                            <img
                              src={attachment.previewUrl}
                              alt=""
                              className="absolute inset-0 h-full w-full object-cover"
                              loading="lazy"
                              onError={(event) => {
                                event.currentTarget.style.display = 'none';
                              }}
                            />
                          </>
                        ) : attachment.isImage ? (
                          <ImageIcon size={16} />
                        ) : (
                          (() => {
                            const AttachmentIcon = getAttachmentFileIcon(attachment.name, attachment.isImage);
                            return <AttachmentIcon size={16} />;
                          })()
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium leading-5 text-white">{attachment.name}</div>
                        <div className="text-[11px] text-white/65">
                          {getAttachmentTypeLabel(attachment.name, {
                            isDrive: attachment.isDrive,
                            isImage: attachment.isImage,
                          })}
                        </div>
                      </div>
                    </div>
                ))}
              </div>
            ) : null}
            {timestampLabel ? (
              <span className="mt-2 block text-[11px] font-medium uppercase tracking-wide text-white/85">{timestampLabel}</span>
            ) : null}
          </div>
        )}
        {!isEditing && (canCopyMessage || message.sender === 'user') ? (
          <div className={messageActionBarClassName}>
            {canCopyMessage ? (
              <button
                type="button"
                onClick={() => handleCopyMessageText(message)}
                title={copyTitle}
                aria-label={isCopiedMessage ? 'Copied to clipboard' : 'Copy message text'}
                className={messageActionButtonClassName}
              >
                {isCopiedMessage ? (
                  <Check size={14} className={isDarkMode ? 'text-emerald-400' : 'text-emerald-600'} />
                ) : (
                  <Copy size={14} />
                )}
              </button>
            ) : null}
            {message.sender === 'user' ? (
              <>
                <button
                  type="button"
                  onClick={startInlineEdit}
                  disabled={isStreaming}
                  title="Edit and retry"
                  aria-label="Edit message and retry"
                  className={messageActionButtonClassName}
                >
                  <FilePenLine size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => handleRerunMessage(message.id)}
                  disabled={isStreaming}
                  title="Retry this message"
                  aria-label="Retry this message"
                  className={messageActionButtonClassName}
                >
                  <RotateCcw size={14} />
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

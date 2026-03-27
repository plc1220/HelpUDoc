import { CheckCircle2, Copy, FilePenLine, Loader2, RotateCcw, ShieldCheck } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';

import type { ConversationMessage, ConversationMessageMetadata } from '../../types';
import ToolOutputFilePreview from './ToolOutputFilePreview';
import type { RenderableInterruptAction } from './interruptActions';
import { buildApprovalReview } from './approvalReview';

const THOUGHT_PREVIEW_LIMIT = 320;
const DEFAULT_THINKING_PLACEHOLDER = 'Working through your request based on the current workspace context.';
const FRONTEND_SLIDES_DISCOVERY_HEADERS = ['purpose', 'length', 'content', 'images', 'editing'] as const;

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

const FRONTEND_SLIDES_DISCOVERY_QUESTIONS: ClarificationQuestion[] = [
  {
    id: 'purpose',
    header: 'Purpose',
    question: 'What is this presentation for?',
    options: [
      {
        id: 'purpose-pitch',
        label: 'Pitch deck',
        value: 'Pitch deck',
        description: 'Selling an idea, product, or company to investors or clients.',
      },
      {
        id: 'purpose-teaching',
        label: 'Teaching / Tutorial',
        value: 'Teaching / Tutorial',
        description: 'Explaining concepts, how-to guides, or educational material.',
      },
      {
        id: 'purpose-conference',
        label: 'Conference talk',
        value: 'Conference talk',
        description: 'A keynote, event session, or tech talk.',
      },
      {
        id: 'purpose-internal',
        label: 'Internal presentation',
        value: 'Internal presentation',
        description: 'Team updates, strategy reviews, or company meetings.',
      },
    ],
  },
  {
    id: 'length',
    header: 'Length',
    question: 'Approximately how many slides should it have?',
    options: [
      {
        id: 'length-short',
        label: 'Short (5-10)',
        value: 'Short (5-10)',
        description: 'Quick pitch or lightning talk.',
      },
      {
        id: 'length-medium',
        label: 'Medium (10-20)',
        value: 'Medium (10-20)',
        description: 'Standard presentation length.',
      },
      {
        id: 'length-long',
        label: 'Long (20+)',
        value: 'Long (20+)',
        description: 'Deep dive or comprehensive talk.',
      },
    ],
  },
  {
    id: 'content',
    header: 'Content',
    question: 'How ready is the content?',
    options: [
      {
        id: 'content-ready',
        label: 'All content is ready',
        value: 'I have all content ready',
        description: 'Only the presentation design is needed.',
      },
      {
        id: 'content-notes',
        label: 'Rough notes',
        value: 'I have rough notes',
        description: 'Need help organizing the material into slides.',
      },
      {
        id: 'content-topic',
        label: 'Topic only',
        value: 'I have a topic only',
        description: 'Need help creating the full outline.',
      },
    ],
  },
  {
    id: 'images',
    header: 'Images',
    question: 'What should happen with images?',
    options: [
      {
        id: 'images-none',
        label: 'No images',
        value: 'No images',
        description: 'Use CSS-generated visuals instead.',
      },
      {
        id: 'images-assets',
        label: 'Use ./assets',
        value: './assets',
        description: 'Use the assets folder in the current project.',
      },
      {
        id: 'images-other',
        label: 'Other path',
        value: 'Custom image path',
        description: 'Type or paste another image folder path in the notes field.',
      },
    ],
  },
  {
    id: 'editing',
    header: 'Editing',
    question: 'Should the generated deck support inline browser editing?',
    options: [
      {
        id: 'editing-yes',
        label: 'Yes (Recommended)',
        value: 'Yes',
        description: 'Edit text in-browser, auto-save locally, and export later.',
      },
      {
        id: 'editing-no',
        label: 'No',
        value: 'No',
        description: 'Presentation only, with a smaller output file.',
      },
    ],
  },
];

const getInterruptSkill = (
  pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  activeSkill?: string,
): string | undefined => {
  const normalizedActiveSkill = activeSkill?.trim().toLowerCase();
  if (normalizedActiveSkill) {
    return normalizedActiveSkill;
  }
  const payloadSkill = pendingInterrupt?.displayPayload?.skill;
  return typeof payloadSkill === 'string' ? payloadSkill.trim().toLowerCase() : undefined;
};

const isFrontendSlidesDiscoveryInterrupt = (
  pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  activeSkill?: string,
): boolean => getInterruptSkill(pendingInterrupt, activeSkill) === 'frontend-slides';

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
  if (activeSkill === 'research' || toolNames.has('google_search') || toolNames.has('google_grounded_search')) {
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

const renderDisplayPayload = (
  payload?: Record<string, unknown>,
  heading = 'Details',
  tone: 'dark' | 'light' = 'dark',
) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).length) {
    return null;
  }
  const containerClass =
    tone === 'dark'
      ? 'rounded-2xl border border-white/10 bg-white/5 p-4 text-left'
      : 'rounded-2xl border border-slate-200/70 bg-white/65 p-4 text-left';
  const headingClass =
    tone === 'dark'
      ? 'text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55'
      : 'text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400';
  const keyClass =
    tone === 'dark'
      ? 'text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45'
      : 'text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500';
  const valueClass =
    tone === 'dark'
      ? 'mt-1 whitespace-pre-wrap text-sm leading-relaxed text-white/88'
      : 'mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-700';
  return (
    <div className={containerClass}>
      <p className={headingClass}>{heading}</p>
      <div className="mt-3 space-y-3">
        {Object.entries(payload).map(([key, value]) => (
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
  activeSkill?: string,
): ClarificationQuestion[] => {
  const responseQuestions = Array.isArray(pendingInterrupt?.responseSpec?.questions)
    ? pendingInterrupt.responseSpec.questions
    : [];
  if (responseQuestions.length) {
    return responseQuestions.reduce<ClarificationQuestion[]>((acc, question) => {
      if (!question || typeof question !== 'object' || !question.question) {
        return acc;
      }
      acc.push({
        id: question.id,
        header: question.header,
        question: question.question,
        options: Array.isArray(question.options)
          ? question.options.reduce<ClarificationQuestionOption[]>((optionAcc, option) => {
              if (!option?.label || !option?.value) {
                return optionAcc;
              }
              optionAcc.push({
                id: option.id,
                label: option.label,
                value: option.value,
                description: option.description,
              });
              return optionAcc;
            }, [])
          : [],
      });
      return acc;
    }, []);
  }

  const rawQuestions = pendingInterrupt?.displayPayload?.questions;
  if (Array.isArray(rawQuestions)) {
    const parsedQuestions = rawQuestions
      .map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return null;
        }
        const payload = item as Record<string, unknown>;
        const header = String(payload.header || payload.title || `Question ${index + 1}`).trim();
        const question = String(payload.question || payload.prompt || payload.description || '').trim();
        const rawOptions = Array.isArray(payload.options) ? payload.options : [];
        const options = rawOptions
          .map((option, optionIndex) => {
            if (typeof option === 'string' && option.trim()) {
              return {
                id: `${header.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${optionIndex + 1}`,
                label: option.trim(),
                value: option.trim(),
              } satisfies ClarificationQuestionOption;
            }
            if (!option || typeof option !== 'object' || Array.isArray(option)) {
              return null;
            }
            const optionPayload = option as Record<string, unknown>;
            const label = String(optionPayload.label || optionPayload.value || '').trim();
            const value = String(optionPayload.value || label).trim();
            if (!label || !value) {
              return null;
            }
            return {
              id: String(optionPayload.id || `${header.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${optionIndex + 1}`).trim(),
              label,
              value,
              description: String(optionPayload.description || '').trim() || undefined,
            } satisfies ClarificationQuestionOption;
          })
          .filter((option): option is ClarificationQuestionOption => Boolean(option));
        return {
          id: String(payload.id || header.toLowerCase().replace(/[^a-z0-9]+/g, '-')).trim(),
          header,
          question,
          options,
        } satisfies ClarificationQuestion;
      })
      .filter((question): question is ClarificationQuestion => question !== null && question.question.length > 0);
    if (parsedQuestions.length) {
      return parsedQuestions;
    }
  }

  const responseChoices = Array.isArray(pendingInterrupt?.responseSpec?.choices) ? pendingInterrupt?.responseSpec?.choices : [];
  const normalizedChoiceLabels = responseChoices.map((choice) => choice.label.trim().toLowerCase());
  const looksLikeFrontendSlidesDiscovery =
    isFrontendSlidesDiscoveryInterrupt(pendingInterrupt, activeSkill)
    && (
      normalizedChoiceLabels.length === 0
      || (
        normalizedChoiceLabels.length === FRONTEND_SLIDES_DISCOVERY_HEADERS.length &&
        normalizedChoiceLabels.every((label) => FRONTEND_SLIDES_DISCOVERY_HEADERS.includes(label as (typeof FRONTEND_SLIDES_DISCOVERY_HEADERS)[number]))
      )
    );

  return looksLikeFrontendSlidesDiscovery ? FRONTEND_SLIDES_DISCOVERY_QUESTIONS : [];
};

const buildClarificationTemplate = (questions: ClarificationQuestion[]): string =>
  questions
    .map((question) => `${question.header}:`)
    .join('\n');

const readStructuredAnswerMap = (
  value: string,
  questions: ClarificationQuestion[],
): Record<string, string> => {
  const answers: Record<string, string> = {};
  const lines = value.split('\n');
  questions.forEach((question) => {
    const prefix = `${question.header.toLowerCase()}:`;
    const matchingLine = lines.find((line) => line.trim().toLowerCase().startsWith(prefix));
    if (matchingLine) {
      answers[question.id] = matchingLine.slice(matchingLine.indexOf(':') + 1).trim();
    }
  });
  return answers;
};

const upsertStructuredAnswer = (
  value: string,
  question: ClarificationQuestion,
  answer: string,
  questions: ClarificationQuestion[],
): string => {
  const existingLines = value
    ? value.split('\n')
    : buildClarificationTemplate(questions).split('\n');
  const prefix = `${question.header}:`;
  const nextLines = [...existingLines];
  const lineIndex = nextLines.findIndex((line) => line.trim().toLowerCase().startsWith(prefix.toLowerCase()));
  const nextLine = `${prefix} ${answer}`.trimEnd();
  if (lineIndex >= 0) {
    nextLines[lineIndex] = nextLine;
  } else {
    nextLines.push(nextLine);
  }
  return nextLines.join('\n').trim();
};

export default function ChatMessageBubble({
  message,
  personaDisplayName,
  messageBubbleMaxWidth,
  markdownComponents,
  expandedToolMessages,
  expandedThinkingMessages,
  copiedMessageId,
  interruptInputByMessageId,
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
  toggleInterruptSelectedChoice,
  workspaceSkipPlanApprovals,
  workspaceSettingsBusy,
  toggleThinkingVisibility,
  toggleToolActivityVisibility,
  handleCopyMessageText,
  handleRerunMessage,
  handlePrepareInterruptAction,
  handleInterruptAction,
  enableTrustedPlanMode,
  isStreaming,
  workspaceId,
}: {
  message: ConversationMessage;
  personaDisplayName: string;
  messageBubbleMaxWidth: string;
  markdownComponents: Components;
  expandedToolMessages: Set<ConversationMessage['id']>;
  expandedThinkingMessages: Set<ConversationMessage['id']>;
  copiedMessageId: ConversationMessage['id'] | null;
  interruptInputByMessageId: Record<string, string>;
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
  toggleInterruptSelectedChoice: (messageKey: string, choiceId: string, multiple: boolean) => void;
  workspaceSkipPlanApprovals: boolean;
  workspaceSettingsBusy: boolean;
  toggleThinkingVisibility: (messageId: ConversationMessage['id']) => void;
  toggleToolActivityVisibility: (messageId: ConversationMessage['id']) => void;
  handleCopyMessageText: (message: ConversationMessage) => void;
  handleRerunMessage: (messageId: ConversationMessage['id']) => void;
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
  enableTrustedPlanMode: () => Promise<boolean> | boolean;
  isStreaming: boolean;
  workspaceId?: string;
}) {
  const isAgentMessage = message.sender === 'agent';
  const messageMetadata = (message.metadata as ConversationMessageMetadata | null | undefined) || undefined;
  const timestampLabel = formatMessageTimestamp(message.updatedAt || message.createdAt);
  const toolEvents = message.toolEvents || [];
  const hasToolEvents = toolEvents.length > 0;
  const pendingInterrupt = messageMetadata?.pendingInterrupt;
  const interruptKind = getInterruptKind(pendingInterrupt);
  const isClarificationInterrupt = Boolean(pendingInterrupt && interruptKind === 'clarification');
  const interruptActions = getInterruptActions(pendingInterrupt);
  const primaryInterruptAction = getPrimaryInterruptAction(pendingInterrupt);
  const isPlanApprovalRequest = isPlanApprovalInterrupt(pendingInterrupt);
  const messageKey = String(message.id);
  const interruptBusy = Boolean(interruptSubmittingByMessageId[messageKey]);
  const interruptControlsDisabled = interruptBusy || (Boolean(pendingInterrupt) && isStreaming);
  const [activeTextActionId, setActiveTextActionId] = useState<string | null>(null);
  const [confirmActionId, setConfirmActionId] = useState<string | null>(null);
  const [clarificationDismissed, setClarificationDismissed] = useState(false);
  const isToolActivityExpanded = expandedToolMessages.has(message.id);
  const isThinkingExpanded = expandedThinkingMessages.has(message.id);
  const rawThinkingText = message.thinkingText?.trim() || '';
  const activeSkill = messageMetadata?.runPolicy?.skill?.trim().toLowerCase();
  const isSystemThinking = /available skills/i.test(rawThinkingText);
  const displayThinkingText = isSystemThinking
    ? getThinkingPlaceholder(messageMetadata, toolEvents)
    : rawThinkingText;
  const showThinkingToggle = !isSystemThinking && displayThinkingText.length > THOUGHT_PREVIEW_LIMIT;
  const isThinkingCollapsed = showThinkingToggle && !isThinkingExpanded;
  const sanitizedAgentText = (() => {
    const raw = message.text || '';
    if (!pendingInterrupt || !raw || interruptKind !== 'approval') {
      return raw;
    }
    return raw
      .split('\n')
      .filter((line) => {
        const value = line.trim();
        if (!value) return false;
        if (/^\[human approval required\]$/i.test(value)) return false;
        if (/request_plan_approval\s*\(allowed:/i.test(value)) return false;
        if (/\(allowed:\s*approve,\s*edit,\s*reject\)/i.test(value)) return false;
        if (/use the approval controls to approve, edit, or reject before execution continues\.?/i.test(value)) return false;
        return true;
      })
      .join('\n')
      .trim();
  })();
  const canCopyMessage =
    Boolean((message.text && message.text.trim()) || (message.thinkingText && message.thinkingText.trim()));
  const shouldShowFallbackStatus = !sanitizedAgentText && !displayThinkingText && !hasToolEvents;
  const copyTitle = copiedMessageId === message.id ? 'Copied!' : 'Copy message';
  const copyButtonPositionClass = message.sender === 'user' ? 'right-10' : 'right-2';
  const planFeedbackKey = interruptFieldKey(messageKey, 'feedback');
  const genericEditKey = interruptFieldKey(messageKey, 'edit-json');
  const rejectNoteKey = interruptFieldKey(messageKey, 'reject-note');
  const clarificationTextKey = interruptFieldKey(messageKey, 'clarification-text');
  const interruptError = interruptErrorByMessageId[messageKey] || '';
  const allowDismiss = Boolean(pendingInterrupt?.responseSpec?.allowDismiss);
  const clarificationAllowsMultiple = Boolean(pendingInterrupt?.responseSpec?.multiple);
  const selectedChoiceIds = interruptSelectedChoicesByMessageId[messageKey] || [];
  const structuredClarificationQuestions = useMemo(
    () => parseClarificationQuestions(pendingInterrupt, activeSkill),
    [activeSkill, pendingInterrupt],
  );
  const hasStructuredClarificationForm = isClarificationInterrupt && structuredClarificationQuestions.length > 0;
  const clarificationDraftValue = interruptInputByMessageId[clarificationTextKey] || '';
  const structuredClarificationSubmitActions = interruptActions.filter((action) => action.inputMode === 'text');
  const structuredAnswerMap = useMemo(
    () => readStructuredAnswerMap(clarificationDraftValue, structuredClarificationQuestions),
    [clarificationDraftValue, structuredClarificationQuestions],
  );

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

  useEffect(() => {
    if (!pendingInterrupt) {
      setActiveTextActionId(null);
      setConfirmActionId(null);
      setClarificationDismissed(false);
      return;
    }
    setActiveTextActionId(null);
    setConfirmActionId(null);
    setClarificationDismissed(false);
  }, [pendingInterrupt, messageKey]);

  const setInterruptValue = (fieldKey: string, value: string) => {
    setInterruptInputByMessageId((prev) => ({
      ...prev,
      [fieldKey]: value,
    }));
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
        return 'rounded-[1.2rem] border border-[#94c5f8]/70 bg-[#94c5f8] px-4 py-3 text-sm font-semibold text-slate-900 transition-all duration-200 hover:bg-[#a8d2fb] disabled:cursor-not-allowed disabled:opacity-40';
      }
      if (isDanger) {
        return 'rounded-[1.2rem] border border-rose-400/35 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-100 transition-all duration-200 hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-40';
      }
      return 'rounded-[1.2rem] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-semibold text-white/92 transition-all duration-200 hover:border-white/25 hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-40';
    }
    if (isPrimary) {
      return 'rounded-xl border border-emerald-300/80 bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60';
    }
    if (isDanger) {
      return 'rounded-xl border border-rose-200/90 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 transition-all duration-200 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60';
    }
    return 'rounded-xl border border-blue-200/90 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 transition-all duration-200 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60';
  };

  const renderInterruptActions = (tone: 'light' | 'dark') => {
    if (!interruptActions.length) {
      return null;
    }

    return (
      <div className={tone === 'dark' ? 'mt-5 space-y-3' : 'mt-3 space-y-2'}>
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
            <div key={action.id} className={tone === 'dark' ? 'space-y-3' : 'space-y-2'}>
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

  const handleEnableTrustedMode = async () => {
    if (workspaceSkipPlanApprovals || workspaceSettingsBusy) {
      return;
    }
    await Promise.resolve(enableTrustedPlanMode());
  };

  return (
    <div className={`group flex items-start gap-3 motion-safe:animate-[chat-pane-message-in_220ms_ease-out] ${isAgentMessage ? '' : 'justify-end'}`}>
      <div style={{ width: '100%', maxWidth: messageBubbleMaxWidth }} className="relative flex-1 md:flex-initial">
        {isAgentMessage ? (
          <div className="w-full rounded-2xl border border-slate-200 bg-gradient-to-br from-white via-slate-50 to-blue-50/40 px-4 py-4 text-slate-800 shadow-[0_22px_40px_-28px_rgba(15,23,42,0.8)] ring-1 ring-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <span className="text-slate-600">{personaDisplayName}</span>
              {timestampLabel ? <span>{timestampLabel}</span> : null}
            </div>
            {displayThinkingText ? (
              <div className="relative mt-3 pl-4 before:absolute before:bottom-2 before:left-1 before:top-2 before:w-px before:bg-sky-200">
                <span className="absolute left-0 top-3 h-2.5 w-2.5 rounded-full border border-sky-300 bg-sky-100" />
                <div className="rounded-2xl border border-sky-100 bg-sky-50/60 px-3 py-3 text-[13px] text-slate-600 shadow-inner transition-all duration-200 ease-in-out">
                  <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-sky-700">
                    <span>Thinking</span>
                    {showThinkingToggle ? (
                      <button
                        type="button"
                        onClick={() => toggleThinkingVisibility(message.id)}
                        className="text-sky-700 transition-all duration-200 hover:text-sky-600"
                      >
                        {isThinkingExpanded ? 'Show less' : 'Expand'}
                      </button>
                    ) : null}
                  </div>
                  <div
                    className="relative mt-2 overflow-hidden whitespace-pre-line leading-relaxed transition-[max-height] duration-300 ease-in-out"
                    style={{ maxHeight: isThinkingCollapsed ? '7.5rem' : '28rem' }}
                  >
                    {displayThinkingText}
                    {isThinkingCollapsed ? (
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-sky-50/95 to-transparent" />
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
            {sanitizedAgentText ? (
              <div className="agent-markdown mt-3 text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {sanitizedAgentText}
                </ReactMarkdown>
              </div>
            ) : shouldShowFallbackStatus ? (
              <span className="mt-3 block text-sm text-slate-500">
                {displayThinkingText ? 'Finalizing response...' : 'Thinking...'}
              </span>
            ) : null}
            {pendingInterrupt && !isClarificationInterrupt ? (
              <div className="relative mt-4 pl-4 before:absolute before:-bottom-2 before:left-1 before:top-2 before:w-px before:bg-slate-200">
                <span className="absolute left-0 top-3 h-2.5 w-2.5 rounded-full border border-indigo-300 bg-indigo-100" />
                <div className="rounded-[1.9rem] border border-amber-200/75 bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.12),_transparent_38%),linear-gradient(160deg,rgba(255,255,255,0.98),rgba(248,250,252,0.95))] p-5 shadow-[0_24px_60px_-34px_rgba(120,53,15,0.45)] backdrop-blur-md">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                          {approvalReview?.cardTitle || pendingInterrupt.title || 'Review Research Strategy'}
                        </p>
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700">
                          <CheckCircle2 size={12} />
                          {approvalReview?.badgeLabel || 'Pending Approval'}
                        </span>
                      </div>
                      <p className="mt-3 text-xl font-semibold tracking-tight text-slate-900">
                        {approvalReview?.planTitle || 'Proposed plan'}
                      </p>
                      <p className="mt-1 text-sm leading-relaxed text-slate-600">
                        {approvalReview?.description || pendingInterrupt.description || 'Review the proposed research strategy before execution continues.'}
                      </p>
                    </div>
                    {approvalReview?.stepCount && approvalReview.stepCount > 1 ? (
                      <div className="rounded-full border border-slate-200 bg-white/80 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        Step {typeof approvalReview.stepIndex === 'number' ? approvalReview.stepIndex + 1 : 1} of {approvalReview.stepCount}
                      </div>
                    ) : null}
                  </div>

                  {approvalReview ? (
                    <div className="mt-4 space-y-4">
                      <div className="rounded-[1.4rem] border border-slate-200/80 bg-white/80 p-4 shadow-sm">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          <span>Plan File</span>
                          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-[10px] normal-case tracking-normal text-slate-700">
                            {approvalReview.planFilePath}
                          </span>
                        </div>
                        {approvalReview.summaryMarkdown ? (
                          <div className="agent-markdown mt-3 text-sm text-slate-700">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                              {approvalReview.summaryMarkdown}
                            </ReactMarkdown>
                          </div>
                        ) : null}
                      </div>

                      {approvalReview.steps.length ? (
                        <div className="rounded-[1.4rem] border border-slate-200/80 bg-white/72 p-4 shadow-sm">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Execution Map
                          </p>
                          <div className="mt-3 space-y-3">
                            {approvalReview.steps.map((step, index) => (
                              <div key={`${step.title}-${index}`} className="rounded-[1.2rem] border border-slate-200/80 bg-slate-50/80 p-3">
                                <div className="flex items-start gap-3">
                                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white">
                                    {index + 1}
                                  </span>
                                  <div className="min-w-0">
                                    <p className="text-sm font-semibold text-slate-900">{step.title}</p>
                                    {step.detail ? (
                                      <p className="mt-1 text-sm leading-relaxed text-slate-600">{step.detail}</p>
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
                          <div className="rounded-[1.3rem] border border-emerald-200/80 bg-emerald-50/70 p-4">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Create</p>
                            <div className="mt-2 space-y-1.5 text-sm text-emerald-900">
                              {approvalCreateImpacts.length ? approvalCreateImpacts.map((impact, index) => (
                                <p key={`${impact.path}-${index}`}>{impact.path}</p>
                              )) : <p className="text-emerald-800/70">No new files.</p>}
                            </div>
                          </div>
                          <div className="rounded-[1.3rem] border border-blue-200/80 bg-blue-50/75 p-4">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-700">Update</p>
                            <div className="mt-2 space-y-1.5 text-sm text-blue-900">
                              {approvalUpdateImpacts.length ? approvalUpdateImpacts.map((impact, index) => (
                                <p key={`${impact.path}-${index}`}>{impact.path}</p>
                              )) : <p className="text-blue-800/70">No existing files updated.</p>}
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {approvalReview.riskyActions ? (
                        <div className="rounded-[1.3rem] border border-rose-200/80 bg-rose-50/70 p-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-700">Risk Notes</p>
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

                  {isPlanApprovalRequest ? (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[1.2rem] border border-slate-200/80 bg-white/75 px-4 py-3">
                      <label className="flex min-w-0 items-center gap-3 text-sm text-slate-600">
                        <input
                          type="checkbox"
                          checked={workspaceSkipPlanApprovals}
                          disabled={workspaceSkipPlanApprovals || workspaceSettingsBusy}
                          onChange={() => { void handleEnableTrustedMode(); }}
                          className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                        />
                        <span className="min-w-0">
                          <span className="font-medium text-slate-700">Don’t ask me again for this workspace</span>
                          <span className="block text-xs text-slate-500">
                            Future plan reviews will auto-approve until you switch approvals back on in the sidebar.
                          </span>
                        </span>
                      </label>
                      {workspaceSkipPlanApprovals ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                          <ShieldCheck size={12} />
                          Trusted mode enabled
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {interruptError ? (
                    <div className="mt-4 rounded-xl border border-rose-200/90 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                      {interruptError}
                    </div>
                  ) : null}

                  {isPlanApprovalRequest ? (
                    <div className="mt-3 rounded-[1.2rem] border border-slate-200/80 bg-white/70 px-4 py-3 text-xs text-slate-500">
                      <div className="flex items-center gap-2 font-semibold uppercase tracking-[0.16em] text-slate-500">
                        <FilePenLine size={13} />
                        Edit Behavior
                      </div>
                      <p className="mt-2 leading-relaxed text-slate-600">
                        Selecting <span className="font-semibold text-slate-700">Edit</span> opens the plan file in the editor so you can revise the draft before resubmitting feedback.
                      </p>
                    </div>
                  ) : null}

                  <div className="mt-3">{renderInterruptActions('light')}</div>
                </div>
              </div>
            ) : null}
            {pendingInterrupt && isClarificationInterrupt && !clarificationDismissed ? (
              <div className="mt-5 rounded-[2rem] border border-slate-200/80 bg-gradient-to-br from-white via-slate-50 to-sky-50/55 p-5 text-slate-900 shadow-[0_26px_80px_-34px_rgba(15,23,42,0.32)] ring-1 ring-white/70">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[30px] font-semibold leading-tight tracking-tight text-slate-900">
                      {pendingInterrupt.title || (isDynamicActionInterrupt ? 'Select the next step' : 'The agent needs clarification')}
                    </p>
                    {pendingInterrupt.description ? (
                      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">
                        {pendingInterrupt.description}
                      </p>
                    ) : null}
                  </div>
                  {pendingInterrupt.stepCount && pendingInterrupt.stepCount > 1 ? (
                    <div className="shrink-0 rounded-full border border-slate-200 bg-white/80 px-4 py-2 text-sm font-medium text-slate-600">
                      {typeof pendingInterrupt.stepIndex === 'number' ? pendingInterrupt.stepIndex + 1 : 1} of {pendingInterrupt.stepCount}
                    </div>
                  ) : null}
                </div>
                {clarificationDisplayPayload ? <div className="mt-5">{clarificationDisplayPayload}</div> : null}
                {interruptError ? (
                  <div className="mt-4 rounded-[1.25rem] border border-rose-200/90 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    {interruptError}
                  </div>
                ) : null}
                {hasStructuredClarificationForm ? (
                  <div className="mt-5 space-y-5">
                    <div className="grid gap-4 md:grid-cols-2">
                      {structuredClarificationQuestions.map((question) => (
                        <div key={question.id} className="rounded-[1.5rem] border border-slate-200/80 bg-white/85 p-4 shadow-sm">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                            {question.header}
                          </p>
                          <p className="mt-2 text-sm font-medium leading-relaxed text-slate-700">
                            {question.question}
                          </p>
                          {question.options.length ? (
                            <div className="mt-3 space-y-2">
                              {question.options.map((option) => {
                                const currentAnswer = (structuredAnswerMap[question.id] || '').trim().toLowerCase();
                                const isSelected = currentAnswer === option.value.trim().toLowerCase();
                                return (
                                  <button
                                    key={option.id}
                                    type="button"
                                    disabled={interruptControlsDisabled}
                                    onClick={() => {
                                      const nextValue = upsertStructuredAnswer(
                                        clarificationDraftValue,
                                        question,
                                        option.value,
                                        structuredClarificationQuestions,
                                      );
                                      setInterruptValue(clarificationTextKey, nextValue);
                                    }}
                                    className={`w-full rounded-[1.15rem] border px-3 py-3 text-left transition-all duration-200 ${
                                      isSelected
                                        ? 'border-sky-300 bg-sky-50 text-sky-900 shadow-[0_0_0_1px_rgba(14,165,233,0.12)]'
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
                        </div>
                      ))}
                    </div>
                    <div className="rounded-[1.5rem] border border-slate-200/80 bg-white/90 p-4 shadow-sm">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-slate-800">Notes for the agent</p>
                          <p className="mt-1 text-xs text-slate-500">Adjust any suggestion or add your own details, then continue.</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {structuredClarificationSubmitActions.map((action) => (
                            <button
                              key={action.id}
                              type="button"
                              disabled={interruptControlsDisabled || !clarificationDraftValue.trim()}
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
                      <textarea
                        value={clarificationDraftValue}
                        onChange={(event) => setInterruptValue(clarificationTextKey, event.target.value)}
                        rows={Math.max(6, structuredClarificationQuestions.length + 1)}
                        disabled={interruptControlsDisabled}
                        placeholder={buildClarificationTemplate(structuredClarificationQuestions)}
                        className="mt-3 w-full rounded-[1.35rem] border border-slate-200 bg-white px-4 py-3 text-sm leading-relaxed text-slate-700 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                      />
                    </div>
                  </div>
                ) : (
                  renderInterruptActions('light')
                )}
                <div className="mt-6 flex items-center justify-between gap-4">
                  <button
                    type="button"
                    disabled={!allowDismiss || interruptBusy}
                    onClick={() => setClarificationDismissed(true)}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition-all duration-200 ${
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
            {hasToolEvents ? (
              <div className="relative mt-3 pl-4">
                <span className="absolute left-0 top-2 h-2.5 w-2.5 rounded-full border border-slate-300 bg-slate-100" />
                <button
                  type="button"
                  onClick={() => toggleToolActivityVisibility(message.id)}
                  className="text-xs font-semibold uppercase tracking-wide text-slate-500 transition-all duration-200 hover:text-slate-700"
                >
                  {isToolActivityExpanded ? 'Hide tool activity' : `Show tool activity (${toolEvents.length})`}
                </button>
                {isToolActivityExpanded ? (
                  <div className="mt-2 rounded-2xl border border-slate-200 bg-white/80 px-3 py-3 text-xs text-slate-600 shadow-inner">
                    {toolEvents.map((event, index) => {
                      const isLast = index === toolEvents.length - 1;
                      return (
                        <div key={event.id || `${event.name}-${index}`} className="flex min-w-0 gap-3 pb-3 last:pb-0">
                          <div className="flex flex-col items-center">
                            <span className={`h-2.5 w-2.5 rounded-full ${event.status === 'completed' ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                            {!isLast ? <span className="h-full w-px flex-1 bg-slate-200" /> : null}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className={`break-words text-[11px] font-semibold uppercase tracking-wide ${event.status === 'error' ? 'text-red-500' : 'text-slate-500'}`}>
                              {event.name}
                            </p>
                            <p className={`whitespace-pre-wrap break-words text-sm ${event.status === 'error' ? 'text-red-600' : 'text-slate-700'}`}>
                              {event.summary || (event.status === 'completed' ? 'Completed' : event.status === 'error' ? 'Failed' : 'In progress...')}
                            </p>
                            <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-400">
                              {formatMessageTimestamp(event.startedAt)}
                              {event.finishedAt ? ` • ${formatMessageTimestamp(event.finishedAt)}` : ''}
                            </p>
                            {event.outputFiles?.length ? (
                              <div className="mt-2 min-w-0 space-y-3">
                                {event.outputFiles.map((file) => (
                                  <div
                                    key={`${event.id}-${file.path}`}
                                    className="min-w-0 max-w-full overflow-hidden rounded-lg border border-slate-200 bg-white p-2"
                                  >
                                    <p className="break-all text-xs font-semibold text-slate-700">{file.path}</p>
                                    <ToolOutputFilePreview workspaceId={workspaceId} file={file} markdownComponents={markdownComponents} />
                                  </div>
                                ))}
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
        ) : (
          <div className="rounded-2xl bg-gradient-to-br from-blue-600 to-blue-500 px-4 py-3 text-sm text-white shadow-lg [text-shadow:0_1px_1px_rgba(15,23,42,0.35)]">
            <p className="whitespace-pre-line leading-relaxed">{message.text}</p>
            {timestampLabel ? (
              <span className="mt-2 block text-[11px] uppercase tracking-wide text-white/70">{timestampLabel}</span>
            ) : null}
          </div>
        )}
        {canCopyMessage ? (
          <button
            type="button"
            onClick={() => handleCopyMessageText(message)}
            title={copyTitle}
            aria-label="Copy message text"
            className={`absolute -top-2 ${copyButtonPositionClass} rounded-full bg-white p-1.5 text-slate-600 shadow ring-1 ring-slate-200 transition-all duration-200 opacity-0 hover:bg-slate-50 group-hover:opacity-100 focus-visible:opacity-100`}
          >
            <Copy size={14} />
          </button>
        ) : null}
        {message.sender === 'user' ? (
          <button
            type="button"
            onClick={() => handleRerunMessage(message.id)}
            disabled={isStreaming}
            title="Rerun this message"
            className={`absolute -right-2 -top-2 rounded-full bg-blue-500 p-1.5 text-white shadow transition-all duration-200 opacity-0 ${
              isStreaming
                ? 'cursor-not-allowed group-hover:opacity-60 hover:opacity-60'
                : 'group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100'
            }`}
          >
            <RotateCcw size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

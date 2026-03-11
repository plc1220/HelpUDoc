import { Copy, Loader2, RotateCcw } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useMemo, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react';

import type { ConversationMessage, ConversationMessageMetadata, PendingInterrupt } from '../../types';
import ToolOutputFilePreview from './ToolOutputFilePreview';

const THOUGHT_PREVIEW_LIMIT = 320;
const THINKING_PLACEHOLDER = 'Formulating a research plan based on your prompt and available context.';

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

const getClarificationInputMode = (pendingInterrupt?: PendingInterrupt): 'none' | 'text' | 'choice' | 'text_or_choice' =>
  pendingInterrupt?.responseSpec?.inputMode || 'text';

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
  interruptFieldKey,
  formatMessageTimestamp,
  getInterruptKind,
  getAllowedDecisions,
  getPrimaryInterruptAction,
  isPlanApprovalInterrupt,
  setInterruptInputByMessageId,
  setInterruptSelectedChoicesByMessageId,
  toggleThinkingVisibility,
  toggleToolActivityVisibility,
  handleCopyMessageText,
  handleRerunMessage,
  handleInterruptDecision,
  handleClarificationResponse,
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
  interruptFieldKey: (
    messageKey: string,
    field: 'feedback' | 'edit-json' | 'reject-note' | 'clarification-text',
  ) => string;
  formatMessageTimestamp: (value?: string) => string;
  getInterruptKind: (
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => 'approval' | 'clarification';
  getAllowedDecisions: (
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => Array<'approve' | 'edit' | 'reject'>;
  getPrimaryInterruptAction: (
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => { name?: string; args?: Record<string, unknown> } | undefined;
  isPlanApprovalInterrupt: (pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt']) => boolean;
  setInterruptInputByMessageId: Dispatch<SetStateAction<Record<string, string>>>;
  setInterruptSelectedChoicesByMessageId: Dispatch<SetStateAction<Record<string, string[]>>>;
  toggleThinkingVisibility: (messageId: ConversationMessage['id']) => void;
  toggleToolActivityVisibility: (messageId: ConversationMessage['id']) => void;
  handleCopyMessageText: (message: ConversationMessage) => void;
  handleRerunMessage: (messageId: ConversationMessage['id']) => void;
  handleInterruptDecision: (
    message: ConversationMessage,
    decision: 'approve' | 'edit' | 'reject',
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => void;
  handleClarificationResponse: (
    message: ConversationMessage,
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => void;
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
  const allowedInterruptDecisions = getAllowedDecisions(pendingInterrupt);
  const primaryInterruptAction = getPrimaryInterruptAction(pendingInterrupt);
  const isPlanApprovalRequest = isPlanApprovalInterrupt(pendingInterrupt);
  const messageKey = String(message.id);
  const interruptBusy = Boolean(interruptSubmittingByMessageId[messageKey]);
  const [interruptMode, setInterruptMode] = useState<'review' | 'editing' | 'rejecting'>('review');
  const [clarificationDismissed, setClarificationDismissed] = useState(false);
  const isToolActivityExpanded = expandedToolMessages.has(message.id);
  const isThinkingExpanded = expandedThinkingMessages.has(message.id);
  const rawThinkingText = message.thinkingText?.trim() || '';
  const isSystemThinking = /available skills/i.test(rawThinkingText);
  const displayThinkingText = isSystemThinking ? THINKING_PLACEHOLDER : rawThinkingText;
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
  const clarificationInputMode = getClarificationInputMode(pendingInterrupt);
  const clarificationAllowsChoices = clarificationInputMode === 'choice' || clarificationInputMode === 'text_or_choice';
  const clarificationAllowsText = clarificationInputMode === 'text' || clarificationInputMode === 'text_or_choice';
  const clarificationChoices = pendingInterrupt?.responseSpec?.choices || [];
  const selectedChoiceIds = interruptSelectedChoicesByMessageId[messageKey] || [];
  const clarificationValue = interruptInputByMessageId[clarificationTextKey] || '';
  const allowDismiss = Boolean(pendingInterrupt?.responseSpec?.allowDismiss);

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

  useEffect(() => {
    if (!pendingInterrupt) {
      setInterruptMode('review');
      setClarificationDismissed(false);
      return;
    }
    setClarificationDismissed(false);
  }, [pendingInterrupt, messageKey]);

  const setInterruptValue = (fieldKey: string, value: string) => {
    setInterruptInputByMessageId((prev) => ({
      ...prev,
      [fieldKey]: value,
    }));
  };

  const setSelectedChoices = (nextChoices: string[]) => {
    setInterruptSelectedChoicesByMessageId((prev) => ({
      ...prev,
      [messageKey]: nextChoices,
    }));
  };

  const handleClarificationChoiceToggle = (choiceId: string, choiceValue: string) => {
    const isMultiple = Boolean(pendingInterrupt?.responseSpec?.multiple);
    const nextChoices = isMultiple
      ? selectedChoiceIds.includes(choiceId)
        ? selectedChoiceIds.filter((value) => value !== choiceId)
        : [...selectedChoiceIds, choiceId]
      : [choiceId];
    setSelectedChoices(nextChoices);
    if (clarificationInputMode === 'text_or_choice') {
      setInterruptValue(clarificationTextKey, choiceValue);
    }
  };

  const handleClarificationKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!pendingInterrupt || clarificationDismissed) {
      return;
    }
    const target = event.target as HTMLElement | null;
    const isTextEntryTarget = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT';
    if (clarificationAllowsChoices && clarificationChoices.length) {
      if (isTextEntryTarget) {
        return;
      }
      const currentIndex = selectedChoiceIds.length
        ? clarificationChoices.findIndex((choice) => choice.id === selectedChoiceIds[0])
        : -1;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % clarificationChoices.length;
        const nextChoice = clarificationChoices[nextIndex];
        handleClarificationChoiceToggle(nextChoice.id, nextChoice.value);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        const nextIndex = currentIndex <= 0 ? clarificationChoices.length - 1 : currentIndex - 1;
        const nextChoice = clarificationChoices[nextIndex];
        handleClarificationChoiceToggle(nextChoice.id, nextChoice.value);
        return;
      }
    }
    const hasValidResponse =
      clarificationValue.trim().length > 0 ||
      selectedChoiceIds.length > 0 ||
      clarificationInputMode === 'none';
    if (event.key === 'Enter' && !event.shiftKey && hasValidResponse && !interruptBusy) {
      event.preventDefault();
      handleClarificationResponse(message, pendingInterrupt);
    }
  };

  const clarificationDisplayPayload = renderDisplayPayload(pendingInterrupt?.displayPayload, 'Context', 'dark');
  const approvalDisplayPayload = renderDisplayPayload(pendingInterrupt?.displayPayload, 'Plan details', 'light');

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
                <div className="rounded-2xl border border-sky-200/70 bg-gradient-to-br from-white/75 via-sky-50/70 to-indigo-100/60 p-4 shadow-[0_18px_40px_-28px_rgba(30,64,175,0.75)] backdrop-blur-md">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
                    {pendingInterrupt.title || 'Approval Required'}
                  </p>
                  <p className="mt-1 text-sm text-slate-700">
                    {pendingInterrupt.description || 'Please review the proposed plan below before continuing.'}
                  </p>
                  {isPlanApprovalRequest ? (
                    <div className="mt-3 grid gap-2">
                      {approvalDisplayPayload}
                      {interruptMode === 'editing' ? (
                        <textarea
                          value={interruptInputByMessageId[planFeedbackKey] || ''}
                          onChange={(event) => setInterruptValue(planFeedbackKey, event.target.value)}
                          className="w-full rounded-xl border border-slate-200/80 bg-white/85 p-3 text-sm text-slate-700 backdrop-blur-sm focus:border-sky-400 focus:outline-none"
                          rows={6}
                          placeholder="Edit this plan before saving changes"
                        />
                      ) : (
                        <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-200/70 bg-white/60 p-3 text-sm text-slate-700 whitespace-pre-wrap">
                          {planText || 'No plan details were provided.'}
                        </div>
                      )}
                      {interruptMode === 'rejecting' ? (
                        <input
                          value={interruptInputByMessageId[rejectNoteKey] || ''}
                          onChange={(event) => setInterruptValue(rejectNoteKey, event.target.value)}
                          className="w-full rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm text-slate-700 backdrop-blur-sm focus:border-sky-400 focus:outline-none"
                          placeholder="Reason for rejection (optional)"
                        />
                      ) : null}
                      <div className="mt-1 flex flex-wrap gap-2">
                        {interruptMode === 'editing' ? (
                          <>
                            <button
                              type="button"
                              disabled={interruptBusy}
                              onClick={() => handleInterruptDecision(message, 'edit', pendingInterrupt)}
                              className="rounded-xl border border-blue-300/80 bg-blue-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Save Changes
                            </button>
                            <button
                              type="button"
                              disabled={interruptBusy}
                              onClick={() => setInterruptMode('review')}
                              className="rounded-xl border border-slate-300/80 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-all duration-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Cancel
                            </button>
                          </>
                        ) : interruptMode === 'rejecting' ? (
                          <>
                            <button
                              type="button"
                              disabled={interruptBusy}
                              onClick={() => handleInterruptDecision(message, 'reject', pendingInterrupt)}
                              className="rounded-xl border border-rose-300/80 bg-rose-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Confirm Rejection
                            </button>
                            <button
                              type="button"
                              disabled={interruptBusy}
                              onClick={() => setInterruptMode('review')}
                              className="rounded-xl border border-slate-300/80 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-all duration-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            {allowedInterruptDecisions.includes('approve') ? (
                              <button
                                type="button"
                                disabled={interruptBusy}
                                onClick={() => handleInterruptDecision(message, 'approve', pendingInterrupt)}
                                className="rounded-xl border border-emerald-300/80 bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Approve
                              </button>
                            ) : null}
                            {allowedInterruptDecisions.includes('edit') ? (
                              <button
                                type="button"
                                disabled={interruptBusy}
                                onClick={() => {
                                  if (!(interruptInputByMessageId[planFeedbackKey] || '').trim()) {
                                    setInterruptValue(planFeedbackKey, planText);
                                  }
                                  setInterruptMode('editing');
                                }}
                                className="rounded-xl border border-blue-200/90 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 transition-all duration-200 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Edit
                              </button>
                            ) : null}
                            {allowedInterruptDecisions.includes('reject') ? (
                              <button
                                type="button"
                                disabled={interruptBusy}
                                onClick={() => setInterruptMode('rejecting')}
                                className="rounded-xl border border-rose-200/90 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 transition-all duration-200 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Reject
                              </button>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 grid gap-2">
                      {approvalDisplayPayload}
                      <textarea
                        value={interruptInputByMessageId[genericEditKey] || ''}
                        onChange={(event) => setInterruptValue(genericEditKey, event.target.value)}
                        className="w-full rounded-xl border border-slate-200/80 bg-white/80 p-2 text-xs text-slate-700 backdrop-blur-sm focus:border-sky-400 focus:outline-none"
                        rows={4}
                        placeholder="Optional edit feedback or updated args JSON"
                      />
                      {interruptMode === 'rejecting' ? (
                        <input
                          value={interruptInputByMessageId[rejectNoteKey] || ''}
                          onChange={(event) => setInterruptValue(rejectNoteKey, event.target.value)}
                          className="w-full rounded-xl border border-slate-200/80 bg-white/80 px-2 py-1.5 text-xs text-slate-700 backdrop-blur-sm focus:border-sky-400 focus:outline-none"
                          placeholder="Reason for rejection (optional)"
                        />
                      ) : null}
                      <div className="mt-1 flex flex-wrap gap-2">
                        {allowedInterruptDecisions.includes('approve') ? (
                          <button
                            type="button"
                            disabled={interruptBusy}
                            onClick={() => handleInterruptDecision(message, 'approve', pendingInterrupt)}
                            className="rounded-xl border border-emerald-300/80 bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Approve
                          </button>
                        ) : null}
                        {allowedInterruptDecisions.includes('edit') ? (
                          <button
                            type="button"
                            disabled={interruptBusy}
                            onClick={() => handleInterruptDecision(message, 'edit', pendingInterrupt)}
                            className="rounded-xl border border-blue-200/90 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 transition-all duration-200 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Edit
                          </button>
                        ) : null}
                        {allowedInterruptDecisions.includes('reject') ? (
                          interruptMode === 'rejecting' ? (
                            <>
                              <button
                                type="button"
                                disabled={interruptBusy}
                                onClick={() => handleInterruptDecision(message, 'reject', pendingInterrupt)}
                                className="rounded-xl border border-rose-300/80 bg-rose-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Confirm Rejection
                              </button>
                              <button
                                type="button"
                                disabled={interruptBusy}
                                onClick={() => setInterruptMode('review')}
                                className="rounded-xl border border-slate-300/80 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-all duration-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={interruptBusy}
                              onClick={() => setInterruptMode('rejecting')}
                              className="rounded-xl border border-rose-200/90 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 transition-all duration-200 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Reject
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : null}
            {pendingInterrupt && isClarificationInterrupt && !clarificationDismissed ? (
              <div className="mt-5 rounded-[2rem] border border-white/10 bg-[#121212] p-5 text-white shadow-[0_26px_80px_-34px_rgba(0,0,0,0.95)] ring-1 ring-white/10">
                <div
                  className="outline-none"
                  tabIndex={0}
                  onKeyDown={handleClarificationKeyDown}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[30px] font-semibold leading-tight tracking-tight text-white">
                        {pendingInterrupt.title || 'The agent needs clarification'}
                      </p>
                      {pendingInterrupt.description ? (
                        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/70">
                          {pendingInterrupt.description}
                        </p>
                      ) : null}
                    </div>
                    {pendingInterrupt.stepCount && pendingInterrupt.stepCount > 1 ? (
                      <div className="shrink-0 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white/75">
                        {typeof pendingInterrupt.stepIndex === 'number' ? pendingInterrupt.stepIndex + 1 : 1} of {pendingInterrupt.stepCount}
                      </div>
                    ) : null}
                  </div>
                  {clarificationDisplayPayload ? <div className="mt-5">{clarificationDisplayPayload}</div> : null}
                  {clarificationAllowsChoices && clarificationChoices.length ? (
                    <div className="mt-5 space-y-3">
                      {clarificationChoices.map((choice, index) => {
                        const selected = selectedChoiceIds.includes(choice.id);
                        return (
                          <button
                            key={choice.id}
                            type="button"
                            disabled={interruptBusy}
                            onClick={() => handleClarificationChoiceToggle(choice.id, choice.value)}
                            className={`flex w-full items-start justify-between rounded-[1.35rem] border px-5 py-4 text-left transition-all duration-200 ${
                              selected
                                ? 'border-white/70 bg-white/14 text-white shadow-[0_12px_36px_-24px_rgba(255,255,255,0.65)]'
                                : 'border-white/10 bg-white/[0.03] text-white/92 hover:border-white/25 hover:bg-white/[0.07]'
                            } ${interruptBusy ? 'cursor-not-allowed opacity-70' : ''}`}
                          >
                            <div className="min-w-0 pr-3">
                              <div className="flex items-center gap-3">
                                <span className={`text-2xl font-semibold ${selected ? 'text-white' : 'text-white/45'}`}>{index + 1}.</span>
                                <span className="text-[18px] font-semibold leading-snug">{choice.label}</span>
                              </div>
                              {choice.description ? (
                                <p className="mt-2 pl-11 text-sm leading-relaxed text-white/62">{choice.description}</p>
                              ) : null}
                            </div>
                            <span className={`mt-1 text-lg ${selected ? 'text-white' : 'text-white/35'}`}>{selected ? '↵' : ''}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {clarificationAllowsText ? (
                    <textarea
                      value={clarificationValue}
                      onChange={(event) => setInterruptValue(clarificationTextKey, event.target.value)}
                      rows={4}
                      disabled={interruptBusy}
                      placeholder={pendingInterrupt.responseSpec?.placeholder || 'Type your answer for the agent'}
                      className="mt-5 w-full rounded-[1.35rem] border border-white/10 bg-white/[0.03] px-5 py-4 text-sm leading-relaxed text-white placeholder:text-white/32 focus:border-white/25 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                    />
                  ) : null}
                  <div className="mt-6 flex items-center justify-between gap-4">
                    <button
                      type="button"
                      disabled={!allowDismiss || interruptBusy}
                      onClick={() => setClarificationDismissed(true)}
                      className={`rounded-full px-4 py-2 text-sm font-medium transition-all duration-200 ${
                        allowDismiss
                          ? 'text-white/70 hover:bg-white/[0.06] hover:text-white'
                          : 'cursor-not-allowed text-white/25'
                      }`}
                    >
                      {pendingInterrupt.responseSpec?.dismissLabel || 'Dismiss'}
                    </button>
                    <button
                      type="button"
                      disabled={interruptBusy || (!clarificationValue.trim() && !selectedChoiceIds.length && clarificationInputMode !== 'none')}
                      onClick={() => handleClarificationResponse(message, pendingInterrupt)}
                      className="inline-flex items-center gap-2 rounded-full bg-[#94c5f8] px-5 py-3 text-sm font-semibold text-slate-900 transition-all duration-200 hover:bg-[#a8d2fb] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {interruptBusy ? <Loader2 size={16} className="animate-spin" /> : null}
                      <span>{pendingInterrupt.responseSpec?.submitLabel || 'Continue'}</span>
                    </button>
                  </div>
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

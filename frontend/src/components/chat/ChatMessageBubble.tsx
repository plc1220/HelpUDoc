import { Copy, RotateCcw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';

import type { ConversationMessage, ConversationMessageMetadata } from '../../types';
import ToolOutputFilePreview from './ToolOutputFilePreview';

const THOUGHT_PREVIEW_LIMIT = 320;
const THINKING_PLACEHOLDER = 'Formulating a research plan based on your prompt and available context.';

export default function ChatMessageBubble({
  message,
  personaDisplayName,
  messageBubbleMaxWidth,
  markdownComponents,
  expandedToolMessages,
  expandedThinkingMessages,
  copiedMessageId,
  approvalFeedbackByMessageId,
  approvalSubmittingByMessageId,
  approvalFieldKey,
  formatMessageTimestamp,
  getAllowedDecisions,
  getPrimaryInterruptAction,
  isPlanApprovalInterrupt,
  setApprovalFeedbackByMessageId,
  toggleThinkingVisibility,
  toggleToolActivityVisibility,
  handleCopyMessageText,
  handleRerunMessage,
  handleInterruptDecision,
  isStreaming,
  workspaceId,
}: {
  message: ConversationMessage;
  personaDisplayName: string;
  messageBubbleMaxWidth: string;
  markdownComponents: Record<string, any>;
  expandedToolMessages: Set<ConversationMessage['id']>;
  expandedThinkingMessages: Set<ConversationMessage['id']>;
  copiedMessageId: ConversationMessage['id'] | null;
  approvalFeedbackByMessageId: Record<string, string>;
  approvalSubmittingByMessageId: Record<string, boolean>;
  approvalFieldKey: (messageKey: string, field: 'feedback' | 'edit-json' | 'reject-note') => string;
  formatMessageTimestamp: (value?: string) => string;
  getAllowedDecisions: (
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => Array<'approve' | 'edit' | 'reject'>;
  getPrimaryInterruptAction: (
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => { name?: string; args?: Record<string, unknown> } | undefined;
  isPlanApprovalInterrupt: (pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt']) => boolean;
  setApprovalFeedbackByMessageId: Dispatch<SetStateAction<Record<string, string>>>;
  toggleThinkingVisibility: (messageId: ConversationMessage['id']) => void;
  toggleToolActivityVisibility: (messageId: ConversationMessage['id']) => void;
  handleCopyMessageText: (message: ConversationMessage) => void;
  handleRerunMessage: (messageId: ConversationMessage['id']) => void;
  handleInterruptDecision: (
    message: ConversationMessage,
    decision: 'approve' | 'edit' | 'reject',
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
  const allowedInterruptDecisions = getAllowedDecisions(pendingInterrupt);
  const primaryInterruptAction = getPrimaryInterruptAction(pendingInterrupt);
  const isPlanApprovalRequest = isPlanApprovalInterrupt(pendingInterrupt);
  const messageKey = String(message.id);
  const decisionBusy = Boolean(approvalSubmittingByMessageId[messageKey]);
  const [interruptMode, setInterruptMode] = useState<'review' | 'editing' | 'rejecting'>('review');
  const isToolActivityExpanded = expandedToolMessages.has(message.id);
  const isThinkingExpanded = expandedThinkingMessages.has(message.id);
  const rawThinkingText = message.thinkingText?.trim() || '';
  const isSystemThinking = /available skills/i.test(rawThinkingText);
  const displayThinkingText = isSystemThinking ? THINKING_PLACEHOLDER : rawThinkingText;
  const showThinkingToggle = !isSystemThinking && displayThinkingText.length > THOUGHT_PREVIEW_LIMIT;
  const isThinkingCollapsed = showThinkingToggle && !isThinkingExpanded;
  const sanitizedAgentText = (() => {
    const raw = message.text || '';
    if (!pendingInterrupt || !raw) {
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
  const copyTitle = copiedMessageId === message.id ? 'Copied!' : 'Copy message';
  const copyButtonPositionClass = message.sender === 'user' ? 'right-10' : 'right-2';
  const planFeedbackKey = approvalFieldKey(messageKey, 'feedback');
  const genericEditKey = approvalFieldKey(messageKey, 'edit-json');
  const rejectNoteKey = approvalFieldKey(messageKey, 'reject-note');

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
    }
  }, [pendingInterrupt, messageKey]);

  const setApprovalValue = (fieldKey: string, value: string) => {
    setApprovalFeedbackByMessageId((prev) => ({
      ...prev,
      [fieldKey]: value,
    }));
  };

  return (
    <div
      className={`group flex items-start gap-3 motion-safe:animate-[chat-pane-message-in_220ms_ease-out] ${isAgentMessage ? '' : 'justify-end'
        }`}
    >
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
            ) : (
              <span className="mt-3 block text-sm text-slate-500">
                {displayThinkingText ? 'Finalizing response...' : 'Thinking...'}
              </span>
            )}
            {pendingInterrupt ? (
              <div className="relative mt-4 pl-4 before:absolute before:-bottom-2 before:left-1 before:top-2 before:w-px before:bg-slate-200">
                <span className="absolute left-0 top-3 h-2.5 w-2.5 rounded-full border border-indigo-300 bg-indigo-100" />
                <div className="rounded-2xl border border-sky-200/70 bg-gradient-to-br from-white/75 via-sky-50/70 to-indigo-100/60 p-4 shadow-[0_18px_40px_-28px_rgba(30,64,175,0.75)] backdrop-blur-md">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">Approval Required</p>
                <p className="mt-1 text-sm text-slate-700">
                  Please review the proposed plan below before continuing.
                </p>
                {isPlanApprovalRequest ? (
                  <div className="mt-3 grid gap-2">
                    {interruptMode === 'editing' ? (
                      <textarea
                        value={approvalFeedbackByMessageId[planFeedbackKey] || ''}
                        onChange={(event) => setApprovalValue(planFeedbackKey, event.target.value)}
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
                        value={approvalFeedbackByMessageId[rejectNoteKey] || ''}
                        onChange={(event) => setApprovalValue(rejectNoteKey, event.target.value)}
                        className="w-full rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm text-slate-700 backdrop-blur-sm focus:border-sky-400 focus:outline-none"
                        placeholder="Reason for rejection (optional)"
                      />
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-2">
                      {interruptMode === 'editing' ? (
                        <>
                          <button
                            type="button"
                            disabled={decisionBusy}
                            onClick={() => handleInterruptDecision(message, 'edit', pendingInterrupt)}
                            className="rounded-xl border border-blue-300/80 bg-blue-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Save Changes
                          </button>
                          <button
                            type="button"
                            disabled={decisionBusy}
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
                            disabled={decisionBusy}
                            onClick={() => handleInterruptDecision(message, 'reject', pendingInterrupt)}
                            className="rounded-xl border border-rose-300/80 bg-rose-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Confirm Rejection
                          </button>
                          <button
                            type="button"
                            disabled={decisionBusy}
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
                              disabled={decisionBusy}
                              onClick={() => handleInterruptDecision(message, 'approve', pendingInterrupt)}
                              className="rounded-xl border border-emerald-300/80 bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Approve
                            </button>
                          ) : null}
                          {allowedInterruptDecisions.includes('edit') ? (
                            <button
                              type="button"
                              disabled={decisionBusy}
                              onClick={() => {
                                if (!(approvalFeedbackByMessageId[planFeedbackKey] || '').trim()) {
                                  setApprovalValue(planFeedbackKey, planText);
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
                              disabled={decisionBusy}
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
                    <textarea
                      value={approvalFeedbackByMessageId[genericEditKey] || ''}
                      onChange={(event) => setApprovalValue(genericEditKey, event.target.value)}
                      className="w-full rounded-xl border border-slate-200/80 bg-white/80 p-2 text-xs text-slate-700 backdrop-blur-sm focus:border-sky-400 focus:outline-none"
                      rows={4}
                      placeholder='Optional edit feedback or updated args JSON'
                    />
                    {interruptMode === 'rejecting' ? (
                      <input
                        value={approvalFeedbackByMessageId[rejectNoteKey] || ''}
                        onChange={(event) => setApprovalValue(rejectNoteKey, event.target.value)}
                        className="w-full rounded-xl border border-slate-200/80 bg-white/80 px-2 py-1.5 text-xs text-slate-700 backdrop-blur-sm focus:border-sky-400 focus:outline-none"
                        placeholder="Reason for rejection (optional)"
                      />
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-2">
                      {allowedInterruptDecisions.includes('approve') ? (
                        <button
                          type="button"
                          disabled={decisionBusy}
                          onClick={() => handleInterruptDecision(message, 'approve', pendingInterrupt)}
                          className="rounded-xl border border-emerald-300/80 bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Approve
                        </button>
                      ) : null}
                      {allowedInterruptDecisions.includes('edit') ? (
                        <button
                          type="button"
                          disabled={decisionBusy}
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
                              disabled={decisionBusy}
                              onClick={() => handleInterruptDecision(message, 'reject', pendingInterrupt)}
                              className="rounded-xl border border-rose-300/80 bg-rose-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Confirm Rejection
                            </button>
                            <button
                              type="button"
                              disabled={decisionBusy}
                              onClick={() => setInterruptMode('review')}
                              className="rounded-xl border border-slate-300/80 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-all duration-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={decisionBusy}
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
            {hasToolEvents ? (
              <div className="relative mt-3 pl-4">
                <span className="absolute left-0 top-2 h-2.5 w-2.5 rounded-full border border-slate-300 bg-slate-100" />
                <button
                  type="button"
                  onClick={() => toggleToolActivityVisibility(message.id)}
                  className="text-xs font-semibold uppercase tracking-wide text-slate-500 transition-all duration-200 hover:text-slate-700"
                >
                  {isToolActivityExpanded
                    ? 'Hide tool activity'
                    : `Show tool activity (${toolEvents.length})`}
                </button>
                {isToolActivityExpanded ? (
                  <div className="mt-2 rounded-2xl border border-slate-200 bg-white/80 px-3 py-3 text-xs text-slate-600 shadow-inner">
                    {toolEvents.map((event, index) => {
                      const isLast = index === toolEvents.length - 1;
                      return (
                        <div key={event.id || `${event.name}-${index}`} className="flex gap-3 pb-3 last:pb-0">
                          <div className="flex flex-col items-center">
                            <span
                              className={`h-2.5 w-2.5 rounded-full ${event.status === 'completed' ? 'bg-emerald-500' : 'bg-amber-400'
                                }`}
                            />
                            {!isLast ? <span className="h-full w-px flex-1 bg-slate-200" /> : null}
                          </div>
                          <div className="flex-1">
                            <p
                              className={`text-[11px] font-semibold uppercase tracking-wide ${event.status === 'error' ? 'text-red-500' : 'text-slate-500'
                                }`}
                            >
                              {event.name}
                            </p>
                            <p
                              className={`text-sm ${event.status === 'error' ? 'text-red-600' : 'text-slate-700'}`}
                            >
                              {event.summary ||
                                (event.status === 'completed'
                                  ? 'Completed'
                                  : event.status === 'error'
                                    ? 'Failed'
                                    : 'In progress...')}
                            </p>
                            <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-400">
                              {formatMessageTimestamp(event.startedAt)}
                              {event.finishedAt ? ` • ${formatMessageTimestamp(event.finishedAt)}` : ''}
                            </p>
                            {event.outputFiles?.length ? (
                              <div className="mt-2 space-y-3">
                                {event.outputFiles.map((file) => (
                                  <div
                                    key={`${event.id}-${file.path}`}
                                    className="rounded-lg border border-slate-200 bg-white p-2"
                                  >
                                    <p className="text-xs font-semibold text-slate-700">{file.path}</p>
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
        <button
          type="button"
          onClick={() => handleCopyMessageText(message)}
          disabled={!canCopyMessage}
          title={copyTitle}
          aria-label="Copy message text"
          className={`absolute -top-2 ${copyButtonPositionClass} rounded-full bg-white p-1.5 text-slate-600 shadow ring-1 ring-slate-200 transition-all duration-200 opacity-0 hover:bg-slate-50 group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-40`}
        >
          <Copy size={14} />
        </button>
        {message.sender === 'user' ? (
          <button
            type="button"
            onClick={() => handleRerunMessage(message.id)}
            disabled={isStreaming}
            title="Rerun this message"
            className={`absolute -right-2 -top-2 rounded-full bg-blue-500 p-1.5 text-white shadow transition-all duration-200 opacity-0 ${isStreaming
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

import { ArrowDown, MessageSquareText } from 'lucide-react';
import { type Dispatch, type ReactNode, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';

import type { ConversationMessage, ConversationMessageMetadata } from '../../types';
import ChatMessageBubble from './ChatMessageBubble';

export default function ChatMessageList({
  messages,
  isStreaming,
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
  workspaceId,
}: {
  messages: ConversationMessage[];
  isStreaming: boolean;
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
  workspaceId?: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const lastMessageSignature = useMemo(
    () => messages.map((message) => `${message.id}:${message.updatedAt || message.createdAt}:${message.text?.length || 0}`).join('|'),
    [messages],
  );

  useEffect(() => {
    const list = listRef.current;
    if (!list || !shouldAutoScroll) {
      return;
    }
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [lastMessageSignature, shouldAutoScroll, isStreaming]);

  useEffect(() => {
    setShowJumpToLatest(!shouldAutoScroll && messages.length > 0);
  }, [messages.length, shouldAutoScroll]);

  const handleScroll = () => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    setShouldAutoScroll(distanceFromBottom < 120);
  };

  const scrollToLatest = () => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    setShouldAutoScroll(true);
    setShowJumpToLatest(false);
  };

  const messageItems = useMemo(() => {
    const nodes: ReactNode[] = [];
    let previousDateLabel = '';
    messages.forEach((message) => {
      const dateLabel = formatDateLabel(message.updatedAt || message.createdAt);
      if (dateLabel && dateLabel !== previousDateLabel) {
        nodes.push(
          <div key={`date-${message.id}-${dateLabel}`} className="sticky top-2 z-10 flex justify-center py-1 pointer-events-none">
            <span className="rounded-full border border-slate-200/90 bg-white/85 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 shadow-sm backdrop-blur">
              {dateLabel}
            </span>
          </div>,
        );
        previousDateLabel = dateLabel;
      }
      nodes.push(
        <ChatMessageBubble
          key={message.id}
          message={message}
          personaDisplayName={personaDisplayName}
          messageBubbleMaxWidth={messageBubbleMaxWidth}
          markdownComponents={markdownComponents}
          expandedToolMessages={expandedToolMessages}
          expandedThinkingMessages={expandedThinkingMessages}
          copiedMessageId={copiedMessageId}
          approvalFeedbackByMessageId={approvalFeedbackByMessageId}
          approvalSubmittingByMessageId={approvalSubmittingByMessageId}
          approvalFieldKey={approvalFieldKey}
          formatMessageTimestamp={formatMessageTimestamp}
          getAllowedDecisions={getAllowedDecisions}
          getPrimaryInterruptAction={getPrimaryInterruptAction}
          isPlanApprovalInterrupt={isPlanApprovalInterrupt}
          setApprovalFeedbackByMessageId={setApprovalFeedbackByMessageId}
          toggleThinkingVisibility={toggleThinkingVisibility}
          toggleToolActivityVisibility={toggleToolActivityVisibility}
          handleCopyMessageText={handleCopyMessageText}
          handleRerunMessage={handleRerunMessage}
          handleInterruptDecision={handleInterruptDecision}
          isStreaming={isStreaming}
          workspaceId={workspaceId}
        />,
      );
    });
    return nodes;
  }, [
    approvalFeedbackByMessageId,
    approvalFieldKey,
    approvalSubmittingByMessageId,
    copiedMessageId,
    expandedThinkingMessages,
    expandedToolMessages,
    formatMessageTimestamp,
    getAllowedDecisions,
    getPrimaryInterruptAction,
    handleCopyMessageText,
    handleInterruptDecision,
    handleRerunMessage,
    isPlanApprovalInterrupt,
    isStreaming,
    markdownComponents,
    messageBubbleMaxWidth,
    messages,
    personaDisplayName,
    setApprovalFeedbackByMessageId,
    toggleThinkingVisibility,
    toggleToolActivityVisibility,
    workspaceId,
  ]);

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-4 py-4 min-h-0"
      >
        <div className="mx-auto w-full max-w-5xl space-y-4">
          {messages.length === 0 ? (
            <div className="flex h-full min-h-[40vh] flex-col items-center justify-center text-center text-slate-400">
              <div className="rounded-2xl border border-slate-200 bg-white/70 px-6 py-8 shadow-sm backdrop-blur-sm">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                  <MessageSquareText size={18} />
                </div>
                <p className="text-sm font-semibold text-slate-600">No messages yet</p>
                <p className="mt-1 text-xs text-slate-500">Ask the agent to inspect files, generate content, or run a task.</p>
              </div>
            </div>
          ) : (
            messageItems
          )}
        </div>
      </div>
      {showJumpToLatest ? (
        <button
          type="button"
          onClick={scrollToLatest}
          className="absolute bottom-4 right-4 inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-lg backdrop-blur transition-all duration-200 hover:bg-white"
          title="Jump to latest message"
        >
          <ArrowDown size={14} />
          Latest
        </button>
      ) : null}
    </div>
  );
}

function formatDateLabel(value?: string): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const today = new Date();
  const todayKey = today.toDateString();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const yesterdayKey = yesterday.toDateString();
  const dateKey = date.toDateString();
  if (dateKey === todayKey) {
    return 'Today';
  }
  if (dateKey === yesterdayKey) {
    return 'Yesterday';
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

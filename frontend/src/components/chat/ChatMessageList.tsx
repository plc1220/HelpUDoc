import { ArrowDown, MessageSquareText } from 'lucide-react';
import { type Dispatch, type ReactNode, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ConversationMessage,
  ConversationMessageMetadata,
  InterruptAnswersByQuestionId,
} from '../../types';
import ChatMessageBubble from './ChatMessageBubble';
import type { RenderableInterruptAction } from './interruptActions';

export default function ChatMessageList({
  colorMode,
  messages,
  isStreaming,
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
  workspaceSkipPlanApprovals,
  workspaceSettingsBusy,
  toggleThinkingVisibility,
  toggleToolActivityVisibility,
  handleCopyMessageText,
  handleRerunMessage,
  handlePrepareInterruptAction,
  handleInterruptAction,
  enableTrustedPlanMode,
  workspaceId,
}: {
  colorMode: 'light' | 'dark';
  messages: ConversationMessage[];
  isStreaming: boolean;
  personaDisplayName: string;
  messageBubbleMaxWidth: string;
  markdownComponents: Record<string, any>;
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
  workspaceId?: string;
}) {
  const isDarkMode = colorMode === 'dark';
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

  const latestAgentMessageId = useMemo(() => {
    const latestAgentMessage = [...messages].reverse().find((message) => message.sender === 'agent');
    return latestAgentMessage?.id ?? null;
  }, [messages]);

  const messageItems = useMemo(() => {
    const nodes: ReactNode[] = [];
    let previousDateLabel = '';
    messages.forEach((message) => {
      const dateLabel = formatDateLabel(message.updatedAt || message.createdAt);
      if (dateLabel && dateLabel !== previousDateLabel) {
        nodes.push(
          <div key={`date-${message.id}-${dateLabel}`} className="pointer-events-none sticky top-2 z-10 flex justify-center py-1">
            <span className={`rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-wide shadow-sm backdrop-blur ${
              isDarkMode
                ? 'border-slate-700/70 bg-slate-900/85 text-slate-300'
                : 'border-slate-200/80 bg-slate-900 text-slate-100'
            }`}>
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
          isLatestAgentMessage={message.sender === 'agent' && message.id === latestAgentMessageId}
          personaDisplayName={personaDisplayName}
          messageBubbleMaxWidth={messageBubbleMaxWidth}
          markdownComponents={markdownComponents}
          expandedToolMessages={expandedToolMessages}
          expandedThinkingMessages={expandedThinkingMessages}
          copiedMessageId={copiedMessageId}
          interruptInputByMessageId={interruptInputByMessageId}
          interruptStructuredAnswersByMessageId={interruptStructuredAnswersByMessageId}
          interruptSelectedChoicesByMessageId={interruptSelectedChoicesByMessageId}
          interruptSubmittingByMessageId={interruptSubmittingByMessageId}
          interruptErrorByMessageId={interruptErrorByMessageId}
          interruptFieldKey={interruptFieldKey}
          interruptActionFieldKey={interruptActionFieldKey}
          formatMessageTimestamp={formatMessageTimestamp}
          getInterruptKind={getInterruptKind}
          getInterruptActions={getInterruptActions}
          getPrimaryInterruptAction={getPrimaryInterruptAction}
          isPlanApprovalInterrupt={isPlanApprovalInterrupt}
          setInterruptInputByMessageId={setInterruptInputByMessageId}
          setInterruptStructuredAnswersByMessageId={setInterruptStructuredAnswersByMessageId}
          toggleInterruptSelectedChoice={toggleInterruptSelectedChoice}
          workspaceSkipPlanApprovals={workspaceSkipPlanApprovals}
          workspaceSettingsBusy={workspaceSettingsBusy}
          toggleThinkingVisibility={toggleThinkingVisibility}
          toggleToolActivityVisibility={toggleToolActivityVisibility}
          handleCopyMessageText={handleCopyMessageText}
          handleRerunMessage={handleRerunMessage}
          handlePrepareInterruptAction={handlePrepareInterruptAction}
          handleInterruptAction={handleInterruptAction}
          enableTrustedPlanMode={enableTrustedPlanMode}
          isStreaming={isStreaming}
          workspaceId={workspaceId}
          colorMode={colorMode}
        />,
      );
    });
    return nodes;
  }, [
    interruptFieldKey,
    interruptActionFieldKey,
    interruptInputByMessageId,
    interruptStructuredAnswersByMessageId,
    interruptSelectedChoicesByMessageId,
    interruptSubmittingByMessageId,
    interruptErrorByMessageId,
    copiedMessageId,
    expandedThinkingMessages,
    expandedToolMessages,
    formatMessageTimestamp,
    getInterruptKind,
    getInterruptActions,
    getPrimaryInterruptAction,
    handleCopyMessageText,
    handleInterruptAction,
    handleRerunMessage,
    isPlanApprovalInterrupt,
    isStreaming,
    workspaceSkipPlanApprovals,
    workspaceSettingsBusy,
    markdownComponents,
    messageBubbleMaxWidth,
    messages,
    personaDisplayName,
    latestAgentMessageId,
    setInterruptInputByMessageId,
    setInterruptStructuredAnswersByMessageId,
    toggleInterruptSelectedChoice,
    toggleThinkingVisibility,
    toggleToolActivityVisibility,
    workspaceId,
    handlePrepareInterruptAction,
    enableTrustedPlanMode,
    colorMode,
    isDarkMode,
  ]);

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-3 py-3 min-h-0"
      >
        <div className="mx-auto w-full max-w-[72rem] space-y-3">
          {messages.length === 0 ? (
            <div className={`flex h-full min-h-[40vh] flex-col items-center justify-center text-center ${
              isDarkMode ? 'text-slate-400' : 'text-slate-500'
            }`}>
              <div className={`rounded-3xl border px-5 py-7 backdrop-blur-sm ${
                isDarkMode
                  ? 'border-slate-700/70 bg-slate-900/75 shadow-[0_20px_50px_-32px_rgba(15,23,42,0.95)]'
                  : 'border-slate-200/80 bg-white/92 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.16)]'
              }`}>
                <div className={`mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border ${
                  isDarkMode
                    ? 'border-slate-700/70 bg-slate-950/90 text-slate-300'
                    : 'border-slate-200 bg-slate-100 text-slate-600'
                }`}>
                  <MessageSquareText size={18} />
                </div>
                <p className={`text-sm font-semibold ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>No messages yet</p>
                <p className={`mt-1 text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Ask the agent to inspect files, generate content, or run a task.</p>
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
          className={`absolute bottom-4 right-4 inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-lg backdrop-blur transition-all duration-200 ${
            isDarkMode
              ? 'border-slate-700/70 bg-slate-900/95 text-slate-200 hover:bg-slate-800'
              : 'border-slate-200 bg-white/95 text-slate-700 hover:bg-slate-50'
          }`}
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

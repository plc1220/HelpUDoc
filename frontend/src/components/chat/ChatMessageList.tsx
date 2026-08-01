import {
  ChatMessageList as AstryxChatMessageList,
  ChatSystemMessage,
} from '@astryxdesign/core/Chat';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import type { InteractionRequest, InteractionResponse } from '@helpudoc/contracts/types';
import { MessageSquareText } from 'lucide-react';
import { type Dispatch, type SetStateAction, useMemo } from 'react';
import type { Components } from 'react-markdown';

import type {
  ConversationMessage,
  ConversationMessageMetadata,
  InterruptAnswersByQuestionId,
} from '../../types';
import ChatMessageBubble from './ChatMessageBubble';
import type { RenderableInterruptAction } from './interruptActions';

type RerunMessageOptions = {
  replacementText?: string;
  skipConfirm?: boolean;
};

export default function ChatMessageList({
  colorMode,
  messages,
  isStreaming,
  personaDisplayName,
  emptyStateDescription = 'Ask Lumo to inspect files, create an artifact, or run a workflow.',
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
  handleScheduleMessage,
  handlePrepareInterruptAction,
  handleInterruptAction,
  workspaceId,
  onInteractionSubmit,
}: {
  colorMode: 'light' | 'dark';
  messages: ConversationMessage[];
  isStreaming: boolean;
  personaDisplayName: string;
  emptyStateDescription?: string;
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
  handleScheduleMessage?: (message: ConversationMessage) => void;
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
  workspaceId?: string;
  onInteractionSubmit?: (
    response: InteractionResponse,
    request: InteractionRequest,
    message?: ConversationMessage,
  ) => Promise<void>;
}) {
  const latestAgentMessageId = useMemo(() => {
    const latestAgentMessage = [...messages].reverse().find((message) => message.sender === 'agent');
    return latestAgentMessage?.id ?? null;
  }, [messages]);

  const messageGroups = useMemo(() => {
    const groups: { dateLabel: string; messages: ConversationMessage[] }[] = [];
    messages.forEach((message) => {
      const dateLabel = formatDateLabel(message.updatedAt || message.createdAt);
      const lastGroup = groups[groups.length - 1];
      if (!lastGroup || lastGroup.dateLabel !== dateLabel) {
        groups.push({ dateLabel, messages: [message] });
        return;
      }
      lastGroup.messages.push(message);
    });
    return groups;
  }, [messages]);

  return (
    <div className="lumo-message-list">
      <AstryxChatMessageList
        density="balanced"
        gap={3}
        isStreaming={isStreaming}
        emptyState={(
          <EmptyState
            title="Start with trusted context"
            description={emptyStateDescription}
            icon={<Icon icon={MessageSquareText} size="lg" color="accent" />}
          />
        )}
      >
        {messageGroups.flatMap((group, groupIndex) => [
          group.dateLabel ? (
            <ChatSystemMessage
              key={`date-${group.dateLabel}-${groupIndex}`}
              variant="divider"
            >
              {group.dateLabel}
            </ChatSystemMessage>
          ) : null,
          ...group.messages.map((message) => (
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
              toggleThinkingVisibility={toggleThinkingVisibility}
              toggleToolActivityVisibility={toggleToolActivityVisibility}
              handleCopyMessageText={handleCopyMessageText}
              handleRerunMessage={handleRerunMessage}
              handleScheduleMessage={handleScheduleMessage}
              handlePrepareInterruptAction={handlePrepareInterruptAction}
              handleInterruptAction={handleInterruptAction}
              workspaceId={workspaceId}
              colorMode={colorMode}
              isStreaming={isStreaming}
              onInteractionSubmit={onInteractionSubmit}
            />
          )),
        ])}
      </AstryxChatMessageList>
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
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

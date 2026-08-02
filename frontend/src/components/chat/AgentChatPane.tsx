import type {
  ChangeEvent,
  ClipboardEvent,
  CSSProperties,
  Dispatch,
  KeyboardEvent,
  RefObject,
  SetStateAction,
  SyntheticEvent,
} from 'react';
import { useEffect, useState } from 'react';
import { ChatLayout } from '@astryxdesign/core/Chat';
import type { Components } from 'react-markdown';
import type { InteractionRequest, InteractionResponse } from '@helpudoc/contracts/types';
import type {
  AgentPersona,
  ConversationMessage,
  ConversationMessageMetadata,
  ConversationSummary,
  InterruptAnswersByQuestionId,
  Workspace,
} from '../../types';
import ChatHeader from './ChatHeader';
import ChatHistoryPanel from './ChatHistoryPanel';
import ChatInputArea, { type ChatMentionSuggestion } from './ChatInputArea';
import ChatMessageList from './ChatMessageList';
import type { RenderableInterruptAction } from './interruptActions';
import type { ChatComposerAttachment } from './chatTypes';
import PublishedWorkspaceChatHeader, {
  type PublishedChatMode,
} from './PublishedWorkspaceChatHeader';
import WorkspaceTeamChatPanel from './WorkspaceTeamChatPanel';

type CommandSuggestion = {
  id: string;
  command: string;
  description: string;
};

type CommandTag = {
  id: string;
  label: string;
};

type ConversationStreamingMap = Record<string, boolean>;

type ConversationAttentionState = {
  status: 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  label?: string;
  updatedAt: string;
};

type RerunMessageOptions = {
  replacementText?: string;
  skipConfirm?: boolean;
};

export default function AgentChatPane({
  colorMode,
  agentPaneStyles,
  isAgentPaneVisible,
  isAgentPaneFullScreen,
  isEditMode,
  isHistoryOpen,
  personas,
  selectedPersona,
  conversationHistory,
  activeConversationId,
  conversationStreaming,
  messages,
  isStreaming,
  isPreparingAttachments,
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
  chatMessage,
  chatAttachments,
  commandTags,
  isMentionOpen,
  mentionSuggestions,
  mentionSelectedIndex,
  isCommandOpen,
  commandSuggestions,
  commandSelectedIndex,
  chatInputRef,
  attachmentInputRef,
  workspaceId,
  isPublishedWorkspace,
  publishedWorkspace,
  activeFilePath,
  internetSearchEnabled,
  formatMessageTimestamp,
  interruptFieldKey,
  interruptActionFieldKey,
  getInterruptKind,
  getInterruptActions,
  getPrimaryInterruptAction,
  isPlanApprovalInterrupt,
  setInterruptInputByMessageId,
  setInterruptStructuredAnswersByMessageId,
  toggleInterruptSelectedChoice,
  conversationAttentionById,
  onToggleAgentPaneVisibility,
  onModeChange,
  onToggleHistory,
  onNewChat,
  onScheduleChat,
  onScheduleMessage,
  onToggleFullScreen,
  onCloseHistory,
  onSelectConversation,
  onDeleteConversation,
  onToggleThinkingVisibility,
  onToggleToolActivityVisibility,
  onCopyMessageText,
  onRerunMessage,
  onPrepareInterruptAction,
  onInterruptAction,
  onChatInputChange,
  onChatInputKeyDown,
  onChatInputKeyUp,
  onChatInputSelectionChange,
  onChatInputPaste,
  onOpenLocalAttachmentPicker,
  onInsertKnowledgeTrigger,
  onToggleInternetSearch,
  onInsertSlashTrigger,
  onStopStreaming,
  onSendMessage,
  onChatAttachmentChange,
  onRemoveChatAttachment,
  onRemoveCommandTag,
  onSelectMention,
  onSelectCommand,
  onInteractionSubmit,
  onOpenCollaboration,
}: {
  colorMode: 'light' | 'dark';
  agentPaneStyles: CSSProperties;
  isAgentPaneVisible: boolean;
  isAgentPaneFullScreen: boolean;
  isEditMode: boolean;
  isHistoryOpen: boolean;
  personas: AgentPersona[];
  selectedPersona: string;
  conversationHistory: ConversationSummary[];
  activeConversationId: string | null;
  conversationStreaming: ConversationStreamingMap;
  messages: ConversationMessage[];
  isStreaming: boolean;
  isPreparingAttachments: boolean;
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
  chatMessage: string;
  chatAttachments: ChatComposerAttachment[];
  commandTags: CommandTag[];
  isMentionOpen: boolean;
  mentionSuggestions: ChatMentionSuggestion[];
  mentionSelectedIndex: number;
  isCommandOpen: boolean;
  commandSuggestions: CommandSuggestion[];
  commandSelectedIndex: number;
  chatInputRef: RefObject<HTMLTextAreaElement | null>;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  workspaceId?: string;
  isPublishedWorkspace?: boolean;
  publishedWorkspace?: Workspace;
  activeFilePath?: string;
  internetSearchEnabled: boolean;
  formatMessageTimestamp: (value?: string) => string;
  interruptFieldKey: (
    messageKey: string,
    field: 'feedback' | 'edit-json' | 'reject-note' | 'clarification-text',
  ) => string;
  interruptActionFieldKey: (messageKey: string, actionId: string) => string;
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
  conversationAttentionById: Record<string, ConversationAttentionState>;
  onToggleAgentPaneVisibility: () => void;
  onModeChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onToggleHistory: () => void;
  onNewChat: () => void;
  onScheduleChat?: () => void;
  onScheduleMessage?: (message: ConversationMessage) => void;
  onToggleFullScreen: () => void;
  onCloseHistory: () => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onToggleThinkingVisibility: (messageId: ConversationMessage['id']) => void;
  onToggleToolActivityVisibility: (messageId: ConversationMessage['id']) => void;
  onCopyMessageText: (message: ConversationMessage) => void;
  onRerunMessage: (messageId: ConversationMessage['id'], options?: RerunMessageOptions) => void;
  onPrepareInterruptAction: (
    message: ConversationMessage,
    action: RenderableInterruptAction,
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => void;
  onInterruptAction: (
    message: ConversationMessage,
    action: RenderableInterruptAction,
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => void;
  onChatInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onChatInputKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onChatInputKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onChatInputSelectionChange: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onChatInputPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onOpenLocalAttachmentPicker: () => void;
  onInsertKnowledgeTrigger: () => void;
  onToggleInternetSearch: () => void;
  onInsertSlashTrigger: () => void;
  onStopStreaming: () => void;
  onSendMessage: () => void;
  onChatAttachmentChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveChatAttachment: (index: number) => void;
  onRemoveCommandTag: (tagId: string) => void;
  onSelectMention: (suggestion: ChatMentionSuggestion) => void;
  onSelectCommand: (command: CommandSuggestion) => void;
  onInteractionSubmit?: (response: InteractionResponse, request: InteractionRequest, message?: ConversationMessage) => Promise<void>;
  onOpenCollaboration?: () => void;
}) {
  const isDarkMode = colorMode === 'dark';
  const [publishedMode, setPublishedMode] = useState<PublishedChatMode>('team');

  useEffect(() => {
    setPublishedMode('team');
  }, [publishedWorkspace?.id]);

  return (
    <div
      className="lumo-agent-pane"
      style={agentPaneStyles}
    >
      {isPublishedWorkspace && publishedWorkspace ? (
        <PublishedWorkspaceChatHeader
          colorMode={colorMode}
          isAgentPaneVisible={isAgentPaneVisible}
          isAgentPaneFullScreen={isAgentPaneFullScreen}
          mode={publishedMode}
          personas={personas}
          selectedPersona={selectedPersona}
          onToggleVisibility={onToggleAgentPaneVisibility}
          onModeChange={setPublishedMode}
          onPersonaChange={onModeChange}
          onToggleHistory={onToggleHistory}
          onNewChat={onNewChat}
          onOpenCollaboration={onOpenCollaboration || (() => undefined)}
          onToggleFullScreen={onToggleFullScreen}
        />
      ) : (
        <ChatHeader
          colorMode={colorMode}
          isAgentPaneVisible={isAgentPaneVisible}
          isEditMode={isEditMode}
          isHistoryOpen={isHistoryOpen}
          isAgentPaneFullScreen={isAgentPaneFullScreen}
          onToggleVisibility={onToggleAgentPaneVisibility}
          onToggleHistory={onToggleHistory}
          onNewChat={onNewChat}
          onScheduleChat={onScheduleChat}
          onToggleFullScreen={onToggleFullScreen}
        />
      )}
      <div className={`lumo-agent-pane-body ${isAgentPaneFullScreen || isAgentPaneVisible ? '' : 'lumo-agent-pane-hidden'}`}>
        {isPublishedWorkspace && publishedWorkspace && publishedMode === 'team' ? (
          <WorkspaceTeamChatPanel
            workspace={publishedWorkspace}
            filePath={activeFilePath}
            colorMode={colorMode}
            onOpenCollaboration={onOpenCollaboration || (() => undefined)}
          />
        ) : (
          <>
            <ChatHistoryPanel
              colorMode={colorMode}
              isHistoryOpen={isHistoryOpen}
              conversationHistory={conversationHistory}
              activeConversationId={activeConversationId}
              conversationStreaming={conversationStreaming}
              conversationAttentionById={conversationAttentionById}
              personas={personas}
              onClose={onCloseHistory}
              onSelectConversation={onSelectConversation}
              onDeleteConversation={onDeleteConversation}
            />
            {isPublishedWorkspace ? (
              <div className={`border-b px-4 py-2 text-xs ${
                isDarkMode
                  ? 'border-violet-900/60 bg-violet-950/30 text-violet-200'
                  : 'border-violet-100 bg-violet-50 text-violet-700'
              }`}>
                Private with Lumo is visible only to you. Lumo may analyze shared files, but cannot edit them.
              </div>
            ) : null}
            <ChatLayout
              className="lumo-chat-layout"
              density={isAgentPaneFullScreen ? 'spacious' : 'balanced'}
              composer={(
                <ChatInputArea
                  colorMode={colorMode}
                  chatMessage={chatMessage}
                  chatAttachments={chatAttachments}
                  placeholder={isPublishedWorkspace
                    ? 'Ask Lumo about this shared workspace…'
                    : undefined}
                  chatInputRef={chatInputRef}
                  attachmentInputRef={attachmentInputRef}
                  isStreaming={isStreaming}
                  isPreparingAttachments={isPreparingAttachments}
                  personas={personas}
                  selectedPersona={selectedPersona}
                  internetSearchEnabled={internetSearchEnabled}
                  commandTags={commandTags}
                  isMentionOpen={isMentionOpen}
                  mentionSuggestions={mentionSuggestions}
                  mentionSelectedIndex={mentionSelectedIndex}
                  isCommandOpen={isCommandOpen}
                  commandSuggestions={commandSuggestions}
                  commandSelectedIndex={commandSelectedIndex}
                  onChatInputChange={onChatInputChange}
                  onChatInputKeyDown={onChatInputKeyDown}
                  onChatInputKeyUp={onChatInputKeyUp}
                  onChatInputSelectionChange={onChatInputSelectionChange}
                  onChatInputPaste={onChatInputPaste}
                  onOpenLocalAttachmentPicker={onOpenLocalAttachmentPicker}
                  onModeChange={(personaName) => {
                    onModeChange({ target: { value: personaName } } as ChangeEvent<HTMLSelectElement>);
                  }}
                  onInsertKnowledgeTrigger={onInsertKnowledgeTrigger}
                  onToggleInternetSearch={onToggleInternetSearch}
                  onInsertSlashTrigger={onInsertSlashTrigger}
                  onStopStreaming={onStopStreaming}
                  onSendMessage={onSendMessage}
                  onChatAttachmentChange={onChatAttachmentChange}
                  onRemoveChatAttachment={onRemoveChatAttachment}
                  onRemoveCommandTag={onRemoveCommandTag}
                  onSelectMention={onSelectMention}
                  onSelectCommand={onSelectCommand}
                />
              )}
            >
              <ChatMessageList
                colorMode={colorMode}
                messages={messages}
                isStreaming={isStreaming}
                personaDisplayName={personaDisplayName}
                emptyStateDescription={isPublishedWorkspace
                  ? 'Ask Lumo to explain, summarize, or analyze the shared workspace without changing it.'
                  : undefined}
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
                getInterruptKind={getInterruptKind}
                formatMessageTimestamp={formatMessageTimestamp}
                getInterruptActions={getInterruptActions}
                getPrimaryInterruptAction={getPrimaryInterruptAction}
                isPlanApprovalInterrupt={isPlanApprovalInterrupt}
                setInterruptInputByMessageId={setInterruptInputByMessageId}
                setInterruptStructuredAnswersByMessageId={setInterruptStructuredAnswersByMessageId}
                toggleInterruptSelectedChoice={toggleInterruptSelectedChoice}
                toggleThinkingVisibility={onToggleThinkingVisibility}
                toggleToolActivityVisibility={onToggleToolActivityVisibility}
                handleCopyMessageText={onCopyMessageText}
                handleRerunMessage={onRerunMessage}
                handleScheduleMessage={onScheduleMessage}
                handlePrepareInterruptAction={onPrepareInterruptAction}
                handleInterruptAction={onInterruptAction}
                workspaceId={workspaceId}
                onInteractionSubmit={onInteractionSubmit}
              />
            </ChatLayout>
          </>
        )}
      </div>
    </div>
  );
}

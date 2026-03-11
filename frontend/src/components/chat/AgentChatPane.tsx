import type {
  ChangeEvent,
  CSSProperties,
  Dispatch,
  KeyboardEvent,
  RefObject,
  SetStateAction,
  SyntheticEvent,
} from 'react';

import type {
  AgentPersona,
  ConversationMessage,
  ConversationMessageMetadata,
  ConversationSummary,
  File as WorkspaceFile,
} from '../../types';
import ChatHeader from './ChatHeader';
import ChatHistoryPanel from './ChatHistoryPanel';
import ChatInputArea from './ChatInputArea';
import ChatMessageList from './ChatMessageList';
import type { RenderableInterruptAction } from './interruptActions';

type CommandSuggestion = {
  id: string;
  command: string;
  description: string;
};

type ConversationStreamingMap = Record<string, boolean>;

export default function AgentChatPane({
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
  personaDisplayName,
  messageBubbleMaxWidth,
  markdownComponents,
  expandedToolMessages,
  expandedThinkingMessages,
  copiedMessageId,
  interruptInputByMessageId,
  interruptSubmittingByMessageId,
  interruptErrorByMessageId,
  chatMessage,
  chatAttachments,
  showPaper2SlidesControls,
  presentationStatus,
  presentationOptionSummary,
  isMentionOpen,
  mentionSuggestions,
  mentionSelectedIndex,
  isCommandOpen,
  commandSuggestions,
  commandSelectedIndex,
  chatInputRef,
  attachmentInputRef,
  workspaceId,
  formatMessageTimestamp,
  interruptFieldKey,
  interruptActionFieldKey,
  getInterruptKind,
  getInterruptActions,
  getPrimaryInterruptAction,
  isPlanApprovalInterrupt,
  setInterruptInputByMessageId,
  onToggleAgentPaneVisibility,
  onModeChange,
  onToggleHistory,
  onNewChat,
  onToggleFullScreen,
  onCloseHistory,
  onSelectConversation,
  onDeleteConversation,
  onToggleThinkingVisibility,
  onToggleToolActivityVisibility,
  onCopyMessageText,
  onRerunMessage,
  onInterruptAction,
  onChatInputChange,
  onChatInputKeyDown,
  onChatInputKeyUp,
  onChatInputSelectionChange,
  onChatAttachmentButtonClick,
  onInsertSlashTrigger,
  onOpenPresentationModal,
  onStopStreaming,
  onSendMessage,
  onChatAttachmentChange,
  onRemoveChatAttachment,
  onSelectMention,
  onSelectCommand,
}: {
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
  personaDisplayName: string;
  messageBubbleMaxWidth: string;
  markdownComponents: Record<string, any>;
  expandedToolMessages: Set<ConversationMessage['id']>;
  expandedThinkingMessages: Set<ConversationMessage['id']>;
  copiedMessageId: ConversationMessage['id'] | null;
  interruptInputByMessageId: Record<string, string>;
  interruptSubmittingByMessageId: Record<string, boolean>;
  interruptErrorByMessageId: Record<string, string>;
  chatMessage: string;
  chatAttachments: File[];
  showPaper2SlidesControls: boolean;
  presentationStatus: 'idle' | 'running' | 'success' | 'error';
  presentationOptionSummary: string;
  isMentionOpen: boolean;
  mentionSuggestions: WorkspaceFile[];
  mentionSelectedIndex: number;
  isCommandOpen: boolean;
  commandSuggestions: CommandSuggestion[];
  commandSelectedIndex: number;
  chatInputRef: RefObject<HTMLTextAreaElement | null>;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  workspaceId?: string;
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
  onToggleAgentPaneVisibility: () => void;
  onModeChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onToggleHistory: () => void;
  onNewChat: () => void;
  onToggleFullScreen: () => void;
  onCloseHistory: () => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onToggleThinkingVisibility: (messageId: ConversationMessage['id']) => void;
  onToggleToolActivityVisibility: (messageId: ConversationMessage['id']) => void;
  onCopyMessageText: (message: ConversationMessage) => void;
  onRerunMessage: (messageId: ConversationMessage['id']) => void;
  onInterruptAction: (
    message: ConversationMessage,
    action: RenderableInterruptAction,
    pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  ) => void;
  onChatInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onChatInputKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onChatInputKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onChatInputSelectionChange: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onChatAttachmentButtonClick: () => void;
  onInsertSlashTrigger: () => void;
  onOpenPresentationModal: () => void;
  onStopStreaming: () => void;
  onSendMessage: () => void;
  onChatAttachmentChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveChatAttachment: (index: number) => void;
  onSelectMention: (file: WorkspaceFile) => void;
  onSelectCommand: (command: CommandSuggestion) => void;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden bg-gradient-to-b from-white to-slate-50" style={agentPaneStyles}>
      <style>{`@keyframes chat-pane-message-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      <ChatHeader
        isAgentPaneVisible={isAgentPaneVisible}
        isEditMode={isEditMode}
        isHistoryOpen={isHistoryOpen}
        isAgentPaneFullScreen={isAgentPaneFullScreen}
        personas={personas}
        selectedPersona={selectedPersona}
        onToggleVisibility={onToggleAgentPaneVisibility}
        onModeChange={onModeChange}
        onToggleHistory={onToggleHistory}
        onNewChat={onNewChat}
        onToggleFullScreen={onToggleFullScreen}
      />
      <div
        className={`relative flex min-h-0 flex-1 flex-col overflow-hidden ${
          isAgentPaneFullScreen || isAgentPaneVisible ? 'block' : 'hidden'
        }`}
      >
        <ChatHistoryPanel
          isHistoryOpen={isHistoryOpen}
          conversationHistory={conversationHistory}
          activeConversationId={activeConversationId}
          conversationStreaming={conversationStreaming}
          personas={personas}
          onClose={onCloseHistory}
          onSelectConversation={onSelectConversation}
          onDeleteConversation={onDeleteConversation}
        />
        <ChatMessageList
          messages={messages}
          isStreaming={isStreaming}
          personaDisplayName={personaDisplayName}
          messageBubbleMaxWidth={messageBubbleMaxWidth}
          markdownComponents={markdownComponents}
          expandedToolMessages={expandedToolMessages}
          expandedThinkingMessages={expandedThinkingMessages}
          copiedMessageId={copiedMessageId}
          interruptInputByMessageId={interruptInputByMessageId}
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
          toggleThinkingVisibility={onToggleThinkingVisibility}
          toggleToolActivityVisibility={onToggleToolActivityVisibility}
          handleCopyMessageText={onCopyMessageText}
          handleRerunMessage={onRerunMessage}
          handleInterruptAction={onInterruptAction}
          workspaceId={workspaceId}
        />
        <ChatInputArea
          chatMessage={chatMessage}
          chatAttachments={chatAttachments}
          chatInputRef={chatInputRef}
          attachmentInputRef={attachmentInputRef}
          isStreaming={isStreaming}
          showPaper2SlidesControls={showPaper2SlidesControls}
          presentationStatus={presentationStatus}
          presentationOptionSummary={presentationOptionSummary}
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
          onChatAttachmentButtonClick={onChatAttachmentButtonClick}
          onInsertSlashTrigger={onInsertSlashTrigger}
          onOpenPresentationModal={onOpenPresentationModal}
          onStopStreaming={onStopStreaming}
          onSendMessage={onSendMessage}
          onChatAttachmentChange={onChatAttachmentChange}
          onRemoveChatAttachment={onRemoveChatAttachment}
          onSelectMention={onSelectMention}
          onSelectCommand={onSelectCommand}
        />
      </div>
    </div>
  );
}

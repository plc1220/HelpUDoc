import { FileIcon, MonitorPlay, Plus, Send, StopCircle, X } from 'lucide-react';
import { type ChangeEvent, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';

import type { File as WorkspaceFile } from '../../types';

type CommandSuggestion = {
  id: string;
  command: string;
  description: string;
};

export default function ChatInputArea({
  chatMessage,
  chatAttachments,
  chatInputRef,
  attachmentInputRef,
  isStreaming,
  showPaper2SlidesControls,
  presentationStatus,
  presentationOptionSummary,
  isMentionOpen,
  mentionSuggestions,
  mentionSelectedIndex,
  isCommandOpen,
  commandSuggestions,
  commandSelectedIndex,
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
  chatMessage: string;
  chatAttachments: File[];
  chatInputRef: RefObject<HTMLTextAreaElement | null>;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  isStreaming: boolean;
  showPaper2SlidesControls: boolean;
  presentationStatus: 'idle' | 'running' | 'success' | 'error';
  presentationOptionSummary: string;
  isMentionOpen: boolean;
  mentionSuggestions: WorkspaceFile[];
  mentionSelectedIndex: number;
  isCommandOpen: boolean;
  commandSuggestions: CommandSuggestion[];
  commandSelectedIndex: number;
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
    <div className="sticky bottom-0 border-t border-slate-200/80 bg-white/80 p-4 backdrop-blur-md">
      <div className="relative rounded-2xl border border-slate-200/90 bg-white/80 shadow-[0_16px_40px_-28px_rgba(15,23,42,0.9)] transition-all duration-200 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-200">
        {chatAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {chatAttachments.map((file, index) => (
              <div
                key={`${file.name}-${index}`}
                className="group flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 transition-all duration-200"
              >
                <span className="max-w-[120px] truncate">{file.name}</span>
                <button
                  type="button"
                  className="text-slate-400 transition-all duration-200 hover:text-red-500"
                  onClick={() => onRemoveChatAttachment(index)}
                  aria-label={`Remove ${file.name}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          placeholder="Interact with the agent... (Type / for commands)"
          value={chatMessage}
          ref={chatInputRef}
          onChange={onChatInputChange}
          onKeyDown={onChatInputKeyDown}
          onKeyUp={onChatInputKeyUp}
          onSelect={onChatInputSelectionChange}
          className="w-full max-h-60 resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none"
          rows={Math.min(5, Math.max(1, chatMessage.split('\n').length))}
          style={{ minHeight: '56px' }}
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onChatAttachmentButtonClick}
              className="rounded-lg p-2 text-slate-500 transition-all duration-200 hover:bg-slate-100 hover:text-slate-700"
              title="Attach files"
            >
              <Plus size={18} />
            </button>
            <button
              type="button"
              onClick={onInsertSlashTrigger}
              className="rounded-lg p-2 text-slate-500 transition-all duration-200 hover:bg-slate-100 hover:text-slate-700"
              title="Commands"
              aria-label="Insert command"
            >
              <span className="text-xs font-semibold">/</span>
            </button>
            {showPaper2SlidesControls && (
              <>
                <div className="mx-1 h-4 w-px bg-slate-200" aria-hidden="true" />
                <button
                  type="button"
                  onClick={onOpenPresentationModal}
                  className={`rounded-lg p-2 transition-all duration-200 ${
                    presentationStatus === 'running'
                      ? 'bg-blue-50 text-blue-600 ring-1 ring-blue-200'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-blue-600'
                  }`}
                  title={`Configure Paper2Slides: ${presentationOptionSummary || 'Options'}`}
                  aria-label="Configure Paper2Slides"
                >
                  <MonitorPlay size={18} />
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="mr-2 hidden text-[10px] text-slate-400 sm:inline-block">
              {isStreaming ? 'Generating...' : 'Enter to send'}
            </span>
            <button
              onClick={isStreaming ? onStopStreaming : onSendMessage}
              disabled={!chatMessage.trim() && !chatAttachments.length && !isStreaming}
              className={`rounded-xl p-2 transition-all duration-200 ${
                !chatMessage.trim() && !chatAttachments.length && !isStreaming
                  ? 'cursor-not-allowed bg-slate-100 text-slate-400'
                  : isStreaming
                    ? 'bg-red-50 text-red-600 hover:bg-red-100'
                    : 'bg-blue-600 text-white shadow-sm hover:bg-blue-700'
              }`}
              title={isStreaming ? 'Stop current agent response' : 'Send message'}
            >
              {isStreaming ? <StopCircle size={18} /> : <Send size={18} />}
            </button>
          </div>
        </div>
        <input
          type="file"
          ref={attachmentInputRef}
          className="hidden"
          multiple
          accept="image/*,.pdf,.md,.txt,.doc,.docx"
          onChange={onChatAttachmentChange}
        />
        {isMentionOpen && (
          <div className="absolute bottom-full left-0 z-20 mb-2 max-h-48 w-64 overflow-y-auto rounded-lg border border-slate-200 bg-white/90 shadow-xl backdrop-blur-md">
            {mentionSuggestions.length ? (
              mentionSuggestions.map((file, index) => (
                <button
                  key={file.id}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelectMention(file);
                  }}
                  className={`flex w-full items-center px-3 py-2 text-left text-xs transition-all duration-200 ${
                    index === mentionSelectedIndex
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <FileIcon size={16} className="mr-2 text-slate-500" />
                  <span className="truncate">{file.name}</span>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-xs text-slate-500">No matching files</div>
            )}
          </div>
        )}
        {isCommandOpen && (
          <div className="absolute bottom-full left-0 z-20 mb-2 max-h-48 w-72 overflow-y-auto rounded-lg border border-slate-200 bg-white/90 shadow-xl backdrop-blur-md">
            {commandSuggestions.length ? (
              commandSuggestions.map((command, index) => (
                <button
                  key={command.id}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelectCommand(command);
                  }}
                  className={`w-full px-3 py-2 text-left text-xs transition-all duration-200 ${
                    index === commandSelectedIndex
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex flex-col">
                    <span className="font-semibold">{command.command}</span>
                    <span className="text-[11px] text-slate-500">{command.description}</span>
                  </div>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-xs text-slate-500">No matching commands</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

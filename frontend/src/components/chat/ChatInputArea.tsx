import { FileIcon, MonitorPlay, Plus, Send, StopCircle, X } from 'lucide-react';
import { type ChangeEvent, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';

import type { File as WorkspaceFile } from '../../types';

type CommandSuggestion = {
  id: string;
  command: string;
  description: string;
};

type CommandTag = {
  id: string;
  label: string;
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
  commandTags,
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
  onRemoveCommandTag,
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
  commandTags: CommandTag[];
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
  onRemoveCommandTag: (tagId: string) => void;
  onSelectMention: (file: WorkspaceFile) => void;
  onSelectCommand: (command: CommandSuggestion) => void;
}) {
  return (
    <div className="sticky bottom-0 border-t border-slate-700/70 bg-slate-950/45 p-4 backdrop-blur-md">
      <div className="relative rounded-2xl border border-slate-700/80 bg-slate-900/80 shadow-[0_24px_60px_-36px_rgba(15,23,42,0.98)] transition-all duration-200 focus-within:border-sky-400/70 focus-within:ring-2 focus-within:ring-sky-400/15">
        {chatAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {chatAttachments.map((file, index) => (
              <div
                key={`${file.name}-${index}`}
                className="group flex items-center gap-2 rounded-lg border border-slate-700/70 bg-slate-950/70 px-2 py-1 text-xs font-medium text-slate-200 transition-all duration-200"
              >
                <span className="max-w-[120px] truncate">{file.name}</span>
                <button
                  type="button"
                  className="text-slate-500 transition-all duration-200 hover:text-rose-400"
                  onClick={() => onRemoveChatAttachment(index)}
                  aria-label={`Remove ${file.name}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {commandTags.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {commandTags.map((tag) => (
              <div
                key={tag.id}
                className="group flex items-center gap-2 rounded-full border border-sky-400/25 bg-slate-950/75 px-2.5 py-1 text-xs font-medium text-sky-100"
              >
                <span>{tag.label}</span>
                <button
                  type="button"
                  className="text-sky-200/60 transition-all duration-200 hover:text-rose-300"
                  onClick={() => onRemoveCommandTag(tag.id)}
                  aria-label={`Remove ${tag.label}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          placeholder="Interact with the agent... (Type / for commands, skills, and MCP servers)"
          value={chatMessage}
          ref={chatInputRef}
          onChange={onChatInputChange}
          onKeyDown={onChatInputKeyDown}
          onKeyUp={onChatInputKeyUp}
          onSelect={onChatInputSelectionChange}
          className="w-full max-h-60 resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-slate-100 placeholder:text-slate-500 focus:outline-none"
          rows={Math.min(5, Math.max(1, chatMessage.split('\n').length))}
          style={{ minHeight: '56px' }}
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onChatAttachmentButtonClick}
              className="rounded-lg p-2 text-slate-400 transition-all duration-200 hover:bg-slate-800 hover:text-slate-100"
              title="Attach files"
            >
              <Plus size={18} />
            </button>
            <button
              type="button"
              onClick={onInsertSlashTrigger}
              className="rounded-lg p-2 text-slate-400 transition-all duration-200 hover:bg-slate-800 hover:text-slate-100"
              title="Commands"
              aria-label="Insert command"
            >
              <span className="text-xs font-semibold">/</span>
            </button>
            {showPaper2SlidesControls && (
              <>
                <div className="mx-1 h-4 w-px bg-slate-700/80" aria-hidden="true" />
                <button
                  type="button"
                  onClick={onOpenPresentationModal}
                  className={`rounded-lg p-2 transition-all duration-200 ${
                    presentationStatus === 'running'
                      ? 'bg-sky-400/12 text-sky-100 ring-1 ring-sky-400/25'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-sky-200'
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
            <span className="mr-2 hidden text-[10px] text-slate-500 sm:inline-block">
              {isStreaming ? 'Generating...' : 'Enter to send'}
            </span>
            <button
              onClick={isStreaming ? onStopStreaming : onSendMessage}
              disabled={!chatMessage.trim() && !chatAttachments.length && !isStreaming}
              className={`rounded-xl p-2 transition-all duration-200 ${
                !chatMessage.trim() && !chatAttachments.length && !isStreaming
                  ? 'cursor-not-allowed bg-slate-800 text-slate-600'
                  : isStreaming
                    ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
                    : 'bg-[linear-gradient(135deg,rgba(56,189,248,0.92),rgba(59,130,246,0.9))] text-white shadow-[0_12px_30px_-16px_rgba(56,189,248,0.85)] hover:bg-[linear-gradient(135deg,rgba(103,232,249,0.95),rgba(96,165,250,0.92))]'
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
          <div className="absolute bottom-full left-0 z-20 mb-2 max-h-48 w-64 overflow-y-auto rounded-lg border border-slate-700/80 bg-slate-900/95 shadow-xl backdrop-blur-md">
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
                      ? 'bg-sky-500/15 text-sky-200'
                      : 'text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  <FileIcon size={16} className="mr-2 text-slate-500" />
                  <span className="truncate">{file.name}</span>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-xs text-slate-400">No matching files</div>
            )}
          </div>
        )}
        {isCommandOpen && (
          <div className="absolute bottom-full left-0 z-20 mb-2 max-h-48 w-72 overflow-y-auto rounded-lg border border-slate-700/80 bg-slate-900/95 shadow-xl backdrop-blur-md">
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
                      ? 'bg-sky-500/15 text-sky-200'
                      : 'text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  <div className="flex flex-col">
                    <span className="font-semibold">{command.command}</span>
                    <span className="text-[11px] text-slate-400">{command.description}</span>
                  </div>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-xs text-slate-400">No matching commands, skills, or MCP servers</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

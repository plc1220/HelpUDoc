import { FileIcon, MonitorPlay, Paperclip, Plus, Send, StopCircle, X } from 'lucide-react';
import { type ChangeEvent, type KeyboardEvent, type RefObject, type SyntheticEvent, useEffect, useRef, useState } from 'react';

import type { File as WorkspaceFile } from '../../types';
import type { ChatComposerAttachment } from './chatTypes';
import GoogleDriveIcon from './GoogleDriveIcon';

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
  colorMode,
  chatMessage,
  chatAttachments,
  chatInputRef,
  attachmentInputRef,
  isStreaming,
  isPreparingAttachments,
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
  onOpenLocalAttachmentPicker,
  onOpenDrivePicker,
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
  colorMode: 'light' | 'dark';
  chatMessage: string;
  chatAttachments: ChatComposerAttachment[];
  chatInputRef: RefObject<HTMLTextAreaElement | null>;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  isStreaming: boolean;
  isPreparingAttachments: boolean;
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
  onOpenLocalAttachmentPicker: () => void;
  onOpenDrivePicker: () => void;
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
  const isDarkMode = colorMode === 'dark';
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isAttachmentMenuOpen) {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (attachmentMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsAttachmentMenuOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isAttachmentMenuOpen]);

  return (
    <div className={`sticky bottom-0 border-t p-3 backdrop-blur-md ${
      isDarkMode ? 'border-slate-700/70 bg-slate-950/45' : 'border-slate-200/80 bg-white/80'
    }`}>
      <div className={`relative rounded-2xl border transition-all duration-200 ${
        isDarkMode
          ? 'border-slate-700/80 bg-slate-900/80 shadow-[0_24px_60px_-36px_rgba(15,23,42,0.98)] focus-within:border-sky-400/70 focus-within:ring-2 focus-within:ring-sky-400/15'
          : 'border-slate-200/90 bg-white shadow-[0_24px_60px_-36px_rgba(15,23,42,0.15)] focus-within:border-sky-400/70 focus-within:ring-2 focus-within:ring-sky-200/50'
      }`}>
        {chatAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2.5">
            {chatAttachments.map((file, index) => (
              <div
                key={file.id}
                className={`group flex items-center gap-2 rounded-lg border px-2 py-1 text-xs font-medium transition-all duration-200 ${
                  isDarkMode ? 'border-slate-700/70 bg-slate-950/70 text-slate-200' : 'border-slate-200 bg-slate-50 text-slate-700'
                }`}
              >
                {file.source === 'drive' ? (
                  <GoogleDriveIcon className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <Paperclip size={12} className={isDarkMode ? 'text-slate-400' : 'text-slate-500'} />
                )}
                <span className="max-w-[120px] truncate">{file.name}</span>
                <button
                  type="button"
                  className={`transition-all duration-200 ${
                    isDarkMode ? 'text-slate-500 hover:text-rose-400' : 'text-slate-400 hover:text-rose-500'
                  }`}
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
          <div className="flex flex-wrap gap-2 px-3 pt-2.5">
            {commandTags.map((tag) => (
              <div
                key={tag.id}
                className={`group flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  isDarkMode
                    ? 'border-sky-400/25 bg-slate-950/75 text-sky-100'
                    : 'border-sky-200 bg-sky-50 text-sky-700'
                }`}
              >
                <span>{tag.label}</span>
                <button
                  type="button"
                  className={`transition-all duration-200 ${
                    isDarkMode ? 'text-sky-200/60 hover:text-rose-300' : 'text-sky-400 hover:text-rose-500'
                  }`}
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
          className={`w-full max-h-52 resize-none bg-transparent px-3.5 py-2.5 text-sm leading-relaxed focus:outline-none ${
            isDarkMode ? 'text-slate-100 placeholder:text-slate-500' : 'text-slate-800 placeholder:text-slate-400'
          }`}
          rows={Math.min(5, Math.max(1, chatMessage.split('\n').length))}
          style={{ minHeight: '50px' }}
        />
        <div className="flex items-center justify-between px-2 pb-1.5">
          <div className="flex items-center gap-1">
            <div className="relative" ref={attachmentMenuRef}>
              <button
                type="button"
                disabled={isPreparingAttachments}
                onClick={() => setIsAttachmentMenuOpen((prev) => !prev)}
                className={`rounded-lg p-2 transition-all duration-200 ${
                  isPreparingAttachments
                    ? isDarkMode
                      ? 'cursor-not-allowed text-slate-600'
                      : 'cursor-not-allowed text-slate-300'
                    : isDarkMode ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-100' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
                }`}
                title="Attach files"
              >
                <Plus size={18} />
              </button>
              {isAttachmentMenuOpen && (
                <div className={`absolute bottom-full left-0 z-30 mb-2 w-64 rounded-2xl border p-2 shadow-2xl backdrop-blur-md ${
                  isDarkMode ? 'border-slate-700/80 bg-slate-900/95' : 'border-slate-200 bg-white/95'
                }`}>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAttachmentMenuOpen(false);
                      onOpenLocalAttachmentPicker();
                    }}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium transition ${
                      isDarkMode ? 'text-slate-100 hover:bg-slate-800' : 'text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    <Paperclip size={18} />
                    <div className="flex flex-col">
                      <span>Upload files</span>
                      <span className={`text-[11px] font-normal ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                        Add files from this device
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAttachmentMenuOpen(false);
                      onOpenDrivePicker();
                    }}
                    className={`mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium transition ${
                      isDarkMode ? 'text-slate-100 hover:bg-slate-800' : 'text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    <GoogleDriveIcon className="h-[18px] w-[18px]" />
                    <div className="flex flex-col">
                      <span>Add from Google Drive</span>
                      <span className={`text-[11px] font-normal ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                        Search Drive or paste a file URL
                      </span>
                    </div>
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onInsertSlashTrigger}
              disabled={isPreparingAttachments}
              className={`rounded-lg p-2 transition-all duration-200 ${
                isPreparingAttachments
                  ? isDarkMode
                    ? 'cursor-not-allowed text-slate-600'
                    : 'cursor-not-allowed text-slate-300'
                  : isDarkMode ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-100' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
              }`}
              title="Commands"
              aria-label="Insert command"
            >
              <span className="text-xs font-semibold">/</span>
            </button>
            {showPaper2SlidesControls && (
              <>
                <div className={`mx-1 h-4 w-px ${isDarkMode ? 'bg-slate-700/80' : 'bg-slate-200'}`} aria-hidden="true" />
                <button
                  type="button"
                  onClick={onOpenPresentationModal}
                  className={`rounded-lg p-1.5 transition-all duration-200 ${
                    presentationStatus === 'running'
                      ? isDarkMode
                        ? 'bg-sky-400/12 text-sky-100 ring-1 ring-sky-400/25'
                        : 'bg-sky-50 text-sky-700 ring-1 ring-sky-200'
                      : isDarkMode
                        ? 'text-slate-400 hover:bg-slate-800 hover:text-sky-200'
                        : 'text-slate-500 hover:bg-slate-100 hover:text-sky-700'
                  }`}
                  title={`Configure Paper2Slides: ${presentationOptionSummary || 'Options'}`}
                  aria-label="Configure Paper2Slides"
                >
                  <MonitorPlay size={16} />
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className={`mr-2 hidden text-[10px] sm:inline-block ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
              {isStreaming ? 'Generating...' : isPreparingAttachments ? 'Preparing attachments...' : 'Enter to send'}
            </span>
            <button
              onClick={isStreaming ? onStopStreaming : onSendMessage}
              disabled={isPreparingAttachments || (!chatMessage.trim() && !chatAttachments.length && !isStreaming)}
              className={`rounded-xl p-2 transition-all duration-200 ${
                isPreparingAttachments || (!chatMessage.trim() && !chatAttachments.length && !isStreaming)
                  ? isDarkMode
                    ? 'cursor-not-allowed bg-slate-800 text-slate-600'
                    : 'cursor-not-allowed bg-slate-100 text-slate-300'
                  : isStreaming
                    ? isDarkMode
                      ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
                      : 'bg-rose-50 text-rose-600 hover:bg-rose-100'
                    : 'bg-[linear-gradient(135deg,rgba(56,189,248,0.92),rgba(59,130,246,0.9))] text-white shadow-[0_12px_30px_-16px_rgba(56,189,248,0.85)] hover:bg-[linear-gradient(135deg,rgba(103,232,249,0.95),rgba(96,165,250,0.92))]'
              }`}
              title={isStreaming ? 'Stop current agent response' : 'Send message'}
            >
              {isStreaming ? <StopCircle size={16} /> : <Send size={16} />}
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
          <div className={`absolute bottom-full left-0 z-20 mb-2 max-h-48 w-64 overflow-y-auto rounded-lg border shadow-xl backdrop-blur-md ${
            isDarkMode ? 'border-slate-700/80 bg-slate-900/95' : 'border-slate-200 bg-white/95'
          }`}>
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
                      ? isDarkMode
                        ? 'bg-sky-500/15 text-sky-200'
                        : 'bg-sky-50 text-sky-700'
                      : isDarkMode
                        ? 'text-slate-200 hover:bg-slate-800'
                        : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <FileIcon size={16} className={`mr-2 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`} />
                  <span className="truncate">{file.name}</span>
                </button>
              ))
            ) : (
              <div className={`px-3 py-2 text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>No matching files</div>
            )}
          </div>
        )}
        {isCommandOpen && (
          <div className={`absolute bottom-full left-0 z-20 mb-2 max-h-48 w-72 overflow-y-auto rounded-lg border shadow-xl backdrop-blur-md ${
            isDarkMode ? 'border-slate-700/80 bg-slate-900/95' : 'border-slate-200 bg-white/95'
          }`}>
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
                      ? isDarkMode
                        ? 'bg-sky-500/15 text-sky-200'
                        : 'bg-sky-50 text-sky-700'
                      : isDarkMode
                        ? 'text-slate-200 hover:bg-slate-800'
                        : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex flex-col">
                    <span className="font-semibold">{command.command}</span>
                    <span className={`text-[11px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{command.description}</span>
                  </div>
                </button>
              ))
            ) : (
              <div className={`px-3 py-2 text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>No matching commands, skills, or MCP servers</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

import {
  ChatComposer,
  ChatComposerDrawer,
  ChatSendButton,
} from '@astryxdesign/core/Chat';
import { Card } from '@astryxdesign/core/Card';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Item } from '@astryxdesign/core/Item';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { Token } from '@astryxdesign/core/Token';
import {
  BookOpen,
  Check,
  FileIcon,
  Globe2,
  Paperclip,
} from 'lucide-react';
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
  useEffect,
  useState,
} from 'react';

import type { ChatComposerAttachment } from './chatTypes';
import GoogleDriveIcon from './GoogleDriveIcon';
import type { AgentPersona } from '../../types';

const CHAT_INPUT_MIN_HEIGHT = 52;
const CHAT_INPUT_MAX_HEIGHT = 184;

type CommandSuggestion = {
  id: string;
  command: string;
  description: string;
};

type CommandTag = {
  id: string;
  label: string;
};

export type ChatMentionSuggestion = {
  id: string;
  kind: 'file' | 'knowledge' | 'knowledgeBase';
  name: string;
  mention: string;
  detail?: string;
};

export default function ChatInputArea({
  chatMessage,
  chatAttachments,
  placeholder = 'Ask anything…',
  chatInputRef,
  attachmentInputRef,
  isStreaming,
  isPreparingAttachments,
  personas,
  selectedPersona,
  internetSearchEnabled,
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
  onChatInputPaste,
  onOpenLocalAttachmentPicker,
  onModeChange,
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
}: {
  colorMode: 'light' | 'dark';
  chatMessage: string;
  chatAttachments: ChatComposerAttachment[];
  placeholder?: string;
  chatInputRef: RefObject<HTMLTextAreaElement | null>;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  isStreaming: boolean;
  isPreparingAttachments: boolean;
  personas: AgentPersona[];
  selectedPersona: string;
  internetSearchEnabled: boolean;
  commandTags: CommandTag[];
  isMentionOpen: boolean;
  mentionSuggestions: ChatMentionSuggestion[];
  mentionSelectedIndex: number;
  isCommandOpen: boolean;
  commandSuggestions: CommandSuggestion[];
  commandSelectedIndex: number;
  onChatInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onChatInputKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onChatInputKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onChatInputSelectionChange: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onChatInputPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onOpenLocalAttachmentPicker: () => void;
  onModeChange: (personaName: string) => void;
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
}) {
  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)');
    const sync = () => setIsNarrow(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const input = chatInputRef.current;
    if (!input) {
      return;
    }
    input.style.height = '0px';
    input.style.height = `${Math.min(
      CHAT_INPUT_MAX_HEIGHT,
      Math.max(CHAT_INPUT_MIN_HEIGHT, input.scrollHeight),
    )}px`;
  }, [chatInputRef, chatMessage]);

  const canSend = Boolean(chatMessage.trim() || chatAttachments.length);
  const attachmentCount = chatAttachments.length + commandTags.length;

  return (
    <div className="lumo-composer-dock">
      <div className="lumo-composer-wrap">
        <ChatComposer
          className="lumo-chat-composer"
          density={isNarrow ? 'compact' : 'balanced'}
          value={chatMessage}
          onChange={() => undefined}
          onSubmit={onSendMessage}
          onStop={onStopStreaming}
          isStopShown={isStreaming}
          isDisabled={isPreparingAttachments}
          placeholder={isNarrow ? 'Ask anything…' : placeholder}
          drawer={attachmentCount > 0 ? (
            <ChatComposerDrawer count={attachmentCount} label="Context" defaultIsCollapsed={false}>
              <div className="lumo-composer-tokens">
                {chatAttachments.map((attachment, index) => (
                  <Token
                    key={attachment.id}
                    label={attachment.name}
                    size="sm"
                    description={attachment.source === 'drive' ? 'Google Drive attachment' : 'Attached file'}
                    icon={attachment.source === 'drive'
                      ? <GoogleDriveIcon className="h-4 w-4" />
                      : <Icon icon={Paperclip} size="sm" />}
                    onRemove={() => onRemoveChatAttachment(index)}
                  />
                ))}
                {commandTags.map((tag) => (
                  <Token
                    key={tag.id}
                    label={tag.label}
                    size="sm"
                    color="blue"
                    onRemove={() => onRemoveCommandTag(tag.id)}
                  />
                ))}
              </div>
            </ChatComposerDrawer>
          ) : undefined}
          headerContext={isPreparingAttachments ? (
            <span className="lumo-composer-status" role="status" aria-live="polite">
              Preparing context…
            </span>
          ) : undefined}
          input={(
            <textarea
              ref={chatInputRef}
              className="lumo-composer-input"
              placeholder={isNarrow ? 'Ask anything…' : placeholder}
              value={chatMessage}
              rows={1}
              onChange={onChatInputChange}
              onKeyDown={onChatInputKeyDown}
              onKeyUp={onChatInputKeyUp}
              onSelect={onChatInputSelectionChange}
              onPaste={onChatInputPaste}
              aria-label="Message Lumo"
            />
          )}
          footerActions={(
            <div className="lumo-composer-footer-actions">
              <IconButton
                label="Attach files"
                tooltip="Attach files"
                variant="ghost"
                size="md"
                icon={<Icon icon={Paperclip} size="sm" />}
                onClick={onOpenLocalAttachmentPicker}
                isDisabled={isPreparingAttachments}
              />
              <IconButton
                label="Add context"
                tooltip="Add context (@)"
                variant="ghost"
                size="md"
                icon={<span className="lumo-composer-at">@</span>}
                onClick={onInsertKnowledgeTrigger}
                isDisabled={isPreparingAttachments}
              />
              <IconButton
                label="Commands"
                tooltip="Browse commands (/)"
                variant="ghost"
                size="md"
                icon={<span className="lumo-composer-slash">/</span>}
                onClick={onInsertSlashTrigger}
                isDisabled={isPreparingAttachments}
              />
            </div>
          )}
          sendActions={(
            <div className="lumo-composer-send-actions">
              <DropdownMenu
                placement="above"
                menuWidth={220}
                button={{
                  label: personas.find((persona) => persona.name === selectedPersona)?.displayName || selectedPersona,
                  variant: 'ghost',
                  size: 'md',
                  tooltip: 'Select agent mode',
                }}
                items={personas.map((persona) => ({
                  label: persona.displayName || persona.name,
                  icon: persona.name === selectedPersona ? <Icon icon={Check} size="sm" /> : undefined,
                  onClick: () => onModeChange(persona.name),
                }))}
              />
              <ToggleButton
                label={internetSearchEnabled ? 'Internet search on' : 'Internet search off'}
                tooltip={internetSearchEnabled ? 'Internet search on' : 'Internet search off'}
                size="md"
                isIconOnly
                isPressed={internetSearchEnabled}
                onPressedChange={onToggleInternetSearch}
                icon={<Icon icon={Globe2} size="sm" />}
                isDisabled={isPreparingAttachments}
              />
            </div>
          )}
          sendButton={(
            <ChatSendButton
              isStopShown={isStreaming}
              isDisabled={!isStreaming && (!canSend || isPreparingAttachments)}
              onSend={onSendMessage}
              onStop={onStopStreaming}
            />
          )}
        />

        <input
          type="file"
          ref={attachmentInputRef}
          className="hidden"
          multiple
          accept="image/*,.pdf,.md,.txt,.csv,.tsv,.docx,.xlsx,.xlsm"
          onChange={onChatAttachmentChange}
        />

        {isMentionOpen ? (
          <Card padding={1} className="lumo-composer-suggestions" role="listbox" aria-label="Files and knowledge">
            {mentionSuggestions.length ? mentionSuggestions.map((suggestion, index) => (
              <Item
                key={suggestion.id}
                density="compact"
                label={suggestion.name}
                description={suggestion.detail}
                startContent={<Icon icon={suggestion.kind === 'file' ? FileIcon : BookOpen} size="sm" />}
                isHighlighted={index === mentionSelectedIndex}
                onClick={() => onSelectMention(suggestion)}
              />
            )) : (
              <div className="lumo-composer-empty-suggestion">No matching files or knowledge</div>
            )}
          </Card>
        ) : null}

        {isCommandOpen ? (
          <Card padding={1} className="lumo-composer-suggestions lumo-composer-command-suggestions" role="listbox" aria-label="Commands">
            {commandSuggestions.length ? commandSuggestions.map((command, index) => (
              <Item
                key={command.id}
                density="compact"
                label={command.command}
                description={command.description}
                isHighlighted={index === commandSelectedIndex}
                onClick={() => onSelectCommand(command)}
              />
            )) : (
              <div className="lumo-composer-empty-suggestion">No matching commands, skills, or connections</div>
            )}
          </Card>
        ) : null}
      </div>
    </div>
  );
}

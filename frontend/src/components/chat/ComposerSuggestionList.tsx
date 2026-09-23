import { Card } from '@astryxdesign/core/Card';
import { Icon } from '@astryxdesign/core/Icon';
import { Item } from '@astryxdesign/core/Item';
import { BookOpen, FileIcon, UserRound } from 'lucide-react';

import type { ChatMentionSuggestion, CommandSuggestion } from './composerSuggestions';

/**
 * The `/` and `@` menus, lifted out of `ChatInputArea` so Shared Workspace Chat
 * renders the same rows in the same surface.
 *
 * Deliberately one component rather than a copy per composer: the two menus are
 * meant to look and behave identically, and a copy is how that stops being true.
 */

const mentionIcon = (kind: ChatMentionSuggestion['kind']) => {
  if (kind === 'file') return FileIcon;
  if (kind === 'person') return UserRound;
  return BookOpen;
};

export function MentionSuggestionList({
  suggestions,
  selectedIndex,
  onSelect,
  emptyLabel = 'No matching files or knowledge bases',
}: {
  suggestions: ChatMentionSuggestion[];
  selectedIndex: number;
  onSelect: (suggestion: ChatMentionSuggestion) => void;
  emptyLabel?: string;
}) {
  return (
    <Card padding={1} className="lumo-composer-suggestions" role="listbox" aria-label="Files and knowledge">
      {suggestions.length ? suggestions.map((suggestion, index) => (
        <Item
          key={suggestion.id}
          density="compact"
          label={suggestion.name}
          description={suggestion.detail}
          startContent={<Icon icon={mentionIcon(suggestion.kind)} size="sm" />}
          isHighlighted={index === selectedIndex}
          onClick={() => onSelect(suggestion)}
        />
      )) : (
        <div className="lumo-composer-empty-suggestion">{emptyLabel}</div>
      )}
    </Card>
  );
}

export function CommandSuggestionList({
  suggestions,
  selectedIndex,
  onSelect,
  emptyLabel = 'No matching commands, skills, or connections',
}: {
  suggestions: CommandSuggestion[];
  selectedIndex: number;
  onSelect: (suggestion: CommandSuggestion) => void;
  emptyLabel?: string;
}) {
  return (
    <Card
      padding={1}
      className="lumo-composer-suggestions lumo-composer-command-suggestions"
      role="listbox"
      aria-label="Commands"
    >
      {suggestions.length ? suggestions.map((command, index) => (
        <Item
          key={command.id}
          density="compact"
          label={command.command}
          description={command.description}
          isHighlighted={index === selectedIndex}
          onClick={() => onSelect(command)}
        />
      )) : (
        <div className="lumo-composer-empty-suggestion">{emptyLabel}</div>
      )}
    </Card>
  );
}

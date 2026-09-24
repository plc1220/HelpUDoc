import type { TeamChatReference } from '../../types';

export type ComposerToken = { start: number; end: number; reference: TeamChatReference };
export const composerQuery = (text: string, caret: number) => {
  const match = text.slice(0, caret).match(/(?:^|\s)([@/])([^@/\n]*)$/);
  if (!match) return null;
  return { trigger: match[1], query: match[2].toLowerCase(), start: caret - match[2].length - 1, end: caret };
};

// Retain identities only while the selected token remains untouched. Editing a
// display name must not silently keep notifying its former recipient.
export const reconcileTokens = (before: string, after: string, tokens: ComposerToken[]): ComposerToken[] => {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length;
  let nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  const delta = after.length - before.length;
  return tokens.flatMap((token) => {
    if (token.end <= start) return [token];
    if (token.start >= end) return [{ ...token, start: token.start + delta, end: token.end + delta }];
    return [];
  });
};

export const insertReference = (text: string, tokens: ComposerToken[], start: number, end: number, reference: TeamChatReference) => {
  const label = `${reference.kind === 'skill' ? '/' : '@'}${reference.label}`;
  const next = text.slice(0, start) + label + ' ' + text.slice(end);
  const delta = label.length + 1 - (end - start);
  const retained = tokens.flatMap((token) => {
    if (token.end <= start) return [token];
    if (token.start >= end) return [{ ...token, start: token.start + delta, end: token.end + delta }];
    return [];
  });
  return { text: next, caret: start + label.length + 1, tokens: [...retained, { start, end: start + label.length, reference }] };
};

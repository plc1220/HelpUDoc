/**
 * Suggestion data for the `/` and `@` composer menus.
 *
 * Shared by the private composer and Shared Workspace Chat so both offer the same
 * rows, ranked the same way. It lived inside `WorkspacePage` while only one
 * composer needed it; a second copy would have let the two menus drift apart,
 * which is the whole point of the shared channel matching private chat.
 */
import { SLASH_COMMANDS } from '../../constants/workspace';

export type CommandSuggestion = {
  id: string;
  command: string;
  description: string;
  insertCommand?: string;
  category?: string;
};

export type RankedCommandSuggestion = {
  suggestion: CommandSuggestion;
  searchTerms: string[];
  boost?: number;
};

export type ChatMentionSuggestion = {
  id: string;
  kind: 'file' | 'knowledge' | 'knowledgeBase' | 'person';
  name: string;
  mention: string;
  detail?: string;
};

export type SuggestionFile = { id: number | string; name: string; mimeType?: string | null };
export type SuggestionKnowledgeBase = {
  id: string;
  name: string;
  status?: string;
  entitled?: boolean;
};
export type SuggestionSkill = {
  id: string;
  name?: string;
  description?: string;
  pluginId?: string;
  pluginName?: string;
};
export type SuggestionPlugin = {
  id: string;
  displayName: string;
  description?: string;
  defaultSkillId: string;
};
export type SuggestionMcpServer = { name: string; description?: string };

export const normalizeSlashSearchText = (value: string) => value
  .toLowerCase()
  .replace(/^\/+/, '')
  .replace(/[_/.-]+/g, ' ')
  .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const slashSearchEditDistance = (left: string, right: string): number => {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
};

export const scoreSlashSearchCandidate = (query: string, terms: string[]): number | null => {
  const normalizedQuery = normalizeSlashSearchText(query);
  if (!normalizedQuery) return 0;
  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  const normalizedTerms = terms.map(normalizeSlashSearchText).filter(Boolean);
  const words = normalizedTerms.flatMap((term) => term.split(' ').filter(Boolean));
  let score = 0;

  for (const queryToken of queryTokens) {
    let tokenScore = 0;
    for (const word of words) {
      if (word === queryToken) {
        tokenScore = Math.max(tokenScore, 160);
      } else if (word.startsWith(queryToken)) {
        tokenScore = Math.max(tokenScore, 130 - Math.min(30, word.length - queryToken.length));
      } else if (queryToken.length >= 2 && word.includes(queryToken)) {
        tokenScore = Math.max(tokenScore, 85);
      } else if (queryToken.length >= 3) {
        const distance = slashSearchEditDistance(queryToken, word);
        const allowedDistance = Math.max(1, Math.floor(queryToken.length * 0.3));
        if (distance <= allowedDistance) {
          tokenScore = Math.max(tokenScore, 65 - distance * 10);
        }
      }
    }
    if (!tokenScore) return null;
    score += tokenScore;
  }

  for (const term of normalizedTerms) {
    if (term === normalizedQuery) score += 500;
    else if (term.startsWith(normalizedQuery)) score += 300;
    else if (normalizedQuery.length >= 2 && term.includes(normalizedQuery)) score += 180;
  }
  return score;
};

// Ranking decides the order; it no longer decides how much the reader may see.
// A cap here dropped matching skills a user was entitled to, with nothing in
// the UI to say more existed.
export const rankSlashSearchCandidates = (
  query: string,
  candidates: RankedCommandSuggestion[],
): CommandSuggestion[] => candidates
  .map((candidate, index) => ({
    ...candidate,
    index,
    score: scoreSlashSearchCandidate(query, candidate.searchTerms),
  }))
  .filter((candidate): candidate is typeof candidate & { score: number } => candidate.score !== null)
  .sort((left, right) => (right.score + (right.boost || 0)) - (left.score + (left.boost || 0)) || left.index - right.index)
  .map(({ suggestion }) => suggestion);

export const getCommandCategory = (command: CommandSuggestion) => {
  if (command.category) {
    return command.category;
  }
  if (command.command.startsWith('/skill')) {
    return 'Skills';
  }
  if (command.command.startsWith('/mcp')) {
    return 'Data Sources';
  }
  return 'Automation';
};


export const humanizeEntityName = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed) || !/[-_/]/.test(trimmed)) return trimmed;
  return trimmed
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

export const toSkillSuggestion = (skill: SuggestionSkill): CommandSuggestion => ({
  id: `skill:${skill.id}`,
  command: humanizeEntityName(skill.name || skill.id),
  insertCommand: `/skill ${skill.id}`,
  description: skill.description
    ? `/skill ${skill.id} \u00b7 ${skill.description}`
    : `Use the ${skill.name || skill.id} skill`,
  category: 'Skills',
});

export const toMcpSuggestion = (server: SuggestionMcpServer): CommandSuggestion => ({
  id: `mcp:${server.name}`,
  command: server.name,
  insertCommand: `/mcp ${server.name}`,
  description: server.description
    ? `/mcp ${server.name} \u00b7 ${server.description}`
    : `Prefer tools from ${server.name}`,
  category: 'Data Sources',
});

export const toPluginSuggestion = (plugin: SuggestionPlugin): CommandSuggestion => ({
  id: `plugin:${plugin.id}`,
  command: plugin.displayName,
  insertCommand: `/skill ${plugin.defaultSkillId}`,
  description: plugin.description || `Use the ${plugin.displayName} plugin`,
  category: 'Plugins',
});

/** Files and knowledge bases for the `@` menu. */
export const buildMentionSuggestions = ({
  query,
  files,
  knowledgeBases,
}: {
  query: string;
  files: SuggestionFile[];
  knowledgeBases: SuggestionKnowledgeBase[];
}): ChatMentionSuggestion[] => {
  const normalized = query.trim().toLowerCase();
  const kbOnly = normalized.startsWith('kb:');
  const searchTerm = kbOnly ? normalized.slice('kb:'.length).trimStart() : normalized;
  const fileSuggestions: ChatMentionSuggestion[] = kbOnly
    ? []
    : files
        .filter((file) => !searchTerm || file.name.toLowerCase().includes(searchTerm))
        .map((file) => ({
          id: `file:${file.id}`,
          kind: 'file' as const,
          name: file.name,
          mention: `@${file.name}`,
          detail: file.mimeType?.split('/').pop() || file.name.split('.').pop() || 'file',
        }));
  // Documents are surfaced only through knowledge bases; individual sources
  // are no longer taggable. Bases use a "kb:" prefix + human-readable name.
  const knowledgeBaseSuggestions: ChatMentionSuggestion[] = knowledgeBases
    .filter((kb) => kb.status === 'published')
    // This picker reads the default `entitled` catalogue scope, so every row is already
    // usable. Checked anyway: if a caller ever switches this to the discovery scope,
    // offering a base the agent will refuse is worse than not offering it.
    .filter((kb) => kb.entitled !== false)
    .filter((kb) => !searchTerm || kb.name.toLowerCase().includes(searchTerm))
    .map((kb) => ({
      id: `kb:${kb.id}`,
      kind: 'knowledgeBase' as const,
      name: kb.name,
      mention: `@kb:${kb.name}`,
      // Shows the prefix the row actually inserts. "knowledge base" described a
      // tagging form that no longer exists, so it named nothing the reader
      // could type.
      detail: 'kb:',
    }));
  // Every file and knowledge base the person may use, not a sample of them.
  // The list scrolls, so a short cap only hid entitlements from whoever had
  // the most of them.
  return [...knowledgeBaseSuggestions, ...fileSuggestions];
};

/**
 * Skills, plugins and connections for the `/` menu.
 *
 * `mcpServers` is empty for Shared Workspace Chat: that channel denies every
 * configured server, so offering one would bind a run to tools it cannot reach.
 */
export const buildCommandSuggestions = ({
  query,
  skills,
  plugins,
  mcpServers,
}: {
  query: string;
  skills: SuggestionSkill[];
  plugins: SuggestionPlugin[];
  mcpServers: SuggestionMcpServer[];
}): CommandSuggestion[] => {
  const rawQuery = query.toLowerCase();
  const normalized = rawQuery.trim();
  if (!normalized) {
    // Opening the menu lists everything granted to this user. Grouping by
    // category keeps it readable, so there is no reason to truncate it.
    return [
      ...SLASH_COMMANDS.map((command) => ({ ...command })),
      ...plugins.map(toPluginSuggestion),
      ...skills.map(toSkillSuggestion),
      ...mcpServers.map(toMcpSuggestion),
    ];
  }
  const pluginMatch = rawQuery.match(/^plugin(?:\s+(.*))?$/);
  if (pluginMatch) {
    const filter = (pluginMatch[1] || '').trim();
    return plugins
      .filter((plugin) => !filter
        || plugin.id.toLowerCase().includes(filter)
        || plugin.displayName.toLowerCase().includes(filter)
        || (plugin.description || '').toLowerCase().includes(filter))
      .map(toPluginSuggestion);
  }
  const skillMatch = rawQuery.match(/^skill(?:\s+(.*))?$/);
  if (skillMatch) {
    const filter = (skillMatch[1] || '').trim();
    return skills
      .filter((skill) => !filter
        || skill.id.toLowerCase().includes(filter)
        || (skill.name || '').toLowerCase().includes(filter))
      .map(toSkillSuggestion);
  }
  const mcpMatch = rawQuery.match(/^mcp(?:\s+(.*))?$/);
  if (mcpMatch) {
    const filter = (mcpMatch[1] || '').trim();
    return mcpServers
      .filter((server) => !filter || server.name.toLowerCase().includes(filter))
      .map(toMcpSuggestion);
  }
  const candidates: RankedCommandSuggestion[] = [
    ...SLASH_COMMANDS.map((command) => ({
      suggestion: { ...command },
      searchTerms: [command.command, command.description, command.id, 'command automation'],
    })),
    ...plugins.map((plugin) => ({
      suggestion: toPluginSuggestion(plugin),
      boost: 30,
      searchTerms: [
        plugin.id,
        plugin.displayName,
        plugin.description || '',
        plugin.defaultSkillId,
        'plugin',
      ],
    })),
    ...skills.map((skill) => ({
      suggestion: toSkillSuggestion(skill),
      boost: 60,
      searchTerms: [
        skill.id,
        skill.name || '',
        skill.description || '',
        skill.pluginId || '',
        skill.pluginName || '',
        'skill workflow',
      ],
    })),
    ...mcpServers.map((server) => ({
      suggestion: toMcpSuggestion(server),
      boost: 30,
      searchTerms: [server.name, server.description || '', 'mcp data source connection'],
    })),
  ];
  return rankSlashSearchCandidates(normalized, candidates);
};

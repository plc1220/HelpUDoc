export type KnowledgeScopeRef = {
  id: number;
  title: string;
  /** Set when the ref came from a tagged knowledge base, not a tagged document. */
  knowledgeBaseName?: string | null;
  knowledgeBaseVersion?: string | null;
};

const bundleLine = (ref: KnowledgeScopeRef, indent = '') =>
  `${indent}- ${ref.title} (knowledge://${ref.id}/index.md)`;

/**
 * The prompt block that limits a turn to the Knowledge the user tagged.
 *
 * Documents from a tagged base are grouped under the base's name. A user names
 * the base ("What is in @kb:WAF Rules Test?"), but the agent used to see only
 * document titles, so it answered that no such base existed while holding every
 * document in it. Shared by private runs and Shared Workspace Chat, so both
 * describe the same scope the same way.
 */
export function formatKnowledgeScopeGuidance(refs: KnowledgeScopeRef[]): string {
  const bases = new Map<string, { version: string | null; refs: KnowledgeScopeRef[] }>();
  const loose: KnowledgeScopeRef[] = [];
  for (const ref of refs) {
    const name = ref.knowledgeBaseName?.trim();
    if (!name) {
      loose.push(ref);
      continue;
    }
    const group = bases.get(name) || { version: ref.knowledgeBaseVersion?.trim() || null, refs: [] };
    group.refs.push(ref);
    bases.set(name, group);
  }
  const lines = ['Tagged Knowledge bundles (the only Knowledge scope for this turn):'];
  for (const [name, group] of bases) {
    const version = group.version ? ` (version ${group.version})` : '';
    lines.push(`- Knowledge base "${name}"${version}. When the user names this knowledge base, they mean these documents:`);
    lines.push(...group.refs.map((ref) => bundleLine(ref, '  ')));
  }
  if (loose.length) {
    if (bases.size) lines.push('- Individually tagged documents:');
    lines.push(...loose.map((ref) => bundleLine(ref, bases.size ? '  ' : '')));
  }
  lines.push('Use knowledge_read or knowledge_search only within these selected bundles.');
  return lines.join('\n');
}

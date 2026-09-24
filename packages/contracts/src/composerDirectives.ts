/**
 * How a composer message names a skill, an MCP server, or a knowledge base.
 *
 * Three implementations of this used to exist — the private composer, Shared
 * Chat, and the agent's own fallback — and all three anchored the directive to
 * the start of the message while the `/` menu that writes it opens at any
 * cursor position. So `@kb:General Knowledge /skill data/analyze` parsed as
 * plain prose: no chip, no directive block, and the agent reported `skill:
 * null`. `@` mentions never had that restriction, which is why the order of
 * tagging appeared to matter.
 *
 * One implementation now answers for the frontend and the backend. The agent
 * keeps its own copy in `helpudoc_agent/api/directives.py` because it is a
 * different language; `tests/test_directives.py` pins it to the same vectors as
 * `frontend/tests/composerDirectives.test.ts`.
 */

export type ComposerDirectiveKind = 'skill' | 'mcp';

export type ComposerDirective = {
  kind: ComposerDirectiveKind;
  /** The skill id or MCP server id the user picked. */
  id: string;
  /** Everything else the user wrote, with the directive span removed. */
  prompt: string;
  /** Where the `/skill …` span sits in the source text, so removal can splice. */
  start: number;
  end: number;
};

/**
 * The `/` must open the message or follow whitespace or an opening bracket, and
 * the word after it must be `skill` or `mcp`. That rejects `https://host/skill`
 * and `docs/skill notes`, where the slash follows a letter, while still
 * accepting the slash inside an id like `data/analyze`.
 *
 * The id stops at a closing bracket as well as at whitespace, the same boundary
 * an `@` mention uses, so `(/skill data/analyze)` names `data/analyze` rather
 * than `data/analyze)`.
 *
 * An immediately preceding `use` or `please use` is part of the match so it is
 * removed with it. People write "Please use /skill research …", and that lead-in
 * addresses the product, not the request; leaving it behind would hand the model
 * a sentence starting "Please use".
 *
 * Not anchored and not sticky: `exec` is used once per call, and the first
 * match wins because a turn carries one directive.
 */
const DIRECTIVE = /(?:^|[\s([{])(?:(?:please[ \t]+)?use[ \t]+)?\/(skill|mcp)[ \t]+([^\s)\]}]+)/i;

/** Collapse the gap left behind when a directive is spliced out of a sentence. */
const tidy = (value: string): string => value.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();

export const parseComposerDirective = (rawMessage: string): ComposerDirective | null => {
  const text = String(rawMessage || '');
  const match = DIRECTIVE.exec(text);
  if (!match || match.index === undefined) {
    return null;
  }
  const id = (match[2] || '').trim();
  if (!id) {
    return null;
  }
  // `match[0]` may begin with the separator that proved the boundary. Keep that
  // character: removing it would join the words either side of the directive.
  const leadingSeparator = /^[\s([{]/.test(match[0]) ? 1 : 0;
  const start = match.index + leadingSeparator;
  const end = match.index + match[0].length;
  const prompt = tidy(`${text.slice(0, start)}${text.slice(end)}`);
  return {
    kind: (match[1] || '').toLowerCase() === 'mcp' ? 'mcp' : 'skill',
    id,
    prompt,
    start,
    end,
  };
};

/** Remove a parsed directive from the text it came from, for the chip's ✕. */
export const removeComposerDirective = (rawMessage: string, directive: ComposerDirective): string => {
  const text = String(rawMessage || '');
  return tidy(`${text.slice(0, directive.start)}${text.slice(directive.end)}`);
};

/**
 * Knowledge bases a message tagged with `@kb:<name>`.
 *
 * A base name may contain spaces, so nothing in the text marks where the name
 * stops. Candidates are tested longest-first: without that, a base called
 * "General" would shadow "General Knowledge" and the wrong bundle would be
 * loaded. The frontend and Shared Chat used to answer this differently — one
 * matched exact names against its catalogue, the other took everything to the
 * end of the line and resolved it server-side — so the same message could
 * select different bases depending on where it was typed.
 */
export const findKnowledgeBaseMentions = <T extends { name: string }>(
  rawMessage: string,
  knowledgeBases: readonly T[],
): T[] => {
  const text = String(rawMessage || '');
  if (!text) {
    return [];
  }
  return [...knowledgeBases]
    .sort((left, right) => right.name.length - left.name.length)
    .filter((kb) => {
      const name = String(kb.name || '').trim();
      if (!name) {
        return false;
      }
      const pattern = new RegExp(
        `(^|[\\s([{])@kb:${escapeRegExp(name)}(?=$|[\\s)\\]}])`,
        'i',
      );
      return pattern.test(text);
    });
};

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

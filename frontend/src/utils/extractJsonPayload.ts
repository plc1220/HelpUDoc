/**
 * Pull the JSON value out of an assistant reply.
 *
 * A fenced-block regex cannot do this. The Skill Creator proposes a skill whose
 * `SKILL.md` documents how to run its own script, so the block it emits contains a
 * nested ```bash fence inside a JSON string. A non-greedy fence match ends at that
 * inner fence and yields truncated JSON; a greedy one breaks as soon as a reply carries
 * two blocks. Scanning for a balanced value while tracking string state is indifferent
 * to whatever the strings happen to contain.
 */
const skipString = (text: string, start: number): number => {
  // `start` is the opening quote. Returns the index just past the closing quote.
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  return text.length;
};

/** The balanced `{...}` or `[...]` beginning at `start`, or null if it never closes. */
const readBalancedValue = (text: string, start: number): string | null => {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = skipString(text, index);
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
    index += 1;
  }
  return null;
};

/**
 * Every JSON object or array in `text`, outermost first, last occurrence first.
 *
 * Later candidates win because a reply that revises an earlier proposal ends with the
 * one it means.
 */
export const extractJsonPayloads = (text: string): string[] => {
  const found: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = skipString(text, index);
      continue;
    }
    if (char === '{' || char === '[') {
      const value = readBalancedValue(text, index);
      if (value) {
        found.push(value);
        index += value.length;
        continue;
      }
    }
    index += 1;
  }
  return found.reverse();
};

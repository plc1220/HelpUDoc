const A2UI_ALLOWED_MESSAGE_KEYS = new Set([
  'beginRendering',
  'surfaceUpdate',
  'dataModelUpdate',
  'deleteSurface',
]);

export type A2uiPayloadResult = {
  payload: unknown;
  raw: string;
};

export const sanitizeJsonSource = (value: string) =>
  Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      if (code === 0xfeff) {
        return false;
      }
      if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
        return false;
      }
      return true;
    })
    .join('');

const parseJsonIfPossible = (value: string) => {
  if (!value) return null;
  try {
    return JSON.parse(sanitizeJsonSource(value));
  } catch {
    return null;
  }
};

export const normalizeA2uiPayload = (parsed: unknown): unknown => {
  if (typeof parsed === 'string') {
    const reparsed = parseJsonIfPossible(parsed);
    if (reparsed != null) {
      return normalizeA2uiPayload(reparsed);
    }
    return parsed;
  }
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    const nested = record.events ?? record.messages ?? record.a2ui;
    if (Array.isArray(nested)) {
      return nested;
    }
    const keys = Object.keys(record);
    if (keys.length === 1 && A2UI_ALLOWED_MESSAGE_KEYS.has(keys[0])) {
      return [record];
    }
  }
  return parsed;
};

export const parseJsonLines = (value: string) => {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const events: unknown[] = [];
  for (const line of lines) {
    const parsed = parseJsonIfPossible(line);
    if (!parsed) {
      return null;
    }
    events.push(parsed);
  }
  return events.length ? events : null;
};

const extractJsonSubstring = (value: string) => {
  const start = value.search(/[[{]/);
  if (start < 0) return null;
  const pairs: Record<string, string> = { '{': '}', '[': ']' };
  const openers = new Set(Object.keys(pairs));
  const closers = new Set(Object.values(pairs));
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (openers.has(ch)) {
      stack.push(ch);
      continue;
    }
    if (closers.has(ch)) {
      const last = stack.pop();
      if (!last || pairs[last] !== ch) {
        return null;
      }
      if (stack.length === 0) {
        return value.slice(start, i + 1);
      }
    }
  }
  return null;
};

const extractBracketedJson = (value: string) => {
  const start = value.indexOf('[');
  const end = value.lastIndexOf(']');
  if (start < 0 || end < 0 || end <= start) return null;
  return value.slice(start, end + 1);
};

export const extractA2uiPayload = (value: string): A2uiPayloadResult | null => {
  const trimmed = sanitizeJsonSource(value).trim();
  if (!trimmed) return null;

  const fenceMatch = trimmed.match(/```(?:json|a2ui|a2ui-json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    const candidate = fenceMatch[1].trim();
    const parsed = parseJsonIfPossible(candidate);
    if (parsed) {
      return { payload: normalizeA2uiPayload(parsed), raw: candidate };
    }
    const jsonLines = parseJsonLines(candidate);
    if (jsonLines) {
      return { payload: normalizeA2uiPayload(jsonLines), raw: candidate };
    }
  }

  const blockMatch = trimmed.match(/---BEGIN[^-]*---([\s\S]*?)---END[^-]*---/i);
  if (blockMatch?.[1]) {
    const candidate = blockMatch[1].trim();
    const parsed = parseJsonIfPossible(candidate);
    if (parsed) {
      return { payload: normalizeA2uiPayload(parsed), raw: candidate };
    }
    const jsonLines = parseJsonLines(candidate);
    if (jsonLines) {
      return { payload: normalizeA2uiPayload(jsonLines), raw: candidate };
    }
  }

  const directParsed = parseJsonIfPossible(trimmed);
  if (directParsed) {
    return { payload: normalizeA2uiPayload(directParsed), raw: trimmed };
  }
  const jsonLines = parseJsonLines(trimmed);
  if (jsonLines) {
    return { payload: normalizeA2uiPayload(jsonLines), raw: trimmed };
  }

  const substring = extractJsonSubstring(trimmed);
  const parsed = substring ? parseJsonIfPossible(substring) : null;
  if (parsed && substring) {
    return { payload: normalizeA2uiPayload(parsed), raw: substring };
  }
  const subJsonLines = substring ? parseJsonLines(substring) : null;
  if (subJsonLines && substring) {
    return { payload: normalizeA2uiPayload(subJsonLines), raw: substring };
  }

  const bracketed = extractBracketedJson(trimmed);
  const bracketParsed = bracketed ? parseJsonIfPossible(bracketed) : null;
  if (bracketParsed && bracketed) {
    return { payload: normalizeA2uiPayload(bracketParsed), raw: bracketed };
  }

  return null;
};

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN =
  /authorization|proxy-authorization|cookie|set-cookie|token|secret|password|api[-_]?key/i;
const SENSITIVE_COLUMN_PATTERN =
  /(?:^|_)(?:email|e_mail|phone|mobile|token|secret|password|passcode|api_key|apikey|authorization|cookie|card_number|credit_card|cvv|ssn|national_id|passport)(?:$|_)/i;

const redactDelimitedSensitiveColumns = (text: string): string => {
  const lines = text.split(/\r?\n/);
  let sensitiveIndexes: number[] = [];

  return lines.map((line) => {
    const numberedPrefix = line.match(/^(\s*\d+\s+)(.*)$/);
    const prefix = numberedPrefix?.[1] || '';
    const body = numberedPrefix?.[2] ?? line;
    if (!body.includes(',')) {
      return line;
    }

    const fields = body.split(',');
    if (!sensitiveIndexes.length) {
      const candidateIndexes = fields
        .map((field, index) => (SENSITIVE_COLUMN_PATTERN.test(field.trim()) ? index : -1))
        .filter((index) => index >= 0);
      if (candidateIndexes.length) {
        sensitiveIndexes = candidateIndexes;
      }
      return line;
    }

    if (fields.length <= Math.max(...sensitiveIndexes)) {
      return line;
    }
    for (const index of sensitiveIndexes) {
      fields[index] = REDACTED;
    }
    return `${prefix}${fields.join(',')}`;
  }).join('\n');
};

export const redactSensitiveText = (value: string): string => {
  let redacted = redactDelimitedSensitiveColumns(value);
  redacted = redacted
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\+\d[\d\s().-]{6,}\d/g, '[REDACTED_PHONE]')
    .replace(/\b(?:sk|pk|tok|api)[-_][A-Z0-9_-]{6,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\bBearer\s+[A-Z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(authorization|proxy-authorization|token|secret|password|api[-_]?key)\s*([:=])\s*([^\s,;]+)/gi,
      '$1$2[REDACTED]',
    );
  return redacted;
};

const scalar = (value: unknown): value is string | number | boolean | null =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const sanitizeValue = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown => {
  if (scalar(value) || value === undefined) {
    return typeof value === 'string' ? redactSensitiveText(value) : value;
  }
  if (depth <= 0) {
    return '[Truncated]';
  }
  if (value instanceof Error) {
    const record = value as Error & {
      code?: unknown;
      status?: unknown;
      response?: { status?: unknown };
      cause?: unknown;
    };
    return {
      name: record.name,
      message: record.message,
      stack: record.stack,
      ...(record.code !== undefined ? { code: sanitizeValue(record.code, depth - 1, seen) } : {}),
      ...(record.status !== undefined ? { status: sanitizeValue(record.status, depth - 1, seen) } : {}),
      ...(record.response?.status !== undefined
        ? { responseStatus: sanitizeValue(record.response.status, depth - 1, seen) }
        : {}),
      ...(record.cause !== undefined ? { cause: sanitizeValue(record.cause, depth - 1, seen) } : {}),
    };
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, depth - 1, seen));
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 50)) {
    sanitized[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED
      : sanitizeValue(nested, depth - 1, seen);
  }
  return sanitized;
};

export const safeErrorForLog = (error: unknown): unknown =>
  sanitizeValue(error, 5, new WeakSet<object>());

export const safeTelemetryForPersistence = (value: unknown): unknown =>
  sanitizeValue(value, 8, new WeakSet<object>());

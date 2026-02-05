import React, { useMemo } from 'react';
import { A2UIViewer } from '@copilotkit/a2ui-renderer';
import type { ComponentInstance } from '@copilotkit/a2ui-renderer';

interface A2UIRendererProps {
  payload: unknown;
  className?: string;
}

const ALLOWED_MESSAGE_KEYS = new Set([
  'beginRendering',
  'surfaceUpdate',
  'dataModelUpdate',
  'deleteSurface',
]);

const sanitizeJsonSource = (value: string) =>
  value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFEFF]/g, '');

const parseJsonLoose = (value: string): unknown | null => {
  try {
    return JSON.parse(sanitizeJsonSource(value));
  } catch {
    return null;
  }
};

const extractBracketedJson = (value: string) => {
  const start = value.indexOf('[');
  const end = value.lastIndexOf(']');
  if (start >= 0 && end > start) {
    return value.slice(start, end + 1);
  }
  return null;
};

const extractJsonObjects = (value: string) => {
  const results: string[] = [];
  const pairs: Record<string, string> = { '{': '}', '[': ']' };
  const openers = new Set(Object.keys(pairs));
  const closers = new Set(Object.values(pairs));
  let inString = false;
  let escape = false;
  let startIndex = -1;
  const stack: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
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
      if (stack.length === 0) {
        startIndex = i;
      }
      stack.push(ch);
      continue;
    }
    if (closers.has(ch)) {
      const last = stack.pop();
      if (!last || pairs[last] !== ch) {
        stack.length = 0;
        startIndex = -1;
        continue;
      }
      if (stack.length === 0 && startIndex >= 0) {
        results.push(value.slice(startIndex, i + 1));
        startIndex = -1;
      }
    }
  }
  return results;
};

const coerceMessages = (payload: unknown): { messages?: Array<Record<string, unknown>>; error?: string } => {
  if (payload == null) {
    return { error: 'No A2UI payload available.' };
  }

  let parsed: unknown = payload;
  if (typeof payload === 'string') {
    parsed = parseJsonLoose(payload);
    if (typeof parsed === 'string') {
      const innerParsed = parseJsonLoose(parsed);
      if (innerParsed != null) {
        parsed = innerParsed;
      }
    }
    if (parsed == null) {
      const bracketed = extractBracketedJson(payload);
      if (bracketed) {
        parsed = parseJsonLoose(bracketed);
      }
    }
    if (parsed == null) {
      const blocks = extractJsonObjects(payload);
      const parsedBlocks = blocks
        .map((block) => parseJsonLoose(block))
        .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object');
      if (parsedBlocks.length) {
        parsed = parsedBlocks;
      }
    }
    if (parsed == null) {
      console.error('Failed to parse A2UI payload string');
      return { error: 'A2UI payload is not valid JSON.' };
    }
  }

  if (!Array.isArray(parsed)) {
    return { error: 'A2UI payload must be a JSON array of events.' };
  }

  const messages: Array<Record<string, unknown>> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'Each A2UI event must be an object with a single key.' };
    }
    const keys = Object.keys(entry);
    if (keys.length !== 1) {
      return { error: 'Each A2UI event must have exactly one top-level key.' };
    }
    const key = keys[0];
    if (!ALLOWED_MESSAGE_KEYS.has(key)) {
      return { error: `Unsupported A2UI event type: ${key}.` };
    }
    messages.push(entry as Record<string, unknown>);
  }

  return { messages };
};

const getSurfaceId = (messages: Array<Record<string, unknown>>): string => {
  for (const message of messages) {
    const beginRendering = message.beginRendering as { surfaceId?: unknown } | undefined;
    if (beginRendering?.surfaceId && typeof beginRendering.surfaceId === 'string') {
      return beginRendering.surfaceId;
    }
  }
  for (const message of messages) {
    const surfaceUpdate = message.surfaceUpdate as { surfaceId?: unknown } | undefined;
    if (surfaceUpdate?.surfaceId && typeof surfaceUpdate.surfaceId === 'string') {
      return surfaceUpdate.surfaceId;
    }
    const dataModelUpdate = message.dataModelUpdate as { surfaceId?: unknown } | undefined;
    if (dataModelUpdate?.surfaceId && typeof dataModelUpdate.surfaceId === 'string') {
      return dataModelUpdate.surfaceId;
    }
  }
  return 'main';
};

const getRootId = (messages: Array<Record<string, unknown>>): string => {
  for (const message of messages) {
    const beginRendering = message.beginRendering as { root?: unknown } | undefined;
    if (beginRendering?.root && typeof beginRendering.root === 'string') {
      return beginRendering.root;
    }
  }
  return 'root';
};

const parseValueNode = (value: unknown): unknown => {
  if (value == null || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.valueString !== undefined) return record.valueString;
  if (record.valueInt !== undefined) return record.valueInt;
  if (record.valueFloat !== undefined) return record.valueFloat;
  if (record.valueBool !== undefined) return record.valueBool;
  if (record.literalString !== undefined) return record.literalString;
  if (record.literalNumber !== undefined) return record.literalNumber;
  if (record.literalBoolean !== undefined) return record.literalBoolean;
  if (Array.isArray(record.valueList)) {
    return record.valueList.map((entry) => parseValueNode(entry));
  }
  if (Array.isArray(record.valueMap)) {
    const next: Record<string, unknown> = {};
    record.valueMap.forEach((entry) => {
      if (entry && typeof entry === 'object') {
        const item = entry as Record<string, unknown>;
        const key = item.key;
        if (typeof key === 'string') {
          next[key] = parseValueNode(item);
        }
      }
    });
    return next;
  }
  if (record.map && typeof record.map === 'object') {
    const next: Record<string, unknown> = {};
    Object.entries(record.map as Record<string, unknown>).forEach(([key, entry]) => {
      next[key] = parseValueNode(entry);
    });
    return next;
  }
  return record;
};

const buildDataModel = (messages: Array<Record<string, unknown>>): Record<string, unknown> | undefined => {
  const dataModelUpdate = messages.find((message) => message.dataModelUpdate)?.dataModelUpdate as
    | Record<string, unknown>
    | undefined;
  if (!dataModelUpdate) return undefined;
  if (dataModelUpdate.dataModel && typeof dataModelUpdate.dataModel === 'object') {
    return dataModelUpdate.dataModel as Record<string, unknown>;
  }
  if (!Array.isArray(dataModelUpdate.contents)) {
    return undefined;
  }
  const next: Record<string, unknown> = {};
  dataModelUpdate.contents.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    const key = record.key;
    if (typeof key !== 'string') return;
    if (record.valueList !== undefined || record.valueMap !== undefined || record.map !== undefined) {
      next[key] = parseValueNode(record);
      return;
    }
    if (record.valueString !== undefined || record.valueInt !== undefined || record.valueFloat !== undefined) {
      next[key] = parseValueNode(record);
    }
  });
  return Object.keys(next).length ? next : undefined;
};

const getComponents = (
  messages: Array<Record<string, unknown>>,
  surfaceId: string,
): ComponentInstance[] | null => {
  for (const message of messages) {
    const surfaceUpdate = message.surfaceUpdate as { surfaceId?: unknown; components?: unknown } | undefined;
    if (!surfaceUpdate) continue;
    if (surfaceUpdate.surfaceId && surfaceUpdate.surfaceId !== surfaceId) continue;
    if (Array.isArray(surfaceUpdate.components)) {
      return surfaceUpdate.components as ComponentInstance[];
    }
  }
  return null;
};

const A2UIRenderer: React.FC<A2UIRendererProps> = ({ payload, className }) => {
  const { messages, error } = useMemo(() => coerceMessages(payload), [payload]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-red-600">
        {error}
      </div>
    );
  }

  if (!messages?.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-500">
        No A2UI events to render.
      </div>
    );
  }

  const surfaceId = getSurfaceId(messages);
  const root = getRootId(messages);
  const components = getComponents(messages, surfaceId);
  const data = buildDataModel(messages);

  if (!components) {
    return (
      <div className={`space-y-2 ${className || ''}`.trim()}>
        <div className="text-xs text-amber-600">
          Missing surfaceUpdate components; showing raw A2UI JSON instead.
        </div>
        <pre className="whitespace-pre-wrap break-words overflow-auto rounded-xl bg-white p-4 text-sm text-slate-800 shadow-sm">
          {JSON.stringify(messages, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <div className={`h-full w-full ${className || ''}`.trim()}>
      <A2UIViewer root={root} components={components} data={data} className="h-full w-full" />
    </div>
  );
};

export default A2UIRenderer;

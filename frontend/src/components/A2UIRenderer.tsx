import React, { useEffect, useMemo, useRef, useState } from 'react';

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

type LitStatus = 'loading' | 'ready' | 'unavailable';

type A2UISurfaceElement = HTMLElement & {
  messageProcessor?: unknown;
  surfaceId?: string;
};

const coerceMessages = (payload: unknown): { messages?: Array<Record<string, unknown>>; error?: string } => {
  if (payload == null) {
    return { error: 'No A2UI payload available.' };
  }

  let parsed: unknown = payload;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      console.error('Failed to parse A2UI payload string', error);
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

const DEFAULT_WEB_LIB_URL = 'https://esm.sh/@a2ui/web-lib@0.8.0';

const A2UIRenderer: React.FC<A2UIRendererProps> = ({ payload, className }) => {
  const { messages, error } = useMemo(() => coerceMessages(payload), [payload]);
  const [litStatus, setLitStatus] = useState<LitStatus>('loading');
  const [litError, setLitError] = useState<string | null>(null);
  const surfaceRef = useRef<A2UISurfaceElement | null>(null);
  const processorRef = useRef<null | { process?: (message: unknown) => void }>(null);
  const surfaceId = useMemo(() => (messages?.length ? getSurfaceId(messages) : 'main'), [messages]);

  useEffect(() => {
    let cancelled = false;
    const loadLit = async () => {
      try {
        const webLibUrl =
          import.meta.env.VITE_A2UI_WEB_LIB_URL?.trim() || DEFAULT_WEB_LIB_URL;
        const mod = (await import(
          /* @vite-ignore */
          webLibUrl
        )) as {
          MessageProcessor?: new () => { process?: (message: unknown) => void };
          default?: { MessageProcessor?: new () => { process?: (message: unknown) => void } };
        };
        const MessageProcessor = mod.MessageProcessor ?? mod.default?.MessageProcessor;
        if (!MessageProcessor) {
          throw new Error('Lit renderer is missing MessageProcessor.');
        }
        if (!cancelled) {
          processorRef.current = new MessageProcessor();
          setLitStatus('ready');
          setLitError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setLitStatus('unavailable');
          setLitError(
            loadError instanceof Error ? loadError.message : 'Lit renderer is unavailable.'
          );
        }
      }
    };
    loadLit();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (litStatus !== 'ready' || !messages?.length) {
      return;
    }
    const processor = processorRef.current;
    if (!processor || typeof processor.process !== 'function') {
      setLitStatus('unavailable');
      setLitError('Lit renderer does not expose a process method.');
      return;
    }
    const surface = surfaceRef.current;
    if (surface) {
      surface.messageProcessor = processor;
      surface.surfaceId = surfaceId;
    }
    messages.forEach((message) => processor.process?.(message));
  }, [litStatus, messages, surfaceId]);

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

  if (litStatus === 'ready') {
    return (
      <div className={`h-full w-full ${className || ''}`.trim()}>
        <a2ui-surface ref={surfaceRef} className="block h-full w-full" />
      </div>
    );
  }

  return (
    <div className={`space-y-2 ${className || ''}`.trim()}>
      {litError && (
        <div className="text-xs text-amber-600">
          Lit renderer unavailable; showing raw A2UI JSON instead. ({litError})
        </div>
      )}
      <pre className="whitespace-pre-wrap break-words overflow-auto rounded-xl bg-white p-4 text-sm text-slate-800 shadow-sm">
        {JSON.stringify(messages, null, 2)}
      </pre>
    </div>
  );
};

export default A2UIRenderer;

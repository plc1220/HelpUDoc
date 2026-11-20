/**
 * Bounds the tool output kept for display and telemetry.
 *
 * The agent sends each tool's whole output as the tool_end `content`, and it was stored
 * verbatim as the tool event `summary`: every read_file of a large document was copied
 * into the message metadata. One production conversation reached 86 MB of metadata (9 MB
 * per read_file event), and opening it ran the backend out of heap.
 *
 * Only stored copies are capped. The live run still sees the full output, because
 * workflow actions, skill proposals and knowledge chunks are parsed from it.
 */
export const TOOL_EVENT_SUMMARY_MAX_CHARS = 2000;
export const TOOL_EVENT_TRUNCATION_MARKER = '\n… [truncated]';

export function capToolEventText(value: string): string;
export function capToolEventText(value: unknown): unknown;
export function capToolEventText(value: unknown): unknown {
  if (typeof value !== 'string' || value.length <= TOOL_EVENT_SUMMARY_MAX_CHARS) {
    return value;
  }
  return value.slice(0, TOOL_EVENT_SUMMARY_MAX_CHARS) + TOOL_EVENT_TRUNCATION_MARKER;
}

/** Message metadata with every toolEvents[].summary capped. Returns the same object when nothing changes. */
export function capToolEventsInMetadata<T>(metadata: T): T {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return metadata;
  }
  const toolEvents = (metadata as Record<string, unknown>).toolEvents;
  if (!Array.isArray(toolEvents)) {
    return metadata;
  }
  let changed = false;
  const capped = toolEvents.map((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return event;
    }
    const summary = (event as Record<string, unknown>).summary;
    const next = capToolEventText(summary);
    if (next === summary) {
      return event;
    }
    changed = true;
    return { ...(event as Record<string, unknown>), summary: next };
  });
  return changed ? ({ ...(metadata as Record<string, unknown>), toolEvents: capped } as T) : metadata;
}

/** A tool event payload for telemetry with its `content` capped. */
export function capToolEventPayload<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const content = (payload as Record<string, unknown>).content;
  const next = capToolEventText(content);
  return next === content ? payload : ({ ...(payload as Record<string, unknown>), content: next } as T);
}

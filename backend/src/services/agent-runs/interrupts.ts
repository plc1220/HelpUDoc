import { createHash } from 'crypto';
import type { AgentInterruptResponse } from '../agentService';
import type { ResumePayload, RunPendingInterrupt } from './types';

const DEFAULT_RESUMED_RUN_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
export const RESUMED_RUN_IDLE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AGENT_RESUME_IDLE_TIMEOUT_MS || '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RESUMED_RUN_IDLE_TIMEOUT_MS;
})();

const stableNormalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = stableNormalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
};

const buildInterruptId = (payload: Record<string, unknown>): string => {
  const canonical = stableNormalize(
    Object.entries(payload).reduce<Record<string, unknown>>((acc, [key, value]) => {
      if (key !== 'interruptId' && key !== 'id') {
        acc[key] = value;
      }
      return acc;
    }, {}),
  );
  return `interrupt-${createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 20)}`;
};

export const normalizeInterruptPayloadRecord = (payload: Record<string, unknown>): Record<string, unknown> => {
  if (payload.type !== 'interrupt') {
    return payload;
  }
  const interruptId =
    typeof payload.interruptId === 'string' && payload.interruptId.trim()
      ? payload.interruptId.trim()
      : buildInterruptId(payload);
  if (payload.interruptId === interruptId) {
    return payload;
  }
  return {
    ...payload,
    interruptId,
  };
};

const hasStructuredAnswers = (value: unknown): value is Record<string, string | string[]> =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length,
  );

const hasClarificationResumeInput = (payload?: AgentInterruptResponse): boolean =>
  Boolean(
    payload?.message?.trim() ||
    payload?.selectedChoiceIds?.length ||
    payload?.selectedValues?.length ||
    hasStructuredAnswers(payload?.answersByQuestionId),
  );

const clarificationSignature = (value: Record<string, unknown> | RunPendingInterrupt | undefined): string => {
  if (!value) {
    return '';
  }
  const source = value as Record<string, unknown>;
  return JSON.stringify(
    stableNormalize({
      kind: source.kind,
      title: source.title,
      description: source.description,
      responseSpec: source.responseSpec,
      displayPayload: source.displayPayload,
      actions: source.actions,
      actionRequests: source.actionRequests,
      reviewConfigs: source.reviewConfigs,
    }),
  );
};

export const isRepeatedClarificationInterrupt = (
  payload: Record<string, unknown>,
  previousInterrupt?: RunPendingInterrupt,
  resumePayload?: ResumePayload,
): boolean => {
  if (!('response' in (resumePayload || {})) || !hasClarificationResumeInput(resumePayload?.response)) {
    return false;
  }
  if (previousInterrupt?.kind !== 'clarification' || payload.kind !== 'clarification') {
    return false;
  }
  const normalized = normalizeInterruptPayloadRecord(payload);
  if (previousInterrupt.interruptId && normalized.interruptId === previousInterrupt.interruptId) {
    return true;
  }
  return clarificationSignature(normalized) === clarificationSignature(previousInterrupt);
};

export const isRealRunProgressEvent = (parsed: Record<string, unknown> | null): boolean => {
  const type = typeof parsed?.type === 'string' ? parsed.type : '';
  return Boolean(type && type !== 'keepalive' && type !== 'policy' && type !== 'langfuse');
};

export const shouldFailResumedRunForIdle = (input: {
  resumePayload?: ResumePayload;
  sawInterruptPayload?: Record<string, unknown> | null;
  activeToolCalls: number;
  lastRealActivityAt: number;
  now: number;
  timeoutMs?: number;
}): boolean => {
  if (!input.resumePayload || input.sawInterruptPayload || input.activeToolCalls > 0) {
    return false;
  }
  const timeoutMs = input.timeoutMs ?? RESUMED_RUN_IDLE_TIMEOUT_MS;
  return timeoutMs > 0 && input.now - input.lastRealActivityAt >= timeoutMs;
};

export const parsePendingInterrupt = (raw: string | undefined): RunPendingInterrupt | undefined => {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  try {
    const parsed = normalizeInterruptPayloadRecord(JSON.parse(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const payload = parsed as Record<string, unknown>;
    return {
      kind:
        payload.kind === 'clarification' || payload.kind === 'approval'
          ? payload.kind
          : undefined,
      interruptId: typeof payload.interruptId === 'string' ? payload.interruptId : undefined,
      title: typeof payload.title === 'string' ? payload.title : undefined,
      description: typeof payload.description === 'string' ? payload.description : undefined,
      stepIndex: typeof payload.stepIndex === 'number' ? payload.stepIndex : undefined,
      stepCount: typeof payload.stepCount === 'number' ? payload.stepCount : undefined,
      actions: Array.isArray(payload.actions)
        ? payload.actions.filter(
            (
              item,
            ): item is NonNullable<RunPendingInterrupt['actions']>[number] =>
              Boolean(item) &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              typeof (item as { id?: unknown }).id === 'string' &&
              typeof (item as { label?: unknown }).label === 'string',
          )
        : undefined,
      actionRequests: Array.isArray(payload.actionRequests)
        ? payload.actionRequests.filter(
            (item): item is { name?: string; args?: Record<string, unknown> } =>
              Boolean(item) && typeof item === 'object' && !Array.isArray(item),
          )
        : undefined,
      reviewConfigs: Array.isArray(payload.reviewConfigs)
        ? payload.reviewConfigs.filter(
            (item): item is { action_name?: string; allowed_decisions?: string[] } =>
              Boolean(item) && typeof item === 'object' && !Array.isArray(item),
          )
        : undefined,
      responseSpec:
        payload.responseSpec && typeof payload.responseSpec === 'object' && !Array.isArray(payload.responseSpec)
          ? (payload.responseSpec as RunPendingInterrupt['responseSpec'])
          : undefined,
      displayPayload:
        payload.displayPayload && typeof payload.displayPayload === 'object' && !Array.isArray(payload.displayPayload)
          ? (payload.displayPayload as Record<string, unknown>)
          : undefined,
    };
  } catch {
    return undefined;
  }
};

import type { ConversationMessageMetadata } from '../../types';

export type PlanFileImpact = {
  path: string;
  action: 'create' | 'update';
};

export type PlanReviewStep = {
  title: string;
  detail?: string;
  toolNames: string[];
  fileImpacts: PlanFileImpact[];
};

export type ApprovalReviewModel = {
  cardTitle: string;
  badgeLabel: string;
  planTitle: string;
  description?: string;
  summaryMarkdown: string;
  steps: PlanReviewStep[];
  planFilePath: string;
  stepIndex?: number;
  stepCount?: number;
  riskyActions?: string;
  rawChecklist?: string;
  hasStructuredContent: boolean;
};

type PrimaryInterruptAction = { name?: string; args?: Record<string, unknown> } | undefined;

const DEFAULT_CARD_TITLE = 'Review Proposed Action';
const DEFAULT_BADGE_LABEL = 'Pending Approval';
const DEFAULT_PLAN_PATH = 'draft.md';

const coerceString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const normalizePath = (value: string): string => value.replace(/^\/+/, '').trim();

const coerceNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const parseSteps = (value: unknown): PlanReviewStep[] => {
  const rawSteps = (() => {
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  })();

  return rawSteps.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }
    const title = coerceString((item as Record<string, unknown>).title);
    if (!title) {
      return [];
    }
    const detail = coerceString((item as Record<string, unknown>).detail);
    const toolNames = Array.isArray((item as Record<string, unknown>).toolNames)
      ? ((item as Record<string, unknown>).toolNames as unknown[])
          .map((tool) => coerceString(tool))
          .filter(Boolean)
      : [];
    const fileImpactsRaw = Array.isArray((item as Record<string, unknown>).fileImpacts)
      ? ((item as Record<string, unknown>).fileImpacts as unknown[])
      : [];
    const fileImpacts = fileImpactsRaw.flatMap((impact) => {
      if (!impact || typeof impact !== 'object' || Array.isArray(impact)) {
        return [];
      }
      const path = normalizePath(coerceString((impact as Record<string, unknown>).path));
      const action = coerceString((impact as Record<string, unknown>).action).toLowerCase();
      if (!path || (action !== 'create' && action !== 'update')) {
        return [];
      }
      return [{ path, action: action as 'create' | 'update' }];
    });
    return [{ title, ...(detail ? { detail } : {}), toolNames, fileImpacts }];
  });
};

const checklistToSteps = (checklist: string): PlanReviewStep[] =>
  checklist
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+[\.\)]\s+/, '').trim())
    .filter(Boolean)
    .map((title) => ({
      title,
      toolNames: [],
      fileImpacts: [],
    }));

const isGenericApprovalTitle = (value: string): boolean =>
  /approval required/i.test(value) || /request_plan_approval/i.test(value);

export const buildApprovalReview = (
  pendingInterrupt?: ConversationMessageMetadata['pendingInterrupt'],
  primaryAction?: PrimaryInterruptAction,
): ApprovalReviewModel | null => {
  const args =
    primaryAction?.args && typeof primaryAction.args === 'object' && !Array.isArray(primaryAction.args)
      ? primaryAction.args
      : undefined;
  if (!args) {
    return null;
  }

  const planTitle = coerceString(args.plan_title) || coerceString(pendingInterrupt?.title);
  const summaryMarkdown = coerceString(args.plan_summary_markdown) || coerceString(args.plan_summary);
  const rawChecklist = coerceString(args.execution_checklist);
  const steps = parseSteps(args.steps);
  const fallbackSteps = steps.length ? steps : rawChecklist ? checklistToSteps(rawChecklist) : [];
  const planFilePath = normalizePath(coerceString(args.plan_file_path) || DEFAULT_PLAN_PATH) || DEFAULT_PLAN_PATH;
  const badgeLabel = coerceString(args.status_label) || DEFAULT_BADGE_LABEL;
  const riskyActions = coerceString(args.risky_actions);
  const description = coerceString(pendingInterrupt?.description);
  const interruptTitle = coerceString(pendingInterrupt?.title);
  const cardTitle = interruptTitle && !isGenericApprovalTitle(interruptTitle) ? interruptTitle : DEFAULT_CARD_TITLE;
  const stepIndex = coerceNumber(pendingInterrupt?.stepIndex) ?? coerceNumber(args.step_index);
  const stepCount = coerceNumber(pendingInterrupt?.stepCount) ?? coerceNumber(args.step_count);

  if (!planTitle && !summaryMarkdown && !fallbackSteps.length && !rawChecklist) {
    return null;
  }

  return {
    cardTitle,
    badgeLabel,
    planTitle: planTitle || 'Proposed plan',
    ...(description ? { description } : {}),
    summaryMarkdown,
    steps: fallbackSteps,
    planFilePath,
    ...(typeof stepIndex === 'number' ? { stepIndex } : {}),
    ...(typeof stepCount === 'number' ? { stepCount } : {}),
    ...(riskyActions && riskyActions.toLowerCase() !== 'none' ? { riskyActions } : {}),
    ...(rawChecklist ? { rawChecklist } : {}),
    hasStructuredContent: Boolean(summaryMarkdown || fallbackSteps.length),
  };
};

export const buildApprovalDraftContent = (review: ApprovalReviewModel | null): string => {
  if (!review) {
    return '';
  }
  const lines: string[] = [`# ${review.planTitle}`];
  if (review.summaryMarkdown.trim()) {
    lines.push('', review.summaryMarkdown.trim());
  }
  if (review.steps.length) {
    lines.push('', '## Execution Steps');
    review.steps.forEach((step, index) => {
      lines.push('', `${index + 1}. ${step.title}`);
      if (step.detail) {
        lines.push(`   - ${step.detail}`);
      }
      if (step.toolNames.length) {
        lines.push(`   - Tools: ${step.toolNames.join(', ')}`);
      }
      if (step.fileImpacts.length) {
        lines.push(
          `   - Files: ${step.fileImpacts.map((impact) => `${impact.action}: ${impact.path}`).join(' | ')}`,
        );
      }
    });
  } else if (review.rawChecklist) {
    lines.push('', '## Checklist', '', review.rawChecklist.trim());
  }
  if (review.riskyActions) {
    lines.push('', '## Risks', '', review.riskyActions);
  }
  return `${lines.join('\n').trim()}\n`;
};

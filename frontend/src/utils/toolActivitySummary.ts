import type { ToolEvent, ToolOutputFile } from '../types';

export type ToolActivityDigestEvent = {
  id: string;
  title: string;
  detail?: string;
  status: ToolEvent['status'];
  rawToolName?: string;
};

export type ToolActivityStepProgress = {
  current: number;
  total: number;
};

export type ToolActivityDigest = {
  headline: string;
  /** @deprecated Use completedMilestones + activeStepLabel */
  milestoneTrail: string;
  completedMilestones: string[];
  activeStepLabel: string;
  currentLabel: string;
  statsLabel: string;
  stepProgress: ToolActivityStepProgress | null;
  reassuranceNotes: string[];
  reviewedFiles: string[];
  updatesInProgress: string[];
  updatedFileBasenames: string[];
  ragQueryCount: number;
  errorCount: number;
  digestEvents: ToolActivityDigestEvent[];
  rawEventCount: number;
  filesTouchedCount: number;
  lastActivityFormatted?: string;
};

const TOOL_LABELS: Record<string, string> = {
  read_file: 'Reading existing content',
  write_file: 'Preparing a new file',
  edit_file: 'Updating a section',
  patch_file: 'Updating a section',
  list_files: 'Checking workspace files',
  list_dir: 'Listing workspace files',
  list_directory: 'Listing workspace files',
  ls: 'Listing workspace files',
  dir: 'Listing workspace files',
  rag_query: 'Searching your workspace knowledge',
  google_search: 'Checking web sources',
  url_context: 'Reading linked pages',
  web_search: 'Checking web sources',
  load_skill: 'Loading workflow',
  run_terminal: 'Checking the environment',
  run_command: 'Running a workspace command',
  bash: 'Running a workspace command',
  shell: 'Running a workspace command',
  grep: 'Searching within files',
  glob: 'Finding matching files',
  request_clarification: 'Needs a quick detail',
  codebase_search: 'Searching the codebase',
  ask_question: 'Preparing choices',
  write_todos: 'Updating task plan',
  write_todo: 'Updating task plan',
  todo_write: 'Updating task plan',
  writetodos: 'Updating task plan',
  todo_write_tool: 'Updating task plan',
  str_replace_editor: 'Editing a file',
  search_replace: 'Editing a file',
  create_file: 'Creating a file',
  delete_file: 'Removing a file',
  semantic_search: 'Searching the codebase',
  task: 'Running a subtask',
};

function normalizeToolKey(name?: string): string {
  return String(name || '').trim().toLowerCase();
}

export function titleCaseToolName(raw?: string): string {
  const key = String(raw || '').trim();
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function humanizeUnknownToolKey(key: string): string {
  if (TOOL_LABELS[key]) {
    return TOOL_LABELS[key];
  }
  if (/^(ls|pwd|cd|cat|mkdir|rm|cp|mv|find|head|tail|wc|which)$/i.test(key)) {
    return TOOL_LABELS[key.toLowerCase()] ?? 'Running a workspace command';
  }
  if (key.includes('todo')) {
    return 'Updating task plan';
  }
  if (key.includes('list') && (key.includes('dir') || key.includes('file'))) {
    return 'Listing workspace files';
  }
  return titleCaseToolName(key);
}

export function getFriendlyToolName(name?: string): string {
  const key = normalizeToolKey(name);
  if (TOOL_LABELS[key]) {
    return TOOL_LABELS[key];
  }
  if (!key) {
    return 'Working on your request';
  }
  return humanizeUnknownToolKey(key);
}

export function isSkippedToolSummary(summary?: string): boolean {
  return /^Skipped\b/i.test(String(summary || '').trim());
}

/** Agent/tool bootstrap text that should not appear in the user-facing thinking panel. */
export function isOperationalThinkingText(text?: string): boolean {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return false;
  }
  if (/^Loaded skill:/im.test(trimmed)) {
    return true;
  }
  if (/Skill policy for\s+\S+/i.test(trimmed)) {
    return true;
  }
  if (
    /requires_hitl_plan:/i.test(trimmed)
    || /requires_workspace_artifacts:/i.test(trimmed)
    || /^\s*-\s*mcp_servers:/im.test(trimmed)
    || /^\s*-\s*tools:\s*\(/im.test(trimmed)
  ) {
    return true;
  }
  return false;
}

export function stripOperationalThinkingBlocks(text?: string): string {
  const raw = String(text || '');
  if (!raw.trim()) {
    return '';
  }
  const cleaned = raw
    .replace(/Loaded skill:\s*\S+[^\n]*\n+([\s\S]*?)(?=\n\n(?![\s-])|$)/gi, '')
    .replace(/Skill policy for\s+\S+:\s*\n[\s\S]*?(?=\n\n|$)/gi, '')
    .replace(/^\s*-\s*requires_hitl_plan:[^\n]*\n?/gim, '')
    .replace(/^\s*-\s*requires_workspace_artifacts:[^\n]*\n?/gim, '')
    .replace(/^\s*-\s*(?:resolved_)?tools:[^\n]*\n?/gim, '')
    .replace(/^\s*-\s*mcp_servers:[^\n]*\n?/gim, '')
    .replace(/^\s*-\s*sandbox_scripts:[^\n]*\n?/gim, '')
    .replace(/^\s*-\s*Do not call request_plan_approval[^\n]*\n?/gim, '')
    .replace(/^\s*-\s*You must call request_plan_approval[^\n]*\n?/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (isOperationalThinkingText(cleaned)) {
    return '';
  }
  return cleaned;
}

export function summarizeLoadedSkillThinking(text?: string): string | undefined {
  const match = String(text || '').match(/Loaded skill:\s*(\S+)/i);
  if (!match?.[1]) {
    return undefined;
  }
  const skillId = match[1].replace(/[_-]+/g, ' ');
  return `Loaded ${skillId} workflow`;
}

export function isBenignToolStreamContent(content: string): boolean {
  return /Cannot write to .+ because it already exists/i.test(String(content || '').trim());
}

export function isBenignToolNoise(event: ToolEvent): boolean {
  const summary = String(event.summary || '');
  if (/Cannot write to .+ because it already exists/i.test(summary)) {
    return true;
  }
  if (/File already exists,\s*switching to edit mode/i.test(summary)) {
    return true;
  }
  if (/file already exists/i.test(summary) && /write|create|save/i.test(summary)) {
    return true;
  }
  if (/EEXIST/i.test(summary) && /write|file/i.test(summary)) {
    return true;
  }
  return false;
}

function looksLikeLineNumberDump(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return false;
  }
  if (/^\d{2,4}\s+\d{2,4}\s+/m.test(t)) {
    return true;
  }
  if (/\b\d{2,4}\s+\d{2,4}\s+#+\s/.test(t)) {
    return true;
  }
  return false;
}

export function extractPathLikeTokens(text: string): string[] {
  if (!text || !text.trim()) {
    return [];
  }
  const matches = text.match(
    /(?:\.{0,2}\/|[/~])[^\s`'")\]]+|\/[\w.-]+\/[\w./-]*[\w.-]+|\b[\w.-]+\.(?:md|mdx|txt|tsx?|jsx?|json|yaml|yml|py|rs|go|java|sql|css|html)\b/gi,
  );
  if (!matches?.length) {
    return [];
  }
  return [...new Set(matches.map((m) => m.trim()).filter(Boolean))];
}

export function extractToolPathFiles(text?: string): ToolOutputFile[] {
  return extractPathLikeTokens(String(text || '')).map((path) => ({ path }));
}

function eventRelatedPaths(event: ToolEvent): string[] {
  const paths: string[] = [];
  if (event.relatedFiles?.length) {
    for (const file of event.relatedFiles) {
      if (file.path?.trim()) {
        paths.push(file.path);
      }
    }
  }
  if (event.outputFiles?.length) {
    for (const file of event.outputFiles) {
      if (file.path?.trim()) {
        paths.push(file.path);
      }
    }
  }
  if (event.summary) {
    paths.push(...extractPathLikeTokens(event.summary));
  }
  return paths;
}

function displayBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const base = normalized.split('/').pop() || normalized;
  return base || path;
}

function humanizePathList(paths: string[]): string[] {
  const basenames = paths.map(displayBasename);
  return [...new Set(basenames)];
}

function extractSectionHint(summary: string, toolName?: string): string | undefined {
  const cleaned = summary.replace(/^\d+\s+\d+\s+/gm, '').trim();
  const header = cleaned.match(/^(#{1,6})\s+(.+)$/m);
  if (header?.[2]) {
    return `Editing ${header[2].trim().slice(0, 80)}`;
  }
  const paths = extractPathLikeTokens(cleaned);
  if (paths.length && normalizeToolKey(toolName) === 'edit_file') {
    return `Editing ${displayBasename(paths[0])}`;
  }
  return paths.length ? `Working on ${displayBasename(paths[0])}` : undefined;
}

export function normalizeUserFacingSummary(raw: string, toolName?: string): string | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }
  if (isOperationalThinkingText(text)) {
    return summarizeLoadedSkillThinking(text) ?? undefined;
  }
  if (isSkippedToolSummary(text)) {
    return undefined;
  }
  if (/Cannot write to .* because it already exists/i.test(text)) {
    return 'File already exists, switching to edit mode.';
  }
  if (/Cannot write\b/i.test(text) && /already exists/i.test(text)) {
    return 'File already exists, switching to edit mode.';
  }
  if (looksLikeLineNumberDump(text)) {
    return humanizeSectionDraftMessage(toolName);
  }
  if (text.length > 480 && /\d{3}\s+/.test(text.slice(0, 120))) {
    return humanizeSectionDraftMessage(toolName);
  }
  return text;
}

function humanizeSectionDraftMessage(toolName?: string): string {
  switch (normalizeToolKey(toolName)) {
    case 'edit_file':
    case 'patch_file':
    case 'write_file':
      return 'Drafting section…';
    case 'read_file':
      return 'Reading content…';
    default:
      return 'Working…';
  }
}

export function translateToolChunkForStorage(content: string, toolName?: string, maxLen = 200): string | undefined {
  const normalized = normalizeUserFacingSummary(content, toolName);
  if (!normalized?.trim()) {
    return undefined;
  }
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
}

export function collectReviewedBasenames(events: ToolEvent[]): string[] {
  const paths: string[] = [];
  for (const event of events) {
    if (normalizeToolKey(event.name) !== 'read_file') {
      continue;
    }
    paths.push(...eventRelatedPaths(event));
  }
  return humanizePathList(paths);
}

export function collectUpdatedBasenames(events: ToolEvent[]): string[] {
  const paths: string[] = [];
  for (const event of events) {
    const name = normalizeToolKey(event.name);
    if (!['edit_file', 'patch_file', 'write_file'].includes(name)) {
      continue;
    }
    paths.push(...eventRelatedPaths(event));
  }
  return humanizePathList(paths);
}

export function headlineForDigest(events: ToolEvent[]): string {
  const lastMeaningful = [...events].reverse().find((e) => !isSkippedToolSummary(e.summary) && !isBenignToolNoise(e));
  if (!lastMeaningful) {
    return 'Working through your request';
  }
  const tools = events.map((e) => normalizeToolKey(e.name));
  const hasReads = tools.includes('read_file');
  const hasEdits = tools.some((t) => ['edit_file', 'patch_file', 'write_file'].includes(t));

  switch (normalizeToolKey(lastMeaningful.name)) {
    case 'read_file':
      return hasEdits ? 'Updating your workspace files' : 'Reviewing your workspace';
    case 'edit_file':
    case 'patch_file':
    case 'write_file':
      return 'Updating your documents';
    case 'rag_query':
    case 'codebase_search':
      return 'Searching your workspace knowledge';
    case 'google_search':
    case 'url_context':
    case 'web_search':
      return 'Gathering references from the web';
    default:
      if (!hasReads && !hasEdits) {
        return 'Working through your task';
      }
      return hasEdits ? 'Updating your workspace' : 'Reviewing workspace context';
  }
}

export function milestonesFromEvents(events: ToolEvent[]): string[] {
  const labels: string[] = [];
  for (const event of events) {
    if (isSkippedToolSummary(event.summary)) {
      continue;
    }
    if (isBenignToolNoise(event)) {
      continue;
    }
    const label = getFriendlyToolName(event.name);
    if (labels[labels.length - 1] !== label) {
      labels.push(label);
    }
  }
  return labels.slice(-3);
}

function labelForRunningToolEvent(event: ToolEvent): string {
  const friendly = getFriendlyToolName(event.name);
  const summaryNorm = normalizeUserFacingSummary(event.summary || '', event.name)?.trim();
  const hint = extractSectionHint(event.summary || '', event.name);
  const candidate = summaryNorm ?? hint;
  if (!candidate) {
    return friendly;
  }
  const candidateKey = normalizeToolKey(candidate);
  const toolKey = normalizeToolKey(event.name);
  if (
    candidateKey === toolKey
    || TOOL_LABELS[candidateKey]
    || (candidate.length <= 24 && !candidate.includes(' ') && candidateKey === candidate.toLowerCase())
  ) {
    return friendly;
  }
  return candidate;
}

function labelsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function splitMilestonesForDisplay(
  milestoneLabels: string[],
  activeLabel: string,
): { completedMilestones: string[]; activeStepLabel: string } {
  if (!milestoneLabels.length) {
    return { completedMilestones: [], activeStepLabel: activeLabel };
  }
  const lastMilestone = milestoneLabels[milestoneLabels.length - 1];
  const activeMatchesLast = labelsMatch(lastMilestone, activeLabel);
  const completedRaw = activeMatchesLast ? milestoneLabels.slice(0, -1) : milestoneLabels;
  const completedMilestones = completedRaw.filter((label) => !labelsMatch(label, activeLabel));
  return {
    completedMilestones,
    activeStepLabel: activeLabel,
  };
}

export function reassuranceFromEvents(events: ToolEvent[]): string[] {
  const notes: string[] = [];
  const benign = events.some((e) => isBenignToolNoise(e));
  if (benign) {
    notes.push('Some files already existed, so the agent is editing them instead of recreating them.');
  }
  return notes;
}

function countRagQueries(events: ToolEvent[]): number {
  let n = 0;
  for (const event of events) {
    if (normalizeToolKey(event.name) === 'rag_query') {
      n++;
    }
  }
  return n;
}

export function summarizeToolActivity(
  events: ToolEvent[],
  formatShortTime?: (iso?: string) => string | undefined,
): ToolActivityDigest {
  const normalized = [...events].filter((e) => !isSkippedToolSummary(e.summary));
  const digestEventsUncapped: ToolActivityDigestEvent[] = [];
  for (const event of normalized) {
    const rawName = event.name;
    if (isBenignToolNoise(event)) {
      continue;
    }
    const friendlyTitle = getFriendlyToolName(event.name);
    let detail = event.summary?.trim()
      ? normalizeUserFacingSummary(event.summary, event.name) ?? event.summary.trim()
      : undefined;
    if (detail && looksLikeLineNumberDump(detail)) {
      detail = humanizeSectionDraftMessage(event.name);
    }
    if (detail === friendlyTitle || detail?.startsWith(`${rawName}`)) {
      detail = undefined;
    }
    digestEventsUncapped.push({
      id: event.id,
      title: friendlyTitle,
      detail: detail && detail.length > 280 ? `${detail.slice(0, 277)}…` : detail,
      status: event.status,
      rawToolName: event.name,
    });
  }

  const lastNonNoise = [...normalized].reverse().find((e) => !isBenignToolNoise(e));
  let currentLabel = lastNonNoise ? getFriendlyToolName(lastNonNoise.name) : 'Working through your request';
  if (lastNonNoise?.status === 'running') {
    currentLabel = labelForRunningToolEvent(lastNonNoise);
  }

  const reviewedFiles = collectReviewedBasenames(normalized);
  const updatedBasenames = collectUpdatedBasenames(normalized);
  const runningEdits = normalized.filter((e) =>
    e.status === 'running' && ['edit_file', 'patch_file', 'write_file'].includes(normalizeToolKey(e.name)),
  );
  const updatesInProgress: string[] = [];
  for (const e of runningEdits) {
    const hint =
      extractSectionHint(e.summary || '', e.name)
      ?? (normalizeToolKey(e.name) === 'write_file' ? 'Preparing a new file' : 'Updating a section');
    if (hint && !updatesInProgress.includes(hint)) {
      updatesInProgress.push(hint);
    }
  }

  let filesTouched = new Set([
    ...reviewedFiles,
    ...updatedBasenames,
  ]).size;
  if (!filesTouched) {
    const loose = normalized.flatMap((e) => eventRelatedPaths(e)).map(displayBasename);
    filesTouched = new Set(loose.filter(Boolean)).size;
  }

  const errorCount = normalized.filter((e) => e.status === 'error' && !isBenignToolNoise(e)).length;

  const lastTs = [...normalized].reverse().find((e) => e.startedAt || e.finishedAt);
  const lastActivityIso = lastTs?.finishedAt || lastTs?.startedAt;

  const milestoneLabels = milestonesFromEvents(normalized);
  const { completedMilestones, activeStepLabel } = splitMilestonesForDisplay(milestoneLabels, currentLabel);
  const trail = milestoneLabels.join(' · ');

  const totalSteps = digestEventsUncapped.length;
  let stepProgress: ToolActivityStepProgress | null = null;
  if (totalSteps > 0) {
    const runningIndex = digestEventsUncapped.findIndex((e) => e.status === 'running');
    const currentStep = runningIndex >= 0 ? runningIndex + 1 : totalSteps;
    stepProgress = { current: currentStep, total: totalSteps };
  }

  const parts: string[] = [];
  if (reviewedFiles.length) {
    parts.push(`Reviewed ${reviewedFiles.length} ${reviewedFiles.length === 1 ? 'file' : 'files'}`);
  }
  const editLikeCount = normalized.filter((e) =>
    ['edit_file', 'patch_file'].includes(normalizeToolKey(e.name))
    && e.status !== 'error',
  ).length;
  if (updatesInProgress.length) {
    parts.push(`Updating ${updatesInProgress.length} ${updatesInProgress.length === 1 ? 'area' : 'areas'}`);
  } else if (editLikeCount) {
    parts.push(`${editLikeCount} ${editLikeCount === 1 ? 'section' : 'sections'} updated`);
  }
  const ragCount = countRagQueries(normalized);
  if (ragCount) {
    parts.push(`${ragCount} knowledge ${ragCount === 1 ? 'search' : 'searches'}`);
  }

  const statsLabel = parts.join(' · ');

  return {
    headline: headlineForDigest(normalized.filter((e) => !isBenignToolNoise(e))),
    milestoneTrail: trail || currentLabel,
    completedMilestones,
    activeStepLabel,
    currentLabel,
    statsLabel,
    stepProgress,
    reassuranceNotes: reassuranceFromEvents(events),
    reviewedFiles,
    updatesInProgress,
    updatedFileBasenames: updatedBasenames,
    ragQueryCount: ragCount,
    errorCount,
    digestEvents: digestEventsUncapped.slice(-48),
    rawEventCount: events.length,
    filesTouchedCount: filesTouched,
    lastActivityFormatted: formatShortTime ? formatShortTime(lastActivityIso) : undefined,
  };
}

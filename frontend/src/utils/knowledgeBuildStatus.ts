import type { KnowledgeBaseMember } from '../services/knowledgeBaseApi';

/** A step running longer than this gets a reassurance line instead of a bare spinner. */
export const SLOW_STEP_MS = 5 * 60 * 1000;

export type MemberBuildStatus =
  | { tone: 'built' }
  | { tone: 'warning'; text: string; detail: string }
  | { tone: 'queued'; text: string }
  | { tone: 'pending'; text: string; detail?: string }
  | { tone: 'stalled'; text: string; detail: string }
  | { tone: 'failed'; text: string; detail: string }
  | { tone: 'idle'; text: string };

const PENDING_STATUSES = new Set([
  'queued', 'processing', 'extracting', 'structuring', 'chunking', 'enriching',
  'reducing', 'validating', 'indexing', 'publishing',
]);

const minutesSince = (iso: string | null | undefined, now: Date): number | null => {
  if (!iso) return null;
  const elapsed = now.getTime() - new Date(iso).getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
};

const formatMinutes = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? 'under a minute' : `${minutes} min`;
};

/**
 * What a knowledge base member's build is doing, in words a user can act on.
 *
 * The page used to show a spinner beside the raw stage name ("reducing"), and a failed
 * build read "not built", the same as one never started. Users could not tell a
 * working build from a stuck or failed one, and refreshed or uploaded again.
 */
export const describeMemberBuild = (member: KnowledgeBaseMember, now = new Date()): MemberBuildStatus => {
  const status = (member.ingestionStatus || '').toLowerCase();
  if (PENDING_STATUSES.has(status)) {
    const progress = member.ingestionProgress;
    if (progress?.stalled) {
      return {
        tone: 'stalled',
        text: 'Paused',
        detail: 'The build stopped responding and will resume automatically within a few minutes.',
      };
    }
    if (status === 'queued') {
      const ahead = progress?.queuedAhead;
      if (typeof ahead === 'number' && ahead > 0) {
        return { tone: 'queued', text: `Queued · ${ahead} ${ahead === 1 ? 'file' : 'files'} ahead` };
      }
      return { tone: 'queued', text: 'Queued · starts next' };
    }
    const label = progress?.label || 'Building';
    // Concept building is the longest step; a section count shows it moving where a
    // fixed step percent sat unchanged for minutes.
    const sections = progress?.sections;
    const text = sections
      ? `${label} · ${sections.done} of ${sections.total} sections`
      : progress ? `${label} · ${progress.percent}%` : label;
    const elapsed = minutesSince(progress?.stageSince, now);
    if (elapsed !== null && elapsed >= SLOW_STEP_MS) {
      return {
        tone: 'pending',
        text,
        detail: `This step has run for ${formatMinutes(elapsed)}. Long documents can take up to 15 minutes; it is still working.`,
      };
    }
    return elapsed === null ? { tone: 'pending', text } : { tone: 'pending', text, detail: `For ${formatMinutes(elapsed)}` };
  }
  if (status === 'failed') {
    return {
      tone: 'failed',
      text: 'Build failed',
      detail: member.ingestionError || 'The build did not finish. Retry to build it again.',
    };
  }
  if (member.published) {
    const warnings = member.ingestionWarnings || [];
    // Published from its sections after a reduce failure, or with pages missing: usable,
    // but not the same as a complete build, so it must not wear the same green tick.
    return warnings.length
      ? { tone: 'warning', text: 'Built with warnings', detail: warnings.join(' ') }
      : { tone: 'built' };
  }
  return { tone: 'idle', text: 'Not built yet' };
};

/**
 * Members a publish would leave out: those with no built version yet.
 *
 * A member being rebuilt still has its earlier version, which the publish includes, so
 * it is not counted.
 */
export const membersLeftOutOfPublish = (members: KnowledgeBaseMember[]): KnowledgeBaseMember[] =>
  members.filter((member) => !member.published);

/**
 * One line for the whole knowledge base, e.g. "6 documents: 2 built · 2 processing ·
 * 2 queued". With a batch of large uploads, users saw each file's status but not
 * where the batch stood, so they could not tell how much was left.
 */
export const summarizeMemberBuilds = (members: KnowledgeBaseMember[], now = new Date()): string | null => {
  if (!members.length) return null;
  const counts = { built: 0, warnings: 0, failed: 0, processing: 0, queued: 0, notStarted: 0 };
  for (const member of members) {
    const { tone } = describeMemberBuild(member, now);
    if (tone === 'built') counts.built += 1;
    else if (tone === 'warning') { counts.built += 1; counts.warnings += 1; }
    else if (tone === 'failed') counts.failed += 1;
    else if (tone === 'pending' || tone === 'stalled') counts.processing += 1;
    else if (tone === 'queued') counts.queued += 1;
    else counts.notStarted += 1;
  }
  const total = members.length;
  const noun = total === 1 ? 'document' : 'documents';
  if (counts.built === total && !counts.warnings) return total === 1 ? '1 document built' : `All ${total} documents built`;
  const parts = [
    `${counts.built} built${counts.warnings ? ` (${counts.warnings} with warnings)` : ''}`,
    counts.processing ? `${counts.processing} processing` : '',
    counts.queued ? `${counts.queued} queued` : '',
    counts.failed ? `${counts.failed} failed` : '',
    counts.notStarted ? `${counts.notStarted} not built yet` : '',
  ].filter(Boolean);
  return `${total} ${noun}: ${parts.join(' · ')}`;
};

export type UploadRowStatus = 'waiting' | 'uploading' | 'finalizing' | 'queued' | 'failed';

/** What an upload row says. A large file used to show only "uploading" until done. */
export const describeUploadRow = (status: UploadRowStatus, percent?: number): string => {
  switch (status) {
    case 'waiting': return 'Waiting to upload';
    case 'uploading': return typeof percent === 'number' ? `Uploading ${percent}%` : 'Uploading';
    case 'finalizing': return 'Finishing upload';
    case 'queued': return 'Queued for processing';
    case 'failed': return 'Upload failed';
  }
};

/** Rows still sending data: leaving the page now would lose these files. */
export const isUploadInFlight = (status: UploadRowStatus): boolean =>
  status === 'waiting' || status === 'uploading' || status === 'finalizing';

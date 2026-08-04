import { Fragment, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Loader2, RotateCcw } from 'lucide-react';
import type { KnowledgeIngestionJob } from '../../services/knowledgeApi';

type KnowledgeJobTableProps = {
  jobs: KnowledgeIngestionJob[];
  onRetry?: (job: KnowledgeIngestionJob) => void;
};

const GROUP_ORDER = ['active', 'published', 'attention', 'history'] as const;
type JobGroup = (typeof GROUP_ORDER)[number];

const groupLabels: Record<JobGroup, string> = {
  active: 'In progress',
  published: 'Published',
  attention: 'Needs attention',
  history: 'History',
};

const activeStatuses = new Set([
  'queued', 'processing', 'extracting', 'structuring', 'chunking', 'enriching',
  'reducing', 'validating', 'indexing', 'publishing',
]);

const statusLabel = (status: string) => ({
  queued: 'Queued',
  processing: 'Starting build',
  extracting: 'Reading source',
  structuring: 'Understanding structure',
  chunking: 'Preparing sections',
  enriching: 'Building knowledge',
  reducing: 'Consolidating concepts',
  validating: 'Validating bundle',
  indexing: 'Indexing knowledge',
  publishing: 'Publishing version',
  published: 'Published',
  partial: 'Published with warnings',
  failed: 'Failed',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
}[status] || 'Queued');

const progressFor = (job: KnowledgeIngestionJob) => {
  if (typeof job.progressPercent === 'number') return job.progressPercent;
  if (job.status === 'published' || job.status === 'partial') return 100;
  return activeStatuses.has(job.status) ? 10 : 0;
};

const groupFor = (job: KnowledgeIngestionJob): JobGroup => {
  if (activeStatuses.has(job.status)) return 'active';
  if (job.status === 'published') return 'published';
  if (job.status === 'failed' || job.status === 'partial') return 'attention';
  return 'history';
};

const statusTone = (status: string) => {
  if (status === 'published') return 'text-emerald-700 bg-emerald-50 border-emerald-100';
  if (status === 'failed' || status === 'partial') return 'text-rose-700 bg-rose-50 border-rose-100';
  if (activeStatuses.has(status)) return 'text-amber-700 bg-amber-50 border-amber-100';
  return 'text-slate-600 bg-slate-100 border-slate-200';
};

const KnowledgeJobsTable = ({ jobs, onRetry }: KnowledgeJobTableProps) => {
  const [collapsed, setCollapsed] = useState<Set<JobGroup>>(new Set());
  const grouped = useMemo(() => {
    const groups = new Map<JobGroup, KnowledgeIngestionJob[]>();
    GROUP_ORDER.forEach((group) => groups.set(group, []));
    jobs.forEach((job) => groups.get(groupFor(job))?.push(job));
    return groups;
  }, [jobs]);

  const toggleGroup = (group: JobGroup) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  if (!jobs.length) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 px-6 py-8 text-center">
        <p className="text-sm font-medium text-slate-700">No ingestion jobs yet</p>
        <p className="mt-1 text-xs text-slate-500">Upload a source to start a knowledge build.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3">Status</th>
            <th className="w-[34%] px-4 py-3">High-level progress</th>
            <th className="px-4 py-3">Updated</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {GROUP_ORDER.map((group) => {
            const groupJobs = grouped.get(group) || [];
            if (!groupJobs.length) return null;
            const isCollapsed = collapsed.has(group);
            return (
              <Fragment key={group}>
                <tr
                  className="cursor-pointer border-t border-slate-200 bg-slate-50/80 hover:bg-slate-100"
                  onClick={() => toggleGroup(group)}
                >
                  <td colSpan={5} className="px-4 py-2.5">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      {groupLabels[group]}
                      <span className="font-normal text-slate-400">{groupJobs.length}</span>
                    </div>
                  </td>
                </tr>
                {!isCollapsed ? groupJobs.map((job) => {
                  const progress = progressFor(job);
                  const isActive = activeStatuses.has(job.status);
                  const isFailed = job.status === 'failed';
                  return (
                    <tr key={job.id} className="border-t border-slate-100 align-middle">
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900">{job.sourceTitle || 'Knowledge source'}</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {job.sourceFileName || job.sourceType || 'Uploaded source'}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${statusTone(job.status)}`}>
                          {isActive ? <Loader2 size={12} className="animate-spin" /> : null}
                          {job.status === 'published' ? <CheckCircle2 size={12} /> : null}
                          {isFailed || job.status === 'partial' ? <CircleAlert size={12} /> : null}
                          {statusLabel(job.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <span className="text-slate-600">{job.progressLabel || statusLabel(job.status)}</span>
                          <span className="font-medium text-slate-700">{progress}%</span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
                          <div
                            className={`h-full rounded-full transition-[width] duration-500 ${isFailed ? 'bg-rose-500' : 'bg-amber-500'}`}
                            style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
                          />
                        </div>
                        {job.discoveredSourceUnits > 0 ? (
                          <p className="mt-1 text-[11px] text-slate-400">
                            {job.processedSourceUnits}/{job.discoveredSourceUnits} source units processed
                          </p>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                        {new Date(job.updatedAt || job.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {isFailed && onRetry ? (
                          <button
                            type="button"
                            className="settings-portal-button-secondary inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs"
                            onClick={() => onRetry(job)}
                          >
                            <RotateCcw size={12} /> Retry
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                }) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export { KnowledgeJobsTable };
export default KnowledgeJobsTable;

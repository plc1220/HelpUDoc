import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BookOpen,
  CheckCircle2,
  FileText,
  History,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  UploadCloud,
  Users2,
  X,
} from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
import {
  SettingsEmptyState,
  SettingsLoadingState,
  SettingsNotice,
  SettingsSectionHeader,
  SettingsSurface,
  SettingsTabs,
} from '../components/settings/SettingsScaffold';
import GovernanceViewToggle, { type GovernanceViewMode } from '../features/governance/GovernanceViewToggle';
import { putGlobalKnowledgeUpload } from '../services/knowledgeApi';
import {
  addKnowledgeBaseSource,
  archiveKnowledgeBase,
  completeKnowledgeBaseUpload,
  createKnowledgeBase,
  createKnowledgeBaseUploadSession,
  fetchAssignableSources,
  fetchEligibleTeams,
  fetchKnowledgeBase,
  fetchKnowledgeBaseCatalog,
  fetchKnowledgeBaseTeams,
  fetchKnowledgeBaseVersions,
  grantKnowledgeBaseTeam,
  publishKnowledgeBase,
  removeKnowledgeBaseSource,
  revokeKnowledgeBaseTeam,
  type AssignableSource,
  type GovernanceTeam,
  type KnowledgeBaseDetail,
  type KnowledgeBaseStatus,
  type KnowledgeBaseSummary,
  type KnowledgeBaseTeamGrant,
  type KnowledgeBaseVersionEntry,
} from '../services/knowledgeBaseApi';

type TabId = 'catalog' | 'manage';

const statusTone = (status: KnowledgeBaseStatus): string => {
  switch (status) {
    case 'published': return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200';
    case 'archived': return 'bg-slate-100 text-slate-500 ring-1 ring-slate-200';
    default: return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200';
  }
};

const StatusBadge = ({ status }: { status: KnowledgeBaseStatus }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusTone(status)}`}>
    {status === 'published' ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> : null}
    {status.charAt(0).toUpperCase() + status.slice(1)}
  </span>
);

const guessKnowledgeType = (fileName: string): string => {
  const ext = fileName.toLowerCase().split('.').pop() || '';
  if (['csv', 'xlsx', 'xls'].includes(ext)) return 'table';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (['pptx', 'ppt'].includes(ext)) return 'presentation';
  return 'text';
};

const isPendingIngestion = (status?: string | null): boolean => {
  const s = (status || '').toLowerCase();
  return s !== '' && !['published', 'partial', 'failed', 'not_started', 'cancelled', 'superseded'].includes(s);
};

const KnowledgeGovernancePage = () => {
  const [tab, setTab] = useState<TabId>('catalog');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<KnowledgeBaseSummary[]>([]);
  const [teams, setTeams] = useState<GovernanceTeam[]>([]);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogView, setCatalogView] = useState<GovernanceViewMode>('card');

  const [creatorOpen, setCreatorOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [versionsId, setVersionsId] = useState<string | null>(null);

  const canCreate = useMemo(() => teams.some((team) => team.isLead), [teams]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bases, myTeams] = await Promise.all([fetchKnowledgeBaseCatalog(), fetchEligibleTeams()]);
      setCatalog(bases);
      setTeams(myTeams);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge bases');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visibleCatalog = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase();
    const scoped = tab === 'manage'
      ? catalog.filter((base) => teams.some((team) => team.isLead && team.id === base.ownerTeamId))
      : catalog;
    if (!query) return scoped;
    return scoped.filter((base) =>
      base.name.toLowerCase().includes(query)
      || base.slug.toLowerCase().includes(query)
      || (base.ownerTeamName || '').toLowerCase().includes(query));
  }, [catalog, catalogQuery, tab, teams]);

  const createAction = canCreate ? (
    <button
      type="button"
      onClick={() => setCreatorOpen(true)}
      className="settings-portal-button-primary inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold"
    >
      <Plus size={16} /> Create knowledge base
    </button>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
      <Lock size={12} /> Team Leads only
    </span>
  );

  return (
    <SettingsShell
      eyebrow="Knowledge"
      title="Knowledge governance"
      description="Team Leads curate and publish knowledge bases everyone can use. Published bases are shared with granted teams — no review queue."
      actions={(
        <button
          type="button"
          onClick={() => void load()}
          className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      )}
    >
      <SettingsTabs
        tabs={[
          { id: 'catalog', label: 'Catalog', icon: BookOpen },
          { id: 'manage', label: 'My bases', icon: Users2 },
        ]}
        value={tab}
        onChange={setTab}
      />

      {error ? <SettingsNotice variant="error">{error}</SettingsNotice> : null}

      {loading ? (
        <SettingsSurface><SettingsLoadingState label="Loading knowledge bases…" /></SettingsSurface>
      ) : (
        <SettingsSurface>
          <SettingsSectionHeader
            eyebrow={tab === 'manage' ? 'Managed' : 'Shared catalog'}
            title="Knowledge bases"
            description={tab === 'manage'
              ? 'Bases owned by teams you lead. Create, curate, and publish them.'
              : 'Browse published bases, see who owns them, and check whether they are available to you.'}
            actions={createAction}
          />

          {!catalog.length ? (
            <SettingsEmptyState
              title="No knowledge bases yet"
              description="Create your first curated base to start the shared library. Only Team Leads can create and publish bases."
              icon={BookOpen}
              action={canCreate ? (
                <button type="button" onClick={() => setCreatorOpen(true)} className="settings-portal-button-primary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold">
                  <Plus size={16} /> Create knowledge base
                </button>
              ) : undefined}
            />
          ) : (
            <>
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <label className="relative min-w-[220px] flex-1 sm:max-w-sm">
                  <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    value={catalogQuery}
                    onChange={(event) => setCatalogQuery(event.target.value)}
                    className="settings-control w-full rounded-xl py-2.5 pl-9 pr-3 text-sm"
                    placeholder="Search knowledge bases"
                    aria-label="Search knowledge bases"
                  />
                </label>
                <GovernanceViewToggle value={catalogView} onChange={setCatalogView} />
              </div>

              {!visibleCatalog.length ? (
                <SettingsEmptyState title="No matching bases" description="Try a different search or tab." icon={Search} />
              ) : (
                <div className={`mt-4 ${catalogView === 'card' ? 'grid gap-4 md:grid-cols-2 xl:grid-cols-3' : 'space-y-2'}`}>
                  {visibleCatalog.map((base) => (
                    <article key={base.id} className={`settings-selection-card rounded-2xl ${catalogView === 'compact' ? 'flex items-center gap-2 p-2.5' : catalogView === 'list' ? 'flex items-center gap-3 p-3' : 'p-4'}`}>
                      <button type="button" onClick={() => setDetailId(base.id)} className={`min-w-0 flex-1 text-left ${catalogView === 'card' ? 'block w-full' : 'flex items-center justify-between gap-4'}`}>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="truncate font-semibold text-slate-900">{base.name}</h3>
                            {catalogView !== 'card' ? <StatusBadge status={base.status} /> : null}
                          </div>
                          <p className={`${catalogView === 'compact' ? 'inline' : 'mt-1'} truncate font-mono text-xs text-slate-500`}>{base.slug}@{base.currentVersion || '—'}</p>
                          {catalogView !== 'compact' ? <p className={`${catalogView === 'card' ? 'mt-3 line-clamp-3 min-h-[60px]' : 'mt-1 line-clamp-1'} text-sm leading-5 text-slate-600`}>{base.description || 'No description provided.'}</p> : null}
                        </div>
                        <div className={`${catalogView === 'card' ? 'mt-4 border-t border-slate-100 pt-3' : 'shrink-0 text-right'} text-xs text-slate-500`}>
                          {catalogView === 'card' ? <StatusBadge status={base.status} /> : null}
                          <p className={catalogView === 'card' ? 'mt-2' : ''}>Owned by {base.ownerTeamName || 'Platform'}</p>
                          <p className="mt-1">{base.sourceCount} sources · {base.teamGrantCount} teams</p>
                        </div>
                      </button>
                      <div className={`${catalogView === 'card' ? 'mt-4 grid grid-cols-2' : 'flex shrink-0'} gap-2`}>
                        <button type="button" onClick={() => setDetailId(base.id)} className="settings-portal-button-secondary inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold">
                          <FileText size={16} /> {catalogView === 'compact' ? <span className="sr-only">Open</span> : 'Open'}
                        </button>
                        <button type="button" onClick={() => setVersionsId(base.id)} className="settings-portal-button-secondary inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold">
                          <History size={16} /> {catalogView === 'compact' ? <span className="sr-only">Versions</span> : 'Versions'}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </SettingsSurface>
      )}

      {creatorOpen ? (
        <CreateDialog
          teams={teams.filter((team) => team.isLead)}
          onClose={() => setCreatorOpen(false)}
          onCreated={async (created) => {
            setCreatorOpen(false);
            await load();
            setDetailId(created.id);
          }}
        />
      ) : null}

      {detailId ? (
        <DetailDialog
          knowledgeBaseId={detailId}
          teams={teams}
          onClose={() => setDetailId(null)}
          onChanged={() => void load()}
          onOpenVersions={(id) => { setDetailId(null); setVersionsId(id); }}
        />
      ) : null}

      {versionsId ? (
        <VersionsDialog knowledgeBaseId={versionsId} onClose={() => setVersionsId(null)} />
      ) : null}
    </SettingsShell>
  );
};

const Dialog = ({ title, subtitle, onClose, children, footer, maxWidth = 'max-w-3xl' }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
}) => (
  <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-900/40 p-6 sm:p-12" onClick={onClose}>
    <div className={`w-full ${maxWidth} overflow-hidden rounded-2xl bg-white shadow-2xl`} onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-slate-900">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
        </div>
        <button type="button" onClick={onClose} className="settings-portal-button-secondary inline-flex h-8 w-8 items-center justify-center rounded-lg" aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div className="max-h-[60vh] overflow-auto px-6 py-5">{children}</div>
      {footer ? <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-6 py-4">{footer}</div> : null}
    </div>
  </div>
);

const CreateDialog = ({ teams, onClose, onCreated }: {
  teams: GovernanceTeam[];
  onClose: () => void;
  onCreated: (created: KnowledgeBaseDetail) => void | Promise<void>;
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ownerTeamId, setOwnerTeamId] = useState(teams[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || !ownerTeamId) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await createKnowledgeBase({ name: name.trim(), description: description.trim() || undefined, ownerTeamId });
      await onCreated(created);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Failed to create knowledge base');
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New knowledge base"
      subtitle="Curate a set of documents to publish for your team."
      onClose={onClose}
      maxWidth="max-w-xl"
      footer={(
        <>
          <button type="button" onClick={onClose} className="settings-portal-button-secondary rounded-xl px-4 py-2.5 text-sm font-semibold">Cancel</button>
          <button type="button" onClick={() => void submit()} disabled={busy || !name.trim() || !ownerTeamId} className="settings-portal-button-primary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Create base
          </button>
        </>
      )}
    >
      {err ? <SettingsNotice variant="error">{err}</SettingsNotice> : null}
      <label className="mb-1.5 block text-sm font-semibold text-slate-700">Name</label>
      <input value={name} onChange={(event) => setName(event.target.value)} className="settings-control mb-4 w-full rounded-xl px-3 py-2.5 text-sm" placeholder="e.g. TOS Analysis Library" />
      <label className="mb-1.5 block text-sm font-semibold text-slate-700">Description</label>
      <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} className="settings-control mb-4 w-full rounded-xl px-3 py-2.5 text-sm" placeholder="What this base contains and who it's for." />
      <label className="mb-1.5 block text-sm font-semibold text-slate-700">Owning team</label>
      <select value={ownerTeamId} onChange={(event) => setOwnerTeamId(event.target.value)} className="settings-control w-full rounded-xl px-3 py-2.5 text-sm">
        {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
      </select>
    </Dialog>
  );
};

const DetailDialog = ({ knowledgeBaseId, teams, onClose, onChanged, onOpenVersions }: {
  knowledgeBaseId: string;
  teams: GovernanceTeam[];
  onClose: () => void;
  onChanged: () => void;
  onOpenVersions: (id: string) => void;
}) => {
  const [detail, setDetail] = useState<KnowledgeBaseDetail | null>(null);
  const [grants, setGrants] = useState<KnowledgeBaseTeamGrant[]>([]);
  const [assignable, setAssignable] = useState<AssignableSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [addSourceId, setAddSourceId] = useState('');
  const [grantTeamId, setGrantTeamId] = useState('');
  const [uploads, setUploads] = useState<Array<{ name: string; status: string }>>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [d, g] = await Promise.all([fetchKnowledgeBase(knowledgeBaseId), fetchKnowledgeBaseTeams(knowledgeBaseId)]);
      setDetail(d);
      setGrants(g);
      if (d.permissions.canManage) {
        setAssignable((await fetchAssignableSources()).filter((source) => source.knowledgeBaseId !== knowledgeBaseId));
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Failed to load knowledge base');
    } finally {
      setLoading(false);
    }
  }, [knowledgeBaseId]);

  useEffect(() => { void reload(); }, [reload]);

  // While any member is still processing, quietly refresh the detail so status updates.
  const anyProcessing = (detail?.members || []).some((member) => isPendingIngestion(member.ingestionStatus));
  useEffect(() => {
    if (!anyProcessing) return undefined;
    const timer = setTimeout(() => { void fetchKnowledgeBase(knowledgeBaseId).then(setDetail).catch(() => undefined); }, 5000);
    return () => clearTimeout(timer);
  }, [anyProcessing, knowledgeBaseId, detail]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    for (const file of Array.from(files)) {
      setUploads((prev) => [...prev, { name: file.name, status: 'uploading' }]);
      const mark = (status: string) => setUploads((prev) => prev.map((u) => (u.name === file.name ? { ...u, status } : u)));
      try {
        const session = await createKnowledgeBaseUploadSession(knowledgeBaseId, file, {
          title: file.name,
          type: guessKnowledgeType(file.name),
          description: `Uploaded file ${file.name}`,
          metadata: { source: 'upload', uploadMode: 'direct' },
        });
        const controller = new AbortController();
        await putGlobalKnowledgeUpload(session, file, () => undefined, controller.signal);
        mark('finalizing');
        await completeKnowledgeBaseUpload(knowledgeBaseId, session.id);
        mark('queued');
      } catch (error) {
        mark('failed');
        setErr(error instanceof Error ? error.message : 'Upload failed');
      }
    }
    setTimeout(() => setUploads([]), 2500);
    await reload();
    onChanged();
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await reload();
      onChanged();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const canManage = detail?.permissions.canManage ?? false;
  const grantedTeamIds = new Set(grants.map((grant) => grant.teamId));
  const grantableTeams = teams.filter((team) => !grantedTeamIds.has(team.id));

  return (
    <Dialog
      title={detail?.name || 'Knowledge base'}
      subtitle={detail ? `${detail.slug}@${detail.currentVersion || '—'} · Owned by ${detail.ownerTeamName || 'Platform'}` : undefined}
      onClose={onClose}
      footer={detail ? (
        <>
          <button type="button" onClick={() => onOpenVersions(knowledgeBaseId)} className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold">
            <History size={16} /> Versions
          </button>
          {canManage ? (
            <button
              type="button"
              disabled={busy || !detail.hasUnpublishedChanges}
              title={detail.hasUnpublishedChanges ? undefined : 'No changes since the last published version'}
              onClick={() => void run(() => publishKnowledgeBase(knowledgeBaseId, {}))}
              className="settings-portal-button-primary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
              {detail.hasUnpublishedChanges ? 'Publish to team' : 'Published'}
            </button>
          ) : null}
        </>
      ) : undefined}
    >
      {loading || !detail ? (
        <SettingsLoadingState label="Loading base…" />
      ) : (
        <div className="space-y-6">
          {err ? <SettingsNotice variant="error">{err}</SettingsNotice> : null}
          <div className="flex items-center gap-2">
            <StatusBadge status={detail.status} />
            <span className="text-sm text-slate-500">{detail.description || 'No description provided.'}</span>
          </div>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Sources in this base ({detail.members.length})</h3>
              {detail.hasUnpublishedChanges && detail.status === 'published' ? (
                <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">Unpublished changes</span>
              ) : null}
            </div>
            {!detail.members.length ? (
              <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">No documents yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100">
                {detail.members.map((member) => (
                  <li key={member.knowledgeSourceId} className="flex items-center gap-3 px-3 py-2.5">
                    <FileText size={16} className="shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{member.title}</span>
                    {member.addedSincePublish && detail.status === 'published' ? (
                      <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">New</span>
                    ) : null}
                    {member.changedSincePublish ? (
                      <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">Updated</span>
                    ) : null}
                    {isPendingIngestion(member.ingestionStatus) ? (
                      <span className="shrink-0 inline-flex items-center gap-1 text-xs text-sky-600"><Loader2 size={12} className="animate-spin" />{member.ingestionStage || 'processing'}</span>
                    ) : member.published ? (
                      <CheckCircle2 size={15} className="shrink-0 text-emerald-500" />
                    ) : (
                      <span className="shrink-0 text-xs text-slate-400">not built</span>
                    )}
                    {canManage ? (
                      <button type="button" disabled={busy} onClick={() => void run(() => removeKnowledgeBaseSource(knowledgeBaseId, member.knowledgeSourceId))} className="shrink-0 text-slate-400 hover:text-red-600" aria-label="Remove source">
                        <Trash2 size={15} />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canManage ? (
              <label className="mt-3 flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center hover:border-slate-400">
                <UploadCloud size={20} className="text-slate-400" />
                <span className="text-sm font-medium text-slate-600">Upload documents into this base</span>
                <span className="text-xs text-slate-400">Each file is processed into OKF knowledge automatically.</span>
                <input type="file" multiple className="hidden" onChange={(event) => { const { files } = event.target; void handleUpload(files); event.target.value = ''; }} />
              </label>
            ) : null}
            {uploads.length ? (
              <ul className="mt-2 space-y-1">
                {uploads.map((upload) => (
                  <li key={upload.name} className="flex items-center gap-2 text-xs text-slate-500">
                    {upload.status === 'failed' ? <X size={12} className="text-red-500" /> : <Loader2 size={12} className="animate-spin" />}
                    <span className="truncate">{upload.name}</span>
                    <span className="ml-auto">{upload.status}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {canManage && assignable.length ? (
              <div className="mt-3 flex items-center gap-2">
                <select value={addSourceId} onChange={(event) => setAddSourceId(event.target.value)} className="settings-control min-w-0 flex-1 rounded-xl px-3 py-2 text-sm">
                  <option value="">Add an existing source…</option>
                  {assignable.map((source) => (
                    <option key={source.knowledgeSourceId} value={String(source.knowledgeSourceId)}>
                      {source.title}{source.knowledgeBaseName ? ` (in ${source.knowledgeBaseName})` : ''}
                    </option>
                  ))}
                </select>
                <button type="button" disabled={busy || !addSourceId} onClick={() => void run(async () => { await addKnowledgeBaseSource(knowledgeBaseId, Number(addSourceId)); setAddSourceId(''); })} className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold disabled:opacity-50">
                  <Plus size={15} /> Add
                </button>
              </div>
            ) : null}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">Team access ({grants.length})</h3>
            {!grants.length ? (
              <p className="text-sm text-slate-500">Not shared with any team yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {grants.map((grant) => (
                  <span key={grant.teamId} className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    {grant.teamName}
                    {canManage ? (
                      <button type="button" disabled={busy} onClick={() => void run(() => revokeKnowledgeBaseTeam(knowledgeBaseId, grant.teamId))} className="text-slate-400 hover:text-red-600" aria-label="Revoke">
                        <X size={12} />
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
            )}
            {canManage && grantableTeams.length ? (
              <div className="mt-3 flex items-center gap-2">
                <select value={grantTeamId} onChange={(event) => setGrantTeamId(event.target.value)} className="settings-control min-w-0 flex-1 rounded-xl px-3 py-2 text-sm">
                  <option value="">Grant a team…</option>
                  {grantableTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                </select>
                <button type="button" disabled={busy || !grantTeamId} onClick={() => void run(async () => { await grantKnowledgeBaseTeam(knowledgeBaseId, grantTeamId); setGrantTeamId(''); })} className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold disabled:opacity-50">
                  <Users2 size={15} /> Grant
                </button>
              </div>
            ) : null}
          </section>

          {canManage && !detail.isDefault ? (
            <button type="button" disabled={busy} onClick={() => void run(() => archiveKnowledgeBase(knowledgeBaseId))} className="text-sm font-medium text-red-600 hover:underline disabled:opacity-50">
              Archive this knowledge base
            </button>
          ) : null}
        </div>
      )}
    </Dialog>
  );
};

const VersionsDialog = ({ knowledgeBaseId, onClose }: { knowledgeBaseId: string; onClose: () => void }) => {
  const [versions, setVersions] = useState<KnowledgeBaseVersionEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try { setVersions(await fetchKnowledgeBaseVersions(knowledgeBaseId)); }
      catch (error) { setErr(error instanceof Error ? error.message : 'Failed to load versions'); }
    })();
  }, [knowledgeBaseId]);

  return (
    <Dialog title="Version history" subtitle="Published versions are content-addressed snapshots of the member sources." onClose={onClose} maxWidth="max-w-2xl">
      {err ? <SettingsNotice variant="error">{err}</SettingsNotice> : null}
      {!versions ? (
        <SettingsLoadingState label="Loading versions…" />
      ) : !versions.length ? (
        <SettingsEmptyState title="No versions yet" description="Publish this base to record its first version." icon={History} />
      ) : (
        <ol className="space-y-4">
          {versions.map((version) => (
            <li key={version.id} className="rounded-xl border border-slate-100 p-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold text-slate-900">v{version.version}</span>
                {version.isCurrent ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">Current</span> : null}
                <span className="ml-auto text-xs text-slate-400">{new Date(version.publishedAt).toLocaleString()}</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">{version.sourceCount} sources</p>
              <ul className="mt-2 space-y-1 text-sm">
                {version.changes.added.map((title) => <li key={`a-${title}`} className="text-emerald-700">+ {title}</li>)}
                {version.changes.updated.map((title) => <li key={`u-${title}`} className="text-amber-700">~ {title}</li>)}
                {version.changes.removed.map((title) => <li key={`r-${title}`} className="text-red-600">− {title}</li>)}
                {!version.changes.added.length && !version.changes.updated.length && !version.changes.removed.length ? (
                  <li className="text-slate-400">No source changes</li>
                ) : null}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
};

export default KnowledgeGovernancePage;

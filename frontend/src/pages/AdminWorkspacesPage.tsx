import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Pagination } from '@astryxdesign/core/Pagination';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table';
import {
  Archive,
  Eye,
  FileText,
  FolderOpen,
  Lock,
  MessagesSquare,
  Search,
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
} from '../components/settings/SettingsScaffold';
import {
  fetchAdminFileContent,
  fetchAdminWorkspaceConversations,
  fetchAdminWorkspaceDetail,
  fetchAdminWorkspaceFiles,
  fetchAdminWorkspaces,
  type AdminConversationSummary,
  type AdminFileContent,
  type AdminWorkspaceDetail,
  type AdminWorkspaceFile,
  type AdminWorkspaceSummary,
} from '../services/settingsApi';

type StatusFilter = 'all' | 'active' | 'trashed' | 'purged';

const PAGE_SIZE = 25;

const formatDate = (value?: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
};

const daysUntil = (value?: string | null) => {
  if (!value) return null;
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return null;
  return Math.max(0, Math.ceil((target - Date.now()) / (24 * 60 * 60 * 1000)));
};

/**
 * Only the exceptional statuses get a badge. Most workspaces are active, and a
 * green badge on every row is noise that makes the archived ones harder to spot.
 */
const statusVariant = (status: string): 'warning' | 'error' | 'neutral' | null => {
  if (status === 'trashed') return 'warning';
  if (status === 'purged') return 'error';
  if (status === 'active') return null;
  return 'neutral';
};

const AdminWorkspacesPage = () => {
  const [workspaces, setWorkspaces] = useState<AdminWorkspaceSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [openWorkspace, setOpenWorkspace] = useState<AdminWorkspaceSummary | null>(null);
  const [detail, setDetail] = useState<AdminWorkspaceDetail | null>(null);
  const [files, setFiles] = useState<AdminWorkspaceFile[]>([]);
  const [conversations, setConversations] = useState<AdminConversationSummary[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<AdminFileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAdminWorkspaces({
        page,
        pageSize: PAGE_SIZE,
        search: search || undefined,
        status: statusFilter === 'all' ? undefined : statusFilter,
        // Retired workspaces are hidden until asked for by name, so the default
        // view shows what is live rather than everything that ever existed.
        includePurged: statusFilter === 'purged',
      });
      setWorkspaces(result.workspaces);
      setTotal(result.total);
      setTotalPages(result.totalPages);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const handleOpenWorkspace = useCallback(async (workspace: AdminWorkspaceSummary) => {
    setOpenWorkspace(workspace);
    setDetail(null);
    setFiles([]);
    setConversations([]);
    setOpenFile(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const [detailResult, fileResult, conversationResult] = await Promise.all([
        fetchAdminWorkspaceDetail(workspace.id),
        fetchAdminWorkspaceFiles(workspace.id).catch(() => [] as AdminWorkspaceFile[]),
        fetchAdminWorkspaceConversations(workspace.id).catch(() => [] as AdminConversationSummary[]),
      ]);
      setDetail(detailResult);
      setFiles(fileResult);
      setConversations(conversationResult);
    } catch (openError) {
      setDetailError(openError instanceof Error ? openError.message : 'Failed to open workspace');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleOpenFile = useCallback(async (workspaceId: string, file: AdminWorkspaceFile) => {
    setFileLoading(true);
    try {
      setOpenFile(await fetchAdminFileContent(workspaceId, file.id));
    } catch (readError) {
      setDetailError(readError instanceof Error ? readError.message : 'Failed to read file');
    } finally {
      setFileLoading(false);
    }
  }, []);

  const columns = useMemo<TableColumn<AdminWorkspaceSummary>[]>(() => [
    {
      key: 'name',
      header: 'Workspace',
      width: proportional(2),
      renderCell: (workspace) => (
        <div className="flex min-w-0 items-center gap-3">
          <span className="settings-portal-icon-muted">
            {workspace.visibility === 'private' ? <Lock size={16} /> : <Users2 size={16} />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">{workspace.name}</p>
            <p className="truncate text-xs text-slate-500">
              {workspace.visibility === 'private' ? 'Private' : `Shared${workspace.teamName ? ` · ${workspace.teamName}` : ''}`}
              {' · '}
              {workspace.fileCount} files
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      width: proportional(1),
      renderCell: (workspace) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-slate-800">{workspace.ownerName || 'Unknown'}</p>
          <p className="truncate text-xs text-slate-500">
            {workspace.ownerStatus === 'deactivated' ? 'Deactivated' : workspace.ownerEmail || '—'}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: pixel(180),
      renderCell: (workspace) => {
        const remaining = daysUntil(workspace.purgeAfter);
        const variant = statusVariant(workspace.status);
        return (
          <div className="flex flex-col gap-1">
            {variant
              ? <Badge label={workspace.status === 'purged' ? 'Retired' : 'Archived'} variant={variant} />
              : <span className="text-sm text-slate-600">Active</span>}
            {workspace.status === 'trashed' && remaining !== null ? (
              <span className="text-xs text-slate-500">
                {remaining} days left
                {workspace.trashReason === 'owner_deactivated' ? ' · owner deactivated' : ''}
              </span>
            ) : null}
            {workspace.status === 'purged' ? (
              <span className="text-xs text-slate-500">Retained — restore via CLI</span>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      width: pixel(130),
      renderCell: (workspace) => <span className="text-sm text-slate-600">{formatDate(workspace.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      width: pixel(110),
      align: 'end',
      resizable: false,
      renderCell: (workspace) => (
        <Button
          label="View"
          variant="secondary"
          size="sm"
          icon={<Eye size={14} />}
          onClick={() => void handleOpenWorkspace(workspace)}
          tooltip="Open read-only"
        />
      ),
    },
  ], [handleOpenWorkspace]);

  return (
    <SettingsShell
      eyebrow="Governance"
      title="Workspaces"
      description="Every workspace on the platform, read-only. Opening one you are not a member of is recorded in the audit trail."
    >
      <div className="space-y-5">
        <SettingsNotice variant="info">
          This view is read-only by design. Nothing here can rename, edit, delete or share a
          workspace — those remain with its owner. Each time you open a workspace you do not
          belong to, an <code>admin.workspace.accessed</code> entry is written against your account.
        </SettingsNotice>

        <SettingsSurface>
          <SettingsSectionHeader
            title="All workspaces"
            description={`${total} total`}
            actions={(
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative">
                  <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    placeholder="Search name or owner"
                    aria-label="Search workspaces"
                    className="settings-portal-input h-9 rounded-xl pl-9 pr-3 text-sm"
                  />
                </div>
                <SegmentedControl
                  label="Filter workspaces by status"
                  value={statusFilter}
                  onChange={(value) => { setStatusFilter(value as StatusFilter); setPage(1); }}
                  size="sm"
                >
                  <SegmentedControlItem value="all" label="All" />
                  <SegmentedControlItem value="active" label="Active" />
                  <SegmentedControlItem value="trashed" label="Archived" />
                  <SegmentedControlItem value="purged" label="Retired" />
                </SegmentedControl>
              </div>
            )}
          />

          {error ? <SettingsNotice variant="error">{error}</SettingsNotice> : null}

          {loading ? (
            <SettingsLoadingState label="Loading workspaces..." />
          ) : workspaces.length ? (
            <>
              <Table columns={columns} data={workspaces} idKey="id" hasHover />
              {totalPages > 1 ? (
                <div className="mt-4 flex justify-end">
                  <Pagination page={page} totalPages={totalPages} onChange={setPage} />
                </div>
              ) : null}
            </>
          ) : (
            <SettingsEmptyState
              icon={FolderOpen}
              title="No workspaces match"
              description="Try a different search term or status filter."
            />
          )}
        </SettingsSurface>
      </div>

      {openWorkspace ? (
        <div className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center px-4">
          <div className="settings-modal-panel flex h-[min(90vh,900px)] w-full max-w-5xl flex-col rounded-[28px] p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="settings-section-eyebrow text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                  Read-only oversight
                </p>
                <h3 className="mt-2 truncate text-xl font-semibold text-slate-950">{openWorkspace.name}</h3>
                <p className="mt-1 text-sm text-slate-600">
                  Owned by {openWorkspace.ownerName || 'unknown'}
                  {openWorkspace.ownerEmail ? ` (${openWorkspace.ownerEmail})` : ''}
                  {' · '}
                  {openWorkspace.visibility === 'private' ? 'Private workspace' : 'Shared workspace'}
                </p>
              </div>
              <IconButton
                label="Close"
                variant="ghost"
                size="sm"
                icon={<X size={16} />}
                onClick={() => { setOpenWorkspace(null); setOpenFile(null); }}
              />
            </div>

            {detail?.viewingAsAdmin ? (
              <div className="mt-4">
                <SettingsNotice variant="warning">
                  You are viewing someone else&apos;s workspace under platform-admin override. This
                  access has been recorded. You cannot make changes here.
                </SettingsNotice>
              </div>
            ) : null}
            {detailError ? (
              <div className="mt-4"><SettingsNotice variant="error">{detailError}</SettingsNotice></div>
            ) : null}

            <div className="mt-5 min-h-0 flex-1 overflow-auto">
              {detailLoading ? (
                <SettingsLoadingState label="Opening workspace..." />
              ) : (
                <div className="grid gap-5 lg:grid-cols-2">
                  <section>
                    <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <FileText size={14} /> Files ({files.length})
                    </h4>
                    {files.length ? (
                      <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200">
                        {files.map((file) => (
                          <li key={file.id}>
                            <button
                              type="button"
                              onClick={() => void handleOpenFile(openWorkspace.id, file)}
                              className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                            >
                              <span className="truncate">{file.name}</span>
                              <span className="text-xs text-slate-400">{formatDate(file.updatedAt)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-slate-500">No files.</p>
                    )}
                  </section>

                  <section>
                    <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <MessagesSquare size={14} /> Conversations ({conversations.length})
                    </h4>
                    {conversations.length ? (
                      <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200">
                        {conversations.map((conversation) => (
                          <li key={conversation.id} className="px-4 py-2 text-sm text-slate-700">
                            <p className="truncate">{conversation.persona || 'Conversation'}</p>
                            <p className="text-xs text-slate-500">
                              {conversation.authorName || 'Unknown'} · {conversation.messageCount} messages
                            </p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-slate-500">No conversations.</p>
                    )}

                    <h4 className="mb-2 mt-5 flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <Users2 size={14} /> Collaborators ({detail?.collaborators.length || 0})
                    </h4>
                    <ul className="rounded-2xl border border-slate-200 divide-y divide-slate-200">
                      {(detail?.collaborators || []).map((collaborator) => (
                        <li key={collaborator.userId} className="flex items-center justify-between px-4 py-2 text-sm">
                          <span className="truncate text-slate-700">{collaborator.displayName}</span>
                          <Badge label={collaborator.role} variant="neutral" />
                        </li>
                      ))}
                    </ul>
                  </section>

                  {openFile ? (
                    <section className="lg:col-span-2">
                      <h4 className="mb-2 text-sm font-semibold text-slate-900">{openFile.name}</h4>
                      {openFile.encoding === 'text' ? (
                        <pre className="max-h-80 overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-800">
                          {openFile.content}
                        </pre>
                      ) : (
                        <SettingsNotice variant="info">
                          {openFile.mimeType} · {openFile.sizeBytes} bytes. Binary files are not
                          previewed here.
                        </SettingsNotice>
                      )}
                    </section>
                  ) : fileLoading ? (
                    <div className="lg:col-span-2"><SettingsLoadingState label="Reading file..." /></div>
                  ) : null}
                </div>
              )}
            </div>

            <div className="mt-5 flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-xs text-slate-500">
                <Archive size={12} />
                {openWorkspace.status === 'trashed' && openWorkspace.purgeAfter
                  ? `Archived — retires in ${daysUntil(openWorkspace.purgeAfter)} days`
                  : openWorkspace.status === 'purged'
                    ? 'Retired — data retained, restore via CLI'
                    : 'Active'}
              </span>
              <Button
                label="Close"
                variant="secondary"
                size="sm"
                onClick={() => { setOpenWorkspace(null); setOpenFile(null); }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </SettingsShell>
  );
};

export default AdminWorkspacesPage;

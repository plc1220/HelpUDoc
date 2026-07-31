import { useCallback, useEffect, useMemo, useState } from 'react';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { MultiSelector } from '@astryxdesign/core/MultiSelector';
import { Pagination } from '@astryxdesign/core/Pagination';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  BookOpen,
  KeyRound,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserRound,
  Users2,
  Wrench,
} from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
import {
  SettingsEmptyState,
  SettingsLoadingState,
  SettingsNotice,
  SettingsSectionHeader,
  SettingsSurface,
} from '../components/settings/SettingsScaffold';
import { getAuthUser } from '../auth/authStore';
import { fetchSlashMetadata } from '../services/agentApi';
import { listGlobalKnowledge } from '../services/knowledgeApi';
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  deleteUser,
  fetchGroupMembers,
  fetchGroupPromptAccess,
  fetchGroups,
  fetchUserDeletionImpact,
  fetchUserDirectory,
  fetchUsers,
  removeGroupMember,
  saveGroupPromptAccess,
  setUserAdmin,
  type GroupPromptAccess,
  type ManagedGroup,
  type ManagedUser,
  type UserDeletionImpact,
  type UserSortField,
  type UserSortOrder,
} from '../services/settingsApi';
import type { PluginDefinition, SkillDefinition } from '../types';
import { setTeamLead } from '../services/governanceApi';

type ManagementView = 'users' | 'groups';
type UserTableRow = ManagedUser & Record<string, unknown>;

type KnowledgeSourceOption = {
  id: number;
  title: string;
  type: string;
  isGlobal?: boolean;
  metadata?: Record<string, unknown> | null;
};

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');
const sortStrings = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b));
const sortNumbers = (values: number[]) => [...values].sort((a, b) => a - b);
const emptyAccess = (): GroupPromptAccess => ({ skillIds: [], mcpServerIds: [], knowledgeSourceIds: [] });

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const UsersPage = () => {
  const currentUser = getAuthUser();
  const [activeView, setActiveView] = useState<ManagementView>('users');

  const [users, setUsers] = useState<UserTableRow[]>([]);
  const [userDirectory, setUserDirectory] = useState<ManagedUser[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userPage, setUserPage] = useState(1);
  const [userPageSize, setUserPageSize] = useState(10);
  const [userSortBy, setUserSortBy] = useState<UserSortField>('displayName');
  const [userSortOrder, setUserSortOrder] = useState<UserSortOrder>('asc');
  const [userSearchInput, setUserSearchInput] = useState('');
  const [userSearch, setUserSearch] = useState('');

  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [groupMembers, setGroupMembers] = useState<ManagedUser[]>([]);
  const [groupAccess, setGroupAccess] = useState<GroupPromptAccess>(emptyAccess);
  const [savedGroupAccess, setSavedGroupAccess] = useState<GroupPromptAccess>(emptyAccess);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');

  const [availableSkills, setAvailableSkills] = useState<SkillDefinition[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = useState<Array<{ name: string; description?: string }>>([]);
  const [availablePlugins, setAvailablePlugins] = useState<PluginDefinition[]>([]);
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSourceOption[]>([]);

  const [pendingDeleteUser, setPendingDeleteUser] = useState<ManagedUser | null>(null);
  const [deletionImpact, setDeletionImpact] = useState<UserDeletionImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usersLoading, setUsersLoading] = useState(true);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessSaving, setAccessSaving] = useState(false);
  const [deletionImpactLoading, setDeletionImpactLoading] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) || null,
    [groups, selectedGroupId],
  );

  const selectableUsers = useMemo(
    () => userDirectory.filter((user) => !groupMembers.some((member) => member.id === user.id)),
    [groupMembers, userDirectory],
  );

  const visiblePlugins = useMemo(
    () => availablePlugins.filter((plugin) => plugin.skillIds.length > 0),
    [availablePlugins],
  );

  const knowledgeOptions = useMemo(
    () => knowledgeSources
      .filter((source) => source.isGlobal)
      .map((source) => ({ value: String(source.id), label: source.title })),
    [knowledgeSources],
  );

  const skillOptions = useMemo(
    () => availableSkills.map((skill) => ({
      value: skill.id,
      label: skill.name || skill.id,
    })),
    [availableSkills],
  );

  const mcpOptions = useMemo(
    () => availableMcpServers.map((server) => ({
      value: server.name,
      label: server.name,
    })),
    [availableMcpServers],
  );

  const isAccessDirty = useMemo(() => (
    JSON.stringify(sortStrings(groupAccess.skillIds)) !== JSON.stringify(sortStrings(savedGroupAccess.skillIds))
      || JSON.stringify(sortStrings(groupAccess.mcpServerIds)) !== JSON.stringify(sortStrings(savedGroupAccess.mcpServerIds))
      || JSON.stringify(sortNumbers(groupAccess.knowledgeSourceIds)) !== JSON.stringify(sortNumbers(savedGroupAccess.knowledgeSourceIds))
  ), [groupAccess, savedGroupAccess]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setUserSearch(userSearchInput.trim());
      setUserPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [userSearchInput]);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const result = await fetchUsers({
        page: userPage,
        pageSize: userPageSize,
        sortBy: userSortBy,
        sortOrder: userSortOrder,
        search: userSearch,
      });
      setUsers(result.users as UserTableRow[]);
      setUserTotal(result.total);
      if (result.page !== userPage) setUserPage(result.page);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setUsersLoading(false);
    }
  }, [userPage, userPageSize, userSearch, userSortBy, userSortOrder]);

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true);
    try {
      const [loadedGroups, directory] = await Promise.all([fetchGroups(), fetchUserDirectory()]);
      setGroups(loadedGroups);
      setUserDirectory(directory);
      setSelectedGroupId((current) => {
        if (current && loadedGroups.some((group) => group.id === current)) return current;
        return loadedGroups[0]?.id || '';
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load teams');
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  const loadAccessCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const [promptCatalog, knowledge] = await Promise.all([
        fetchSlashMetadata(),
        listGlobalKnowledge(),
      ]);
      setAvailableSkills(promptCatalog.skills);
      setAvailableMcpServers(promptCatalog.mcpServers);
      setAvailablePlugins(promptCatalog.plugins || []);
      setKnowledgeSources(Array.isArray(knowledge) ? knowledge : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load access catalog');
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const loadGroupDetails = useCallback(async (groupId: string) => {
    if (!groupId) {
      setGroupMembers([]);
      setGroupAccess(emptyAccess());
      setSavedGroupAccess(emptyAccess());
      return;
    }
    setAccessLoading(true);
    try {
      const [members, access] = await Promise.all([
        fetchGroupMembers(groupId),
        fetchGroupPromptAccess(groupId),
      ]);
      const normalized: GroupPromptAccess = {
        skillIds: sortStrings(access.skillIds),
        mcpServerIds: sortStrings(access.mcpServerIds),
        knowledgeSourceIds: sortNumbers(access.knowledgeSourceIds || []),
      };
      setGroupMembers(members);
      setGroupAccess(normalized);
      setSavedGroupAccess(normalized);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load team details');
    } finally {
      setAccessLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    void loadGroups();
    void loadAccessCatalog();
  }, [loadAccessCatalog, loadGroups]);

  useEffect(() => {
    void loadGroupDetails(selectedGroupId);
  }, [loadGroupDetails, selectedGroupId]);

  const handleToggleAdmin = async (user: ManagedUser) => {
    try {
      const updated = await setUserAdmin(user.id, !user.isAdmin);
      setUsers((previous) => previous.map((entry) => (entry.id === updated.id ? { ...entry, ...updated } : entry)));
      setUserDirectory((previous) => previous.map((entry) => (entry.id === updated.id ? updated : entry)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update admin role');
    }
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;
    try {
      const created = await createGroup(newGroupName.trim());
      setGroups((previous) => [...previous, created].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedGroupId(created.id);
      setNewGroupName('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create team');
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!window.confirm(`Delete team "${selectedGroup?.name || 'this team'}"?`)) return;
    try {
      await deleteGroup(groupId);
      const remaining = groups.filter((group) => group.id !== groupId);
      setGroups(remaining);
      setSelectedGroupId(remaining[0]?.id || '');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete team');
    }
  };

  const handleAddMember = async () => {
    if (!selectedGroupId || !selectedUserId) return;
    try {
      await addGroupMember(selectedGroupId, selectedUserId);
      setSelectedUserId('');
      await loadGroupDetails(selectedGroupId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!selectedGroupId) return;
    try {
      await removeGroupMember(selectedGroupId, userId);
      await loadGroupDetails(selectedGroupId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const handleToggleTeamLead = async (member: ManagedUser) => {
    if (!selectedGroupId) return;
    try {
      await setTeamLead(selectedGroupId, member.id, !member.isTeamLead);
      await loadGroupDetails(selectedGroupId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update Team Lead');
    }
  };

  const handleSaveGroupAccess = async () => {
    if (!selectedGroupId) return;
    setAccessSaving(true);
    try {
      const saved = await saveGroupPromptAccess(selectedGroupId, {
        skillIds: sortStrings(groupAccess.skillIds),
        mcpServerIds: sortStrings(groupAccess.mcpServerIds),
        knowledgeSourceIds: sortNumbers(groupAccess.knowledgeSourceIds),
      });
      const normalized: GroupPromptAccess = {
        skillIds: sortStrings(saved.skillIds),
        mcpServerIds: sortStrings(saved.mcpServerIds),
        knowledgeSourceIds: sortNumbers(saved.knowledgeSourceIds || []),
      };
      setGroupAccess(normalized);
      setSavedGroupAccess(normalized);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save team access');
    } finally {
      setAccessSaving(false);
    }
  };

  const handleOpenDeleteModal = async (user: ManagedUser) => {
    setPendingDeleteUser(user);
    setDeletionImpact(null);
    setDeletionImpactLoading(true);
    try {
      setDeletionImpact(await fetchUserDeletionImpact(user.id));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deletion impact');
    } finally {
      setDeletionImpactLoading(false);
    }
  };

  const handleConfirmDeleteUser = async () => {
    if (!pendingDeleteUser) return;
    setDeletingUserId(pendingDeleteUser.id);
    try {
      await deleteUser(pendingDeleteUser.id);
      setPendingDeleteUser(null);
      setDeletionImpact(null);
      await Promise.all([loadUsers(), loadGroups()]);
      if (selectedGroupId) await loadGroupDetails(selectedGroupId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      setDeletingUserId(null);
    }
  };

  const togglePluginBundle = (plugin: PluginDefinition) => {
    setGroupAccess((previous) => {
      const selected = plugin.skillIds.every((id) => previous.skillIds.includes(id))
        && plugin.mcpServers.every((id) => previous.mcpServerIds.includes(id));
      return selected
        ? {
            ...previous,
            skillIds: previous.skillIds.filter((id) => !plugin.skillIds.includes(id)),
            mcpServerIds: previous.mcpServerIds.filter((id) => !plugin.mcpServers.includes(id)),
          }
        : {
            ...previous,
            skillIds: sortStrings(Array.from(new Set([...previous.skillIds, ...plugin.skillIds]))),
            mcpServerIds: sortStrings(Array.from(new Set([...previous.mcpServerIds, ...plugin.mcpServers]))),
          };
    });
  };

  const userColumns = useMemo<TableColumn<UserTableRow>[]>(() => [
    {
      key: 'displayName',
      header: 'User',
      width: proportional(2),
      renderCell: (user) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={user.displayName} size="small" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">{user.displayName}</p>
            <p className="truncate text-xs text-slate-500">{user.email || user.externalId}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'isAdmin',
      header: 'Role',
      width: pixel(150),
      renderCell: (user) => (
        <button
          type="button"
          onClick={() => void handleToggleAdmin(user)}
          className={cx(
            'inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition',
            user.isAdmin
              ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
          )}
        >
          {user.isAdmin ? <ShieldCheck size={14} /> : <ShieldOff size={14} />}
          {user.isAdmin ? 'Admin' : 'Member'}
        </button>
      ),
    },
    {
      key: 'createdAt',
      header: 'Joined',
      width: pixel(150),
      renderCell: (user) => <span className="text-sm text-slate-600">{formatDate(user.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      width: pixel(120),
      align: 'end',
      resizable: false,
      renderCell: (user) => {
        const isCurrentUser = currentUser?.id === user.id;
        const isDeleting = deletingUserId === user.id;
        return (
          <button
            type="button"
            disabled={isCurrentUser || isDeleting}
            onClick={() => void handleOpenDeleteModal(user)}
            className={cx(
              'inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition',
              isCurrentUser || isDeleting
                ? 'cursor-not-allowed bg-slate-100 text-slate-400'
                : 'bg-rose-50 text-rose-700 hover:bg-rose-100',
            )}
            title={isCurrentUser ? 'Self-delete is blocked in the admin portal' : 'Delete user'}
          >
            {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete
          </button>
        );
      },
    },
  ], [currentUser?.id, deletingUserId]);

  return (
    <SettingsShell
      eyebrow="Identity & access"
      title="User & Team Management"
      description="Manage people, organize teams, and control access to shared knowledge, skills, and connected tools."
      actions={(
        <SegmentedControl
          value={activeView}
          onChange={(value) => setActiveView(value as ManagementView)}
          label="Management view"
          size="sm"
        >
          <SegmentedControlItem value="users" label="Users" icon={<UserRound size={15} />} />
          <SegmentedControlItem value="groups" label="Teams" icon={<Users2 size={15} />} />
        </SegmentedControl>
      )}
    >
      <div className="space-y-6">
        {error ? <SettingsNotice variant="error">{error}</SettingsNotice> : null}

        {activeView === 'users' ? (
          <SettingsSurface>
            <SettingsSectionHeader
              eyebrow="Directory"
              title="Users"
              description="Search the directory, sort user records, manage administrator roles, and remove accounts."
              actions={<span className="text-sm font-medium text-slate-500">{userTotal} total</span>}
            />

            <div className="settings-soft-panel mt-6 flex flex-col gap-3 rounded-2xl p-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative min-w-0 flex-1 lg:max-w-md">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={userSearchInput}
                  onChange={(event) => setUserSearchInput(event.target.value)}
                  placeholder="Search name, email, or external ID"
                  className="settings-control w-full rounded-xl py-2.5 pl-10 pr-3 text-sm"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Sort by</span>
                <select
                  value={userSortBy}
                  onChange={(event) => {
                    setUserSortBy(event.target.value as UserSortField);
                    setUserPage(1);
                  }}
                  className="settings-control rounded-xl px-3 py-2.5 text-sm"
                >
                  <option value="displayName">Name</option>
                  <option value="email">Email</option>
                  <option value="role">Role</option>
                  <option value="createdAt">Date joined</option>
                </select>
                <button
                  type="button"
                  onClick={() => {
                    setUserSortOrder((order) => (order === 'asc' ? 'desc' : 'asc'));
                    setUserPage(1);
                  }}
                  className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium"
                >
                  {userSortOrder === 'asc' ? <ArrowDownAZ size={16} /> : <ArrowUpAZ size={16} />}
                  {userSortOrder === 'asc' ? 'Ascending' : 'Descending'}
                </button>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200">
              {usersLoading ? <SettingsLoadingState label="Loading users..." /> : null}
              {!usersLoading && users.length === 0 ? (
                <SettingsEmptyState
                  title={userSearch ? 'No matching users' : 'No users found'}
                  description={userSearch ? 'Try a different search term.' : 'Users appear after authentication or provisioning.'}
                  icon={Users2}
                />
              ) : null}
              {!usersLoading && users.length > 0 ? (
                <Table
                  data={users}
                  columns={userColumns}
                  idKey="id"
                  density="balanced"
                  dividers="rows"
                  hasHover
                  textOverflow="truncate"
                />
              ) : null}
            </div>

            {userTotal > 0 ? (
              <div className="mt-5 border-t border-slate-200 pt-5">
                <Pagination
                  page={userPage}
                  onChange={setUserPage}
                  totalItems={userTotal}
                  pageSize={userPageSize}
                  pageSizeOptions={[10, 25, 50]}
                  onPageSizeChange={(size) => {
                    setUserPageSize(size);
                    setUserPage(1);
                  }}
                  variant="pages"
                  size="sm"
                  isDisabled={usersLoading}
                  label="User directory pages"
                />
              </div>
            ) : null}
          </SettingsSurface>
        ) : (
          <div className="grid gap-6 md:grid-cols-[280px_minmax(0,1fr)]">
            <SettingsSurface className="h-fit">
              <SettingsSectionHeader
                eyebrow="Teams"
                title="Teams"
                description="Select a team to manage membership and access."
                actions={<Badge variant="neutral" label={String(groups.length)} />}
              />

              <div className="mt-5 flex gap-2">
                <input
                  value={newGroupName}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleCreateGroup();
                  }}
                  placeholder="New team name"
                  className="settings-control min-w-0 flex-1 rounded-xl px-3 py-2.5 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void handleCreateGroup()}
                  className="settings-button-primary inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                  aria-label="Create team"
                  title="Create team"
                >
                  <Plus size={16} />
                </button>
              </div>

              <div className="mt-4 max-h-80 space-y-2 overflow-y-auto pr-1 md:max-h-[calc(100vh-22rem)]">
                {groupsLoading ? <SettingsLoadingState label="Loading teams..." /> : null}
                {!groupsLoading && groups.length === 0 ? (
                  <SettingsEmptyState
                    title="No teams yet"
                    description="Create a team to assign members and access."
                    icon={Users2}
                    align="left"
                  />
                ) : null}
                {!groupsLoading && groups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => setSelectedGroupId(group.id)}
                    className={cx(
                      'settings-selection-card flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition',
                      selectedGroupId === group.id && 'settings-selection-card-active',
                    )}
                  >
                    <span className="truncate text-sm font-semibold text-slate-900">{group.name}</span>
                    {selectedGroupId === group.id ? <span className="text-xs font-medium text-blue-600">Selected</span> : null}
                  </button>
                ))}
              </div>
            </SettingsSurface>

            <div className="min-w-0 space-y-6">
              {!selectedGroup ? (
                <SettingsSurface>
                  <SettingsEmptyState
                    title="Select a team"
                    description="Choose a team from the list to manage its members and access."
                    icon={Users2}
                  />
                </SettingsSurface>
              ) : (
                <>
                  <SettingsSurface>
                    <SettingsSectionHeader
                      eyebrow="Selected team"
                      title={selectedGroup.name}
                      description={`${groupMembers.length} member${groupMembers.length === 1 ? '' : 's'} · access is inherited by every team member`}
                      actions={(
                        <button
                          type="button"
                          onClick={() => void handleDeleteGroup(selectedGroup.id)}
                          className="inline-flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100"
                        >
                          <Trash2 size={14} />
                          Delete team
                        </button>
                      )}
                    />

                    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">Add member</p>
                        <p className="mt-1 text-xs text-slate-500">Members inherit the union of access from every team they belong to.</p>
                        <div className="mt-3 flex gap-2">
                          <select
                            value={selectedUserId}
                            onChange={(event) => setSelectedUserId(event.target.value)}
                            className="settings-control min-w-0 flex-1 rounded-xl px-3 py-2.5 text-sm"
                          >
                            <option value="">Select user</option>
                            {selectableUsers.map((user) => (
                              <option key={user.id} value={user.id}>{user.displayName}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => void handleAddMember()}
                            disabled={!selectedUserId}
                            className="settings-button-primary rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                          >
                            Add
                          </button>
                        </div>
                      </div>

                      <div>
                        <p className="text-sm font-semibold text-slate-900">Current members</p>
                        <div className="mt-3 max-h-60 space-y-2 overflow-y-auto">
                          {accessLoading ? <SettingsLoadingState label="Loading members..." /> : null}
                          {!accessLoading && groupMembers.length === 0 ? (
                            <SettingsEmptyState
                              title="No members"
                              description="Add the first member to this team."
                              align="left"
                            />
                          ) : null}
                          {!accessLoading && groupMembers.map((member) => (
                            <div key={member.id} className="settings-selection-card flex items-center justify-between gap-3 rounded-2xl px-3 py-2.5">
                              <div className="flex min-w-0 items-center gap-3">
                                <Avatar name={member.displayName} size="xsmall" />
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-slate-900">{member.displayName}</p>
                                  <p className="truncate text-xs text-slate-500">{member.email || member.externalId}</p>
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => void handleToggleTeamLead(member)}
                                  className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold ${
                                    member.isTeamLead
                                      ? 'bg-emerald-50 text-emerald-700'
                                      : 'bg-slate-100 text-slate-600'
                                  }`}
                                >
                                  <ShieldCheck size={13} />
                                  {member.isTeamLead ? 'Team Lead' : 'Make lead'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleRemoveMember(member.id)}
                                  className="text-xs font-semibold text-rose-600 hover:text-rose-700"
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </SettingsSurface>

                  <SettingsSurface>
                    <SettingsSectionHeader
                      eyebrow="Access control"
                      title="Knowledge, skills & tools"
                      description="Choose what members of this team can use. System administrators bypass these grants."
                      actions={(
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setGroupAccess(savedGroupAccess)}
                            disabled={!isAccessDirty || accessSaving}
                            className="settings-portal-button-secondary rounded-xl px-3 py-2 text-xs font-semibold disabled:opacity-50"
                          >
                            Reset
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleSaveGroupAccess()}
                            disabled={!isAccessDirty || accessSaving}
                            className="settings-button-primary inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold disabled:opacity-50"
                          >
                            {accessSaving ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                            Save access
                          </button>
                        </div>
                      )}
                    />

                    {catalogLoading || accessLoading ? (
                      <div className="mt-6">
                        <SettingsLoadingState label="Loading access controls..." />
                      </div>
                    ) : (
                      <div className="mt-6 space-y-6">
                        <div className="grid gap-4 md:grid-cols-3">
                          <div className="settings-soft-panel rounded-2xl p-4">
                            <BookOpen size={18} className="text-blue-600" />
                            <p className="mt-3 text-2xl font-semibold text-slate-950">{groupAccess.knowledgeSourceIds.length}</p>
                            <p className="text-xs text-slate-500">Knowledge sources</p>
                          </div>
                          <div className="settings-soft-panel rounded-2xl p-4">
                            <Wrench size={18} className="text-violet-600" />
                            <p className="mt-3 text-2xl font-semibold text-slate-950">{groupAccess.skillIds.length}</p>
                            <p className="text-xs text-slate-500">Skills</p>
                          </div>
                          <div className="settings-soft-panel rounded-2xl p-4">
                            <KeyRound size={18} className="text-emerald-600" />
                            <p className="mt-3 text-2xl font-semibold text-slate-950">{groupAccess.mcpServerIds.length}</p>
                            <p className="text-xs text-slate-500">MCP servers</p>
                          </div>
                        </div>

                        <div className="grid gap-5 lg:grid-cols-3">
                          <MultiSelector
                            label="Knowledge sources"
                            description="Shared sources this team can reference from any workspace."
                            options={knowledgeOptions}
                            value={groupAccess.knowledgeSourceIds.map(String)}
                            onChange={(values) => setGroupAccess((previous) => ({
                              ...previous,
                              knowledgeSourceIds: sortNumbers(values.map(Number)),
                            }))}
                            placeholder="No knowledge access"
                            triggerDisplay="count"
                            hasSearch
                            hasSelectAll
                            searchPlaceholder="Search knowledge"
                            isDisabled={!knowledgeOptions.length}
                            disabledMessage="Add shared knowledge sources from the Knowledge page first."
                          />
                          <MultiSelector
                            label="Skills"
                            description="Skills exposed in prompting and slash commands."
                            options={skillOptions}
                            value={groupAccess.skillIds}
                            onChange={(values) => setGroupAccess((previous) => ({
                              ...previous,
                              skillIds: sortStrings(values),
                            }))}
                            placeholder="No skill access"
                            triggerDisplay="count"
                            hasSearch
                            hasSelectAll
                            searchPlaceholder="Search skills"
                          />
                          <MultiSelector
                            label="MCP servers"
                            description="Connected tools the team may target."
                            options={mcpOptions}
                            value={groupAccess.mcpServerIds}
                            onChange={(values) => setGroupAccess((previous) => ({
                              ...previous,
                              mcpServerIds: sortStrings(values),
                            }))}
                            placeholder="No tool access"
                            triggerDisplay="count"
                            hasSearch
                            hasSelectAll
                            searchPlaceholder="Search servers"
                          />
                        </div>

                        {visiblePlugins.length > 0 ? (
                          <div>
                            <div className="flex items-end justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-slate-900">Plugin bundles</p>
                                <p className="mt-1 text-xs text-slate-500">Apply related skill and MCP grants together.</p>
                              </div>
                            </div>
                            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                              {visiblePlugins.map((plugin) => {
                                const selected = plugin.skillIds.every((id) => groupAccess.skillIds.includes(id))
                                  && plugin.mcpServers.every((id) => groupAccess.mcpServerIds.includes(id));
                                return (
                                  <button
                                    key={plugin.id}
                                    type="button"
                                    onClick={() => togglePluginBundle(plugin)}
                                    className={cx(
                                      'settings-selection-card rounded-2xl px-4 py-3 text-left transition',
                                      selected && 'settings-selection-card-active',
                                    )}
                                  >
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="truncate text-sm font-semibold text-slate-900">{plugin.displayName}</p>
                                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{plugin.description || plugin.id}</p>
                                      </div>
                                      {selected ? <Badge variant="blue" label="Applied" /> : null}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </SettingsSurface>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {pendingDeleteUser ? (
        <div className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center px-4">
          <div className="settings-modal-panel w-full max-w-2xl rounded-[28px] p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-rose-500">Destructive action</p>
                <h3 className="mt-2 text-xl font-semibold text-slate-950">Delete {pendingDeleteUser.displayName}?</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  This removes the account, deletes owned workspaces, and detaches authorship metadata from shared records.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPendingDeleteUser(null);
                  setDeletionImpact(null);
                }}
                className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              >
                Close
              </button>
            </div>

            <div className="mt-5 space-y-3">
              {deletionImpactLoading ? <SettingsLoadingState label="Loading deletion impact..." /> : null}
              {!deletionImpactLoading && deletionImpact ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                    <p className="font-semibold">{deletionImpact.ownedWorkspaces.length} owned workspaces will be deleted</p>
                    <p className="mt-1 text-xs">
                      {deletionImpact.ownedWorkspaces.length
                        ? deletionImpact.ownedWorkspaces.map((workspace) => workspace.name).join(', ')
                        : 'No owned workspaces'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    <p className="font-semibold">{deletionImpact.sharedWorkspaceCount} shared memberships removed</p>
                    <p className="mt-1 text-xs">{deletionImpact.groupMembershipCount} team memberships and {deletionImpact.oauthTokenCount} OAuth tokens</p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    <p className="font-semibold">Detached shared references</p>
                    <p className="mt-1 text-xs">{deletionImpact.authoredFileCount} files, {deletionImpact.authoredKnowledgeCount} knowledge items</p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    <p className="font-semibold">Detached conversation history</p>
                    <p className="mt-1 text-xs">{deletionImpact.authoredConversationCount} conversations, {deletionImpact.authoredMessageCount} messages</p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setPendingDeleteUser(null);
                  setDeletionImpact(null);
                }}
                className="settings-portal-button-secondary rounded-2xl px-4 py-2.5 text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDeleteUser()}
                disabled={deletionImpactLoading || deletingUserId === pendingDeleteUser.id}
                className="settings-button-danger-solid inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {deletingUserId === pendingDeleteUser.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                Delete user
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </SettingsShell>
  );
};

export default UsersPage;

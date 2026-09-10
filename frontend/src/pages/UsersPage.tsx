import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { MultiSelector } from '@astryxdesign/core/MultiSelector';
import { Pagination } from '@astryxdesign/core/Pagination';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Plus,
  Search,
  Trash2,
  UserRound,
  Users2,
  X,
} from 'lucide-react';
import './UsersPage.css';
import SettingsShell from '../components/settings/SettingsShell';
import {
  SettingsEmptyState,
  SettingsLoadingState,
  SettingsNotice,
  SettingsSectionHeader,
  SettingsSurface,
} from '../components/settings/SettingsScaffold';
import { getAuthUser } from '../auth/authStore';
import { fetchKnowledgeBaseCatalog, type KnowledgeBaseSummary } from '../services/knowledgeBaseApi';
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  deleteUser,
  fetchGroupMembers,
  fetchGroupPromptAccess,
  fetchGroups,
  fetchRuntimeCapabilityCatalog,
  fetchSkills,
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
import { fetchSkillCatalog, setTeamLead } from '../services/governanceApi';

type ManagementView = 'users' | 'groups';
type UserTableRow = ManagedUser & Record<string, unknown>;

type KnowledgeBaseOption = KnowledgeBaseSummary;

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');
const sortStrings = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b));
const emptyAccess = (): GroupPromptAccess => ({ skillIds: [], mcpServerIds: [], knowledgeBaseIds: [] });

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const UsersPage = () => {
  const currentUser = getAuthUser();
  const navigate = useNavigate();
  const [confirmation, setConfirmation] = useState<{
    title: string; description: string; actionLabel: string; resolve: (accepted: boolean) => void;
  } | null>(null);
  const confirmAction = useCallback((title: string, description: string, actionLabel: string) => (
    new Promise<boolean>((resolve) => setConfirmation({ title, description, actionLabel, resolve }))
  ), []);
  const resolveConfirmation = (accepted: boolean) => {
    confirmation?.resolve(accepted);
    setConfirmation(null);
  };
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
  const [teamSearch, setTeamSearch] = useState('');
  const [isCreatingTeam, setIsCreatingTeam] = useState(false);
  const [isAddingMember, setIsAddingMember] = useState(false);
  const [groupCreating, setGroupCreating] = useState(false);
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);
  const [memberUpdating, setMemberUpdating] = useState(false);
  const detailRequest = useRef(0);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');

  const [availableSkills, setAvailableSkills] = useState<SkillDefinition[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = useState<Array<{ name: string; description?: string }>>([]);
  const [availablePlugins, setAvailablePlugins] = useState<PluginDefinition[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseOption[]>([]);

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
    () => availablePlugins.filter((plugin) => plugin.skillIds.length > 0 || plugin.mcpServers.length > 0),
    [availablePlugins],
  );

  const pluginBundleAvailability = useMemo(() => {
    const skillIds = new Set(availableSkills.map((skill) => skill.id));
    const mcpServerIds = new Set(availableMcpServers.map((server) => server.name));
    return new Map(visiblePlugins.map((plugin) => {
      const missingSkillIds = plugin.skillIds.filter((id) => !skillIds.has(id));
      const missingMcpServerIds = plugin.mcpServers.filter((id) => !mcpServerIds.has(id));
      return [plugin.id, {
        assignable: plugin.valid && missingSkillIds.length === 0 && missingMcpServerIds.length === 0,
        missingSkillIds,
        missingMcpServerIds,
      }];
    }));
  }, [availableMcpServers, availableSkills, visiblePlugins]);

  const knowledgeOptions = useMemo(
    () => knowledgeBases
      .filter((base) => base.status === 'published')
      .map((base) => ({ value: base.id, label: base.name })),
    [knowledgeBases],
  );

  const skillOptions = useMemo(
    () => availableSkills.map((skill) => ({
      value: skill.id,
      disabled: skill.valid === false,
      label: `${skill.name || skill.id}${
        skill.pluginName
          ? ` · ${skill.pluginName} plugin`
          : skill.warning
            ? ` · ${skill.warning}`
            : ''
      }`,
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
      || JSON.stringify(sortStrings(groupAccess.knowledgeBaseIds)) !== JSON.stringify(sortStrings(savedGroupAccess.knowledgeBaseIds))
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
      const [runtimeSkills, governedCatalog, knowledgeBasesCatalog, runtimeCatalog] = await Promise.all([
        fetchSkills(),
        fetchSkillCatalog(),
        fetchKnowledgeBaseCatalog(),
        fetchRuntimeCapabilityCatalog(),
      ]);
      const skillsById = new Map<string, SkillDefinition>();
      runtimeSkills.forEach((skill) => skillsById.set(skill.id, skill));
      governedCatalog.skills.forEach((skill) => skillsById.set(skill.skillKey, {
        id: skill.skillKey,
        name: skill.displayName,
        description: skill.description || undefined,
        valid: skill.status === 'active' && skill.defaultVersionStatus === 'active',
        warning: skill.status === 'active'
          ? `Team skill owned by ${skill.ownerTeamName}`
          : `Team skill is ${skill.status}`,
      }));
      setAvailableSkills([...skillsById.values()].sort((left, right) => left.name.localeCompare(right.name)));
      setAvailableMcpServers(runtimeCatalog.mcpServers);
      setAvailablePlugins(runtimeCatalog.plugins || []);
      setKnowledgeBases(Array.isArray(knowledgeBasesCatalog) ? knowledgeBasesCatalog : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load access catalog');
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const loadGroupDetails = useCallback(async (groupId: string) => {
    const request = ++detailRequest.current;
    setGroupMembers([]);
    setGroupAccess(emptyAccess());
    setSavedGroupAccess(emptyAccess());
    if (!groupId) {
      setAccessLoading(false);
      return;
    }
    setAccessLoading(true);
    try {
      const [members, access] = await Promise.all([
        fetchGroupMembers(groupId),
        fetchGroupPromptAccess(groupId),
      ]);
      if (request !== detailRequest.current) return;
      const normalized: GroupPromptAccess = {
        skillIds: sortStrings(access.skillIds),
        mcpServerIds: sortStrings(access.mcpServerIds),
        knowledgeBaseIds: sortStrings(access.knowledgeBaseIds || []),
      };
      setGroupMembers(members);
      setGroupAccess(normalized);
      setSavedGroupAccess(normalized);
      setError(null);
    } catch (err) {
      if (request === detailRequest.current) {
        setError(err instanceof Error ? err.message : 'Failed to load team details');
      }
    } finally {
      if (request === detailRequest.current) setAccessLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAccessDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    const confirmLinkNavigation = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.getAttribute('href') === window.location.pathname || event.defaultPrevented
        || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || anchor.target === '_blank'
        || anchor.origin !== window.location.origin) return;
      event.preventDefault();
      event.stopPropagation();
      void confirmAction('Discard unsaved changes?', 'Your team access changes have not been saved.', 'Discard changes').then((accepted) => {
        if (accepted) navigate(`${anchor.pathname}${anchor.search}${anchor.hash}`);
      });
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    document.addEventListener('click', confirmLinkNavigation, true);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload);
      document.removeEventListener('click', confirmLinkNavigation, true);
    };
  }, [confirmAction, isAccessDirty, navigate]);

  const canLeaveTeam = async () => !accessSaving && !memberUpdating && !groupCreating && !deletingGroupId
    && (!isAccessDirty || await confirmAction('Discard unsaved changes?', 'Your team access changes have not been saved.', 'Discard changes'));

  const selectTeam = async (groupId: string) => {
    if (groupId === selectedGroupId || !(await canLeaveTeam())) return;
    setSelectedGroupId(groupId);
    setSelectedUserId('');
    setIsAddingMember(false);
  };

  const changeView = async (value: string) => {
    if (value === activeView || !(await canLeaveTeam())) return;
    setGroupAccess(savedGroupAccess);
    setActiveView(value as ManagementView);
  };

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
    if (!newGroupName.trim() || groupCreating || !(await canLeaveTeam())) return;
    setGroupCreating(true);
    try {
      const created = await createGroup(newGroupName.trim());
      setGroups((previous) => [...previous, created].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedGroupId(created.id);
      setNewGroupName('');
      setTeamSearch('');
      setIsCreatingTeam(false);
      setIsAddingMember(false);
      setSelectedUserId('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create team');
    } finally {
      setGroupCreating(false);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    const group = groups.find((entry) => entry.id === groupId);
    if (!group || deletingGroupId || accessSaving || memberUpdating || groupCreating) return;
    const unsaved = groupId === selectedGroupId && isAccessDirty ? ' Unsaved access changes will be discarded.' : '';
    if (!(await confirmAction(`Delete team “${group.name}”?`, `This removes the team and its membership and access assignments.${unsaved}`, 'Delete team'))) return;
    setDeletingGroupId(groupId);
    try {
      await deleteGroup(groupId);
      const remaining = groups.filter((group) => group.id !== groupId);
      setGroups(remaining);
      if (selectedGroupId === groupId) {
        setSelectedGroupId(remaining[0]?.id || '');
        setSelectedUserId('');
        setIsAddingMember(false);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete team');
    } finally {
      setDeletingGroupId(null);
    }
  };

  const handleAddMember = async () => {
    if (!selectedGroupId || !selectedUserId || memberUpdating || accessLoading || deletingGroupId || groupCreating) return;
    setMemberUpdating(true);
    try {
      await addGroupMember(selectedGroupId, selectedUserId);
      setSelectedUserId('');
      setIsAddingMember(false);
      setGroupMembers(await fetchGroupMembers(selectedGroupId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setMemberUpdating(false);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!selectedGroupId || memberUpdating || accessLoading || deletingGroupId || groupCreating) return;
    setMemberUpdating(true);
    try {
      await removeGroupMember(selectedGroupId, userId);
      setGroupMembers(await fetchGroupMembers(selectedGroupId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    } finally {
      setMemberUpdating(false);
    }
  };

  const handleToggleTeamLead = async (member: ManagedUser) => {
    if (!selectedGroupId || memberUpdating || accessLoading || deletingGroupId || groupCreating) return;
    setMemberUpdating(true);
    try {
      await setTeamLead(selectedGroupId, member.id, !member.isTeamLead);
      setGroupMembers(await fetchGroupMembers(selectedGroupId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update Team Lead');
    } finally {
      setMemberUpdating(false);
    }
  };

  const handleSaveGroupAccess = async () => {
    if (!selectedGroupId || accessSaving || accessLoading || !isAccessDirty || deletingGroupId || groupCreating) return;
    setAccessSaving(true);
    try {
      const saved = await saveGroupPromptAccess(selectedGroupId, {
        skillIds: sortStrings(groupAccess.skillIds),
        mcpServerIds: sortStrings(groupAccess.mcpServerIds),
        knowledgeBaseIds: sortStrings(groupAccess.knowledgeBaseIds),
      });
      const normalized: GroupPromptAccess = {
        skillIds: sortStrings(saved.skillIds),
        mcpServerIds: sortStrings(saved.mcpServerIds),
        knowledgeBaseIds: sortStrings(saved.knowledgeBaseIds || []),
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
    if (accessSaving || !pluginBundleAvailability.get(plugin.id)?.assignable) return;
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

  const sortHeader = (label: string, field: UserSortField) => (
    <button
      type="button"
      className="users-sort-header"
      aria-label={`Sort by ${label}${userSortBy === field ? `, currently ${userSortOrder === 'asc' ? 'ascending' : 'descending'}` : ''}`}
      onClick={() => {
        setUserSortBy(field);
        setUserSortOrder(userSortBy === field && userSortOrder === 'asc' ? 'desc' : 'asc');
        setUserPage(1);
      }}
    >
      {label}
      {userSortBy === field ? (userSortOrder === 'asc' ? <ArrowDownAZ size={14} /> : <ArrowUpAZ size={14} />) : null}
    </button>
  );

  const userColumns: TableColumn<UserTableRow>[] = [
    {
      key: 'displayName',
      header: sortHeader('Name', 'displayName'),
      width: proportional(2),
      renderCell: (user) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={user.displayName} size="small" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">{user.displayName}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'email',
      header: sortHeader('Email', 'email'),
      width: proportional(2),
      renderCell: (user) => <span className="text-sm text-slate-500">{user.email || '—'}</span>,
    },
    {
      key: 'isAdmin',
      header: sortHeader('Role', 'role'),
      width: pixel(150),
      renderCell: (user) => (
        <select
          aria-label={`Role for ${user.displayName}`}
          className="settings-control users-role-select"
          value={user.isAdmin ? 'admin' : 'member'}
          onChange={() => void handleToggleAdmin(user)}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      ),
    },
    {
      key: 'createdAt',
      header: sortHeader('Joined', 'createdAt'),
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
          <MoreMenu
            label={`Actions for ${user.displayName}`}
            size="sm"
            isDisabled={isCurrentUser || isDeleting}
            items={[{ label: 'Delete user', icon: <Trash2 size={14} />, onClick: () => void handleOpenDeleteModal(user) }]}
          />
        );
      },
    },
  ];

  return (
    <SettingsShell
      eyebrow="Identity & access"
      title="Users & teams"
      description="Manage people, team membership, and access."
    >
      <div className="users-management space-y-6">
        <div className="users-view-tabs">
          <SegmentedControl value={activeView} onChange={changeView} label="Management view" size="md">
            <SegmentedControlItem value="users" label="Users" icon={<UserRound size={15} />} />
            <SegmentedControlItem value="groups" label="Teams" icon={<Users2 size={15} />} />
          </SegmentedControl>
        </div>
        {error ? <SettingsNotice variant="error">{error}</SettingsNotice> : null}

        {activeView === 'users' ? (
          <SettingsSurface>
            <SettingsSectionHeader
              title="Users"
              actions={<span className="text-sm font-medium text-slate-500">{userTotal} total</span>}
            />

            <div className="mt-5 flex items-center gap-3">
              <div className="relative min-w-0 flex-1 lg:max-w-md">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  aria-label="Search users"
                  value={userSearchInput}
                  onChange={(event) => setUserSearchInput(event.target.value)}
                  placeholder="Search name, email, or external ID"
                  className="settings-control w-full rounded-xl py-2.5 pl-10 pr-3 text-sm"
                />
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
          <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
            <SettingsSurface className="h-fit">
              <SettingsSectionHeader
                title="Teams"
                actions={<Badge variant="neutral" label={String(groups.length)} />}
              />

              <div className="relative mt-5">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input aria-label="Search teams" placeholder="Search teams…" value={teamSearch}
                  onChange={(event) => setTeamSearch(event.target.value)}
                  className="settings-control w-full rounded-xl py-2.5 pl-10 pr-3 text-sm" />
              </div>
              <div className="mt-3">
                {isCreatingTeam ? (
                  <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void handleCreateGroup(); }}>
                    <input autoFocus aria-label="New team name" value={newGroupName}
                      onChange={(event) => setNewGroupName(event.target.value)} placeholder="New team name"
                      className="settings-control min-w-0 flex-1 rounded-xl px-3 py-2.5 text-sm" />
                    <IconButton label="Create team" icon={<Plus size={16} />} variant="primary"
                      isDisabled={!newGroupName.trim() || groupCreating} onClick={() => void handleCreateGroup()} />
                    <IconButton label="Cancel new team" icon={<X size={16} />} variant="ghost"
                      isDisabled={groupCreating} onClick={() => setIsCreatingTeam(false)} />
                  </form>
                ) : (
                  <Button label="New team" icon={<Plus size={15} />} variant="secondary" size="sm"
                    onClick={() => setIsCreatingTeam(true)} />
                )}
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
                {!groupsLoading && groups.filter((group) => group.name.toLowerCase().includes(teamSearch.trim().toLowerCase())).map((group) => (
                  <div key={group.id} className={cx('users-team-pill settings-selection-card',
                    selectedGroupId === group.id && 'settings-selection-card-active')}>
                    <button type="button" onClick={() => selectTeam(group.id)}
                      aria-pressed={selectedGroupId === group.id} title={group.name}
                      className="users-team-select" disabled={accessSaving || memberUpdating || groupCreating || !!deletingGroupId}>
                      <span className="truncate text-sm font-medium text-slate-900">{group.name}</span>
                    </button>
                    <button type="button" className="users-team-delete" aria-label={`Delete ${group.name}`}
                      title={`Delete ${group.name}`} disabled={!!deletingGroupId || accessSaving || memberUpdating || groupCreating}
                      onClick={() => void handleDeleteGroup(group.id)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                {!groupsLoading && groups.length > 0 && !groups.some((group) => group.name.toLowerCase().includes(teamSearch.trim().toLowerCase())) ? (
                  <p className="py-4 text-sm text-slate-500">No matching teams.</p>
                ) : null}
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
                      title={selectedGroup.name}
                      description="Members inherit access from every team they belong to."
                    />

                    <div className="mt-6">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold text-slate-900">Members{!accessLoading ? ` · ${groupMembers.length}` : ''}</h3>
                        <Button label="Add member" icon={<Plus size={14} />} variant="secondary" size="sm"
                          isDisabled={accessLoading || memberUpdating} onClick={() => setIsAddingMember((value) => !value)} />
                      </div>
                      {isAddingMember ? (
                        <div className="mt-3 flex gap-2">
                          <select autoFocus aria-label="Select user to add" value={selectedUserId}
                            onChange={(event) => setSelectedUserId(event.target.value)}
                            className="settings-control min-w-0 flex-1 rounded-xl px-3 py-2.5 text-sm">
                            <option value="">{selectableUsers.length ? 'Select user' : 'All users are already members'}</option>
                            {selectableUsers.map((user) => <option key={user.id} value={user.id}>{user.displayName}{user.email ? ` · ${user.email}` : ''}</option>)}
                          </select>
                          <Button label="Add" variant="primary" size="sm" onClick={() => void handleAddMember()}
                            isDisabled={!selectedUserId || memberUpdating} isLoading={memberUpdating} />
                          <IconButton label="Cancel add member" icon={<X size={16} />} variant="ghost"
                            onClick={() => { setIsAddingMember(false); setSelectedUserId(''); }} />
                        </div>
                      ) : null}
                      <div>
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
                            <div key={member.id} className="users-member-row flex items-center justify-between gap-3 py-3">
                              <div className="flex min-w-0 items-center gap-3">
                                <Avatar name={member.displayName} size="xsmall" />
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-slate-900">{member.displayName}</p>
                                  <p className="truncate text-xs text-slate-500">{member.email || member.externalId}</p>
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <select aria-label={`Team role for ${member.displayName}`}
                                  className="settings-control users-role-select" value={member.isTeamLead ? 'lead' : 'member'}
                                  disabled={memberUpdating} onChange={() => void handleToggleTeamLead(member)}>
                                  <option value="member">Member</option>
                                  <option value="lead">Team lead</option>
                                </select>
                                <MoreMenu label={`Actions for ${member.displayName}`} size="sm" isDisabled={memberUpdating}
                                  items={[{ label: 'Remove from team', onClick: () => void handleRemoveMember(member.id) }]} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </SettingsSurface>

                  <SettingsSurface>
                    <SettingsSectionHeader
                      title="Team access"
                      description="Choose the knowledge, skills, and connected tools this team can use."
                    />

                    {catalogLoading || accessLoading ? (
                      <div className="mt-6">
                        <SettingsLoadingState label="Loading access controls..." />
                      </div>
                    ) : (
                      <div className="mt-6 space-y-6">
                        <div className="users-access-fields">
                          <MultiSelector
                            label="Knowledge bases"
                            description="Published knowledge bases this team can reference from any workspace."
                            options={knowledgeOptions}
                            value={groupAccess.knowledgeBaseIds}
                            onChange={(values) => setGroupAccess((previous) => ({
                              ...previous,
                              knowledgeBaseIds: sortStrings(values),
                            }))}
                            placeholder="No knowledge access"
                            triggerDisplay="count"
                            hasSearch
                            hasSelectAll
                            searchPlaceholder="Search knowledge bases"
                            isDisabled={!knowledgeOptions.length || accessSaving}
                            disabledMessage="Publish a knowledge base from the Knowledge page first."
                          />
                          <MultiSelector
                            isDisabled={accessSaving}
                            label="Skills"
                            description="Skills exposed in prompting and slash commands. Approved skills owned by this team stay available to every member; use execution controls to block anomalies."
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
                            isDisabled={accessSaving}
                            label="Connected tools"
                            description="MCP servers available to team members."
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

                        <p className="text-xs text-slate-500">Administrators also need team access to use assigned skills.</p>

                        {visiblePlugins.length > 0 ? (
                          <div>
                            <div className="flex items-end justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-slate-900">Plugin bundles</p>
                                <p className="mt-1 text-xs text-slate-500">Select a bundle to apply its skills and connected tools together.</p>
                              </div>
                            </div>
                            <div className="mt-3 grid gap-3">
                              {visiblePlugins.map((plugin) => {
                                const availability = pluginBundleAvailability.get(plugin.id);
                                const assignable = availability?.assignable === true;
                                const selected = plugin.skillIds.every((id) => groupAccess.skillIds.includes(id))
                                  && plugin.mcpServers.every((id) => groupAccess.mcpServerIds.includes(id));
                                const selectedSkillCount = plugin.skillIds.filter((id) => groupAccess.skillIds.includes(id)).length;
                                const selectedMcpCount = plugin.mcpServers.filter((id) => groupAccess.mcpServerIds.includes(id)).length;
                                const partiallySelected = !selected && (selectedSkillCount > 0 || selectedMcpCount > 0);
                                return (
                                  <button
                                    key={plugin.id}
                                    type="button"
                                    onClick={() => togglePluginBundle(plugin)}
                                    disabled={!assignable || accessSaving}
                                    className={cx(
                                      'settings-selection-card rounded-2xl px-4 py-3 text-left transition',
                                      selected && 'settings-selection-card-active',
                                      !assignable && 'cursor-not-allowed opacity-60',
                                    )}
                                  >
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="truncate text-sm font-semibold text-slate-900">{plugin.displayName}</p>
                                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{plugin.description || plugin.id}</p>
                                      </div>
                                      {selected ? <Badge variant="blue" label="Applied" /> : null}
                                      {!selected && partiallySelected ? <Badge variant="neutral" label="Partial" /> : null}
                                      {!assignable ? <Badge variant="neutral" label="Unavailable" /> : null}
                                    </div>
                                    <p className="mt-2 text-[11px] text-slate-500">
                                      {plugin.skillIds.length} skill{plugin.skillIds.length === 1 ? '' : 's'} · {plugin.mcpServers.length} connection{plugin.mcpServers.length === 1 ? '' : 's'}
                                    </p>
                                    {!assignable && availability ? (
                                      <p className="mt-2 text-xs leading-5 text-rose-600">
                                        {plugin.errors?.[0]
                                          || (availability.missingSkillIds.length
                                            ? `Missing skills: ${availability.missingSkillIds.join(', ')}`
                                            : `Missing connections: ${availability.missingMcpServerIds.join(', ')}`)}
                                      </p>
                                    ) : null}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )}
                    {isAccessDirty || accessSaving ? (
                      <div className="users-access-footer">
                        <span className="text-sm text-slate-500" role="status">{accessSaving ? 'Saving changes…' : 'Unsaved changes'}</span>
                        <div className="flex items-center gap-2">
                          <Button label="Discard changes" variant="ghost" size="sm" isDisabled={accessSaving}
                            onClick={() => setGroupAccess(savedGroupAccess)} />
                          <Button label="Save access" variant="primary" size="sm" isDisabled={accessSaving || !!deletingGroupId || groupCreating}
                            isLoading={accessSaving} onClick={() => void handleSaveGroupAccess()} />
                        </div>
                      </div>
                    ) : null}
                  </SettingsSurface>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {confirmation ? (
        <AlertDialog isOpen title={confirmation.title} description={confirmation.description}
          actionLabel={confirmation.actionLabel} cancelLabel={confirmation.actionLabel === 'Delete team' ? 'Cancel' : 'Keep editing'}
          onOpenChange={(open) => { if (!open) resolveConfirmation(false); }}
          onAction={() => resolveConfirmation(true)} />
      ) : null}

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
              <IconButton
                label="Close"
                variant="ghost"
                size="sm"
                icon={<X size={16} />}
                onClick={() => {
                  setPendingDeleteUser(null);
                  setDeletionImpact(null);
                }}
              />
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
              <Button
                label="Cancel"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPendingDeleteUser(null);
                  setDeletionImpact(null);
                }}
              />
              <Button
                label="Delete user"
                variant="destructive"
                size="sm"
                icon={<Trash2 size={16} />}
                onClick={() => void handleConfirmDeleteUser()}
                isDisabled={deletionImpactLoading || deletingUserId === pendingDeleteUser.id}
                isLoading={deletingUserId === pendingDeleteUser.id}
              />
            </div>
          </div>
        </div>
      ) : null}
    </SettingsShell>
  );
};

export default UsersPage;

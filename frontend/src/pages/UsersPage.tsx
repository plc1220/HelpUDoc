import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Loader2, Plus, Search, ShieldCheck, ShieldOff, Trash2, Users2 } from 'lucide-react';
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
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  deleteUser,
  fetchGroupMembers,
  fetchGroupPromptAccess,
  fetchGroups,
  fetchUserDeletionImpact,
  fetchUsers,
  removeGroupMember,
  saveGroupPromptAccess,
  setUserAdmin,
  type GroupPromptAccess,
  type ManagedGroup,
  type ManagedUser,
  type UserDeletionImpact,
} from '../services/settingsApi';
import type { SkillDefinition } from '../types';

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

const sortStrings = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b));

const toggleSelection = (items: string[], value: string) => (
  items.includes(value) ? items.filter((item) => item !== value) : sortStrings([...items, value])
);

const UsersPage = () => {
  const currentUser = getAuthUser();

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [groupMembers, setGroupMembers] = useState<ManagedUser[]>([]);
  const [groupAccess, setGroupAccess] = useState<GroupPromptAccess>({ skillIds: [], mcpServerIds: [] });
  const [savedGroupAccess, setSavedGroupAccess] = useState<GroupPromptAccess>({ skillIds: [], mcpServerIds: [] });
  const [availableSkills, setAvailableSkills] = useState<SkillDefinition[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = useState<Array<{ name: string; description?: string }>>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [skillSearch, setSkillSearch] = useState('');
  const [mcpSearch, setMcpSearch] = useState('');
  const [pendingDeleteUser, setPendingDeleteUser] = useState<ManagedUser | null>(null);
  const [deletionImpact, setDeletionImpact] = useState<UserDeletionImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
    () => users.filter((user) => !groupMembers.some((member) => member.id === user.id)),
    [groupMembers, users],
  );

  const filteredSkills = useMemo(() => {
    const query = skillSearch.trim().toLowerCase();
    return availableSkills.filter((skill) => {
      if (!query) return true;
      return skill.id.toLowerCase().includes(query)
        || (skill.name || '').toLowerCase().includes(query)
        || (skill.description || '').toLowerCase().includes(query);
    });
  }, [availableSkills, skillSearch]);

  const filteredMcpServers = useMemo(() => {
    const query = mcpSearch.trim().toLowerCase();
    return availableMcpServers.filter((server) => {
      if (!query) return true;
      return server.name.toLowerCase().includes(query)
        || (server.description || '').toLowerCase().includes(query);
    });
  }, [availableMcpServers, mcpSearch]);

  const isAccessDirty = useMemo(() => (
    JSON.stringify(sortStrings(groupAccess.skillIds)) !== JSON.stringify(sortStrings(savedGroupAccess.skillIds))
      || JSON.stringify(sortStrings(groupAccess.mcpServerIds)) !== JSON.stringify(sortStrings(savedGroupAccess.mcpServerIds))
  ), [groupAccess, savedGroupAccess]);

  const loadBaseData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [loadedUsers, loadedGroups] = await Promise.all([fetchUsers(), fetchGroups()]);
      setUsers(loadedUsers);
      setGroups(loadedGroups);
      if (loadedGroups.length) {
        setSelectedGroupId((currentGroupId) => (
          currentGroupId && loadedGroups.some((group) => group.id === currentGroupId)
            ? currentGroupId
            : loadedGroups[0].id
        ));
      } else {
        setSelectedGroupId('');
        setGroupMembers([]);
        setGroupAccess({ skillIds: [], mcpServerIds: [] });
        setSavedGroupAccess({ skillIds: [], mcpServerIds: [] });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load user management data');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPromptCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const { skills, mcpServers } = await fetchSlashMetadata();
      setAvailableSkills(skills);
      setAvailableMcpServers(mcpServers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load prompt access catalog');
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const loadGroupDetails = useCallback(async (groupId: string) => {
    if (!groupId) {
      setGroupMembers([]);
      setGroupAccess({ skillIds: [], mcpServerIds: [] });
      setSavedGroupAccess({ skillIds: [], mcpServerIds: [] });
      return;
    }

    setAccessLoading(true);
    try {
      const [members, access] = await Promise.all([
        fetchGroupMembers(groupId),
        fetchGroupPromptAccess(groupId),
      ]);
      const normalizedAccess = {
        skillIds: sortStrings(access.skillIds),
        mcpServerIds: sortStrings(access.mcpServerIds),
      };
      setGroupMembers(members);
      setGroupAccess(normalizedAccess);
      setSavedGroupAccess(normalizedAccess);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load group details');
    } finally {
      setAccessLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBaseData();
    void loadPromptCatalog();
  }, [loadBaseData, loadPromptCatalog]);

  useEffect(() => {
    void loadGroupDetails(selectedGroupId);
  }, [loadGroupDetails, selectedGroupId]);

  const handleToggleAdmin = async (user: ManagedUser) => {
    try {
      const updated = await setUserAdmin(user.id, !user.isAdmin);
      setUsers((prev) => prev.map((entry) => (entry.id === updated.id ? updated : entry)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update admin role');
    }
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) {
      return;
    }
    try {
      const created = await createGroup(newGroupName.trim());
      setGroups((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedGroupId(created.id);
      setNewGroupName('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group');
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    try {
      await deleteGroup(groupId);
      const remaining = groups.filter((group) => group.id !== groupId);
      setGroups(remaining);
      setSelectedGroupId(remaining[0]?.id || '');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete group');
    }
  };

  const handleAddMember = async () => {
    if (!selectedGroupId || !selectedUserId) {
      return;
    }
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
    if (!selectedGroupId) {
      return;
    }
    try {
      await removeGroupMember(selectedGroupId, userId);
      await loadGroupDetails(selectedGroupId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const handleOpenDeleteModal = async (user: ManagedUser) => {
    setPendingDeleteUser(user);
    setDeletionImpact(null);
    setDeletionImpactLoading(true);
    try {
      const impact = await fetchUserDeletionImpact(user.id);
      setDeletionImpact(impact);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deletion impact');
    } finally {
      setDeletionImpactLoading(false);
    }
  };

  const handleConfirmDeleteUser = async () => {
    if (!pendingDeleteUser) {
      return;
    }
    setDeletingUserId(pendingDeleteUser.id);
    try {
      await deleteUser(pendingDeleteUser.id);
      setUsers((prev) => prev.filter((user) => user.id !== pendingDeleteUser.id));
      setGroupMembers((prev) => prev.filter((member) => member.id !== pendingDeleteUser.id));
      setPendingDeleteUser(null);
      setDeletionImpact(null);
      setError(null);
      await loadBaseData();
      if (selectedGroupId) {
        await loadGroupDetails(selectedGroupId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      setDeletingUserId(null);
    }
  };

  const handleSaveGroupAccess = async () => {
    if (!selectedGroupId) {
      return;
    }
    setAccessSaving(true);
    try {
      const saved = await saveGroupPromptAccess(selectedGroupId, {
        skillIds: sortStrings(groupAccess.skillIds),
        mcpServerIds: sortStrings(groupAccess.mcpServerIds),
      });
      const normalized = {
        skillIds: sortStrings(saved.skillIds),
        mcpServerIds: sortStrings(saved.mcpServerIds),
      };
      setGroupAccess(normalized);
      setSavedGroupAccess(normalized);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save group access');
    } finally {
      setAccessSaving(false);
    }
  };

  const usersSummary = `${users.length} user${users.length === 1 ? '' : 's'}`;
  const groupsSummary = `${groups.length} group${groups.length === 1 ? '' : 's'}`;

  return (
    <SettingsShell
      eyebrow="Users"
      title="User & Group Management"
      description="Manage system administrators, destructive user cleanup, and group-based prompt access."
    >
      <div className="space-y-6">
        {error ? <SettingsNotice variant="error">{error}</SettingsNotice> : null}

        <div className="grid gap-6 xl:grid-cols-[1.02fr_1.18fr]">
          <SettingsSurface>
            <SettingsSectionHeader
              eyebrow="Access"
              title="Users"
              description="Promote administrators, inspect identities, and remove users with owned resources."
              actions={<span className="text-sm font-medium text-slate-500">{loading ? 'Loading...' : usersSummary}</span>}
            />

            <div className="mt-6 space-y-3">
              {loading ? <SettingsLoadingState label="Loading users..." /> : null}

              {!loading && users.length === 0 ? (
                <SettingsEmptyState
                  title="No users found"
                  description="Users will appear here once they have authenticated or been provisioned."
                  icon={Users2}
                />
              ) : null}

              {!loading && users.map((user) => {
                const isCurrentUser = currentUser?.id === user.id;
                const isDeleting = deletingUserId === user.id;
                return (
                  <div
                    key={user.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">{user.displayName}</p>
                      <p className="truncate text-xs text-slate-500">{user.email || user.externalId}</p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleAdmin(user)}
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

                      <button
                        type="button"
                        disabled={isCurrentUser || isDeleting}
                        onClick={() => handleOpenDeleteModal(user)}
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
                    </div>
                  </div>
                );
              })}
            </div>
          </SettingsSurface>

          <SettingsSurface>
            <SettingsSectionHeader
              eyebrow="Groups"
              title="Group membership & prompt access"
              description="Create groups, manage members, and define which skills or MCP servers each group can use while prompting."
              actions={<span className="text-sm font-medium text-slate-500">{groupsSummary}</span>}
            />

            <div className="mt-6 space-y-6">
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  value={newGroupName}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  placeholder="Create group (e.g. analysts)"
                  className="flex-1 rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5"
                />
                <button
                  type="button"
                  onClick={handleCreateGroup}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
                >
                  <Plus size={14} />
                  Add group
                </button>
              </div>

              {groups.length === 0 ? (
                <SettingsEmptyState
                  title="No groups created yet"
                  description="Create your first group to start organizing prompt access."
                  icon={Plus}
                  align="left"
                />
              ) : (
                <div className="space-y-3">
                  {groups.map((group) => (
                    <div
                      key={group.id}
                      className={cx(
                        'flex items-center justify-between rounded-2xl border px-4 py-3 transition',
                        group.id === selectedGroupId
                          ? 'border-slate-900 bg-slate-100'
                          : 'border-slate-200 bg-slate-50/70',
                      )}
                    >
                      <button
                        type="button"
                        className="text-sm font-medium text-slate-900"
                        onClick={() => setSelectedGroupId(group.id)}
                      >
                        {group.name}
                      </button>
                      <button
                        type="button"
                        className="rounded-lg p-1.5 text-rose-600 transition hover:bg-rose-50"
                        onClick={() => handleDeleteGroup(group.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {selectedGroup ? (
                <div className="space-y-5 rounded-[24px] border border-slate-200 bg-slate-50/80 p-5">
                  {accessLoading ? <SettingsLoadingState label="Loading group details..." /> : null}

                  {!accessLoading ? (
                    <>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Selected group</p>
                          <p className="mt-1 text-base font-semibold text-slate-900">{selectedGroup.name}</p>
                        </div>
                        <p className="text-sm text-slate-500">
                          {groupMembers.length} member{groupMembers.length === 1 ? '' : 's'}
                        </p>
                      </div>

                      <div className="space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row">
                          <select
                            className="flex-1 rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5"
                            value={selectedUserId}
                            onChange={(event) => setSelectedUserId(event.target.value)}
                          >
                            <option value="">Select user</option>
                            {selectableUsers.map((user) => (
                              <option key={user.id} value={user.id}>{user.displayName}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={handleAddMember}
                            className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
                          >
                            Add member
                          </button>
                        </div>

                        <div className="space-y-2">
                          {groupMembers.length === 0 ? (
                            <SettingsEmptyState
                              title="No members yet"
                              description="Add users to this group before assigning prompt access."
                              align="left"
                            />
                          ) : (
                            groupMembers.map((member) => (
                              <div
                                key={member.id}
                                className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3"
                              >
                                <span className="text-sm text-slate-800">{member.displayName}</span>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveMember(member.id)}
                                  className="text-xs font-semibold text-rose-600 transition hover:text-rose-700"
                                >
                                  Remove
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      </div>

                      <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">Prompt access</p>
                            <p className="text-xs leading-5 text-slate-500">
                              Members of this group can access the union of the skills and MCP servers selected here.
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setGroupAccess(savedGroupAccess)}
                              disabled={!isAccessDirty || accessSaving}
                              className={cx(
                                'rounded-xl px-3 py-2 text-xs font-semibold transition',
                                !isAccessDirty || accessSaving
                                  ? 'cursor-not-allowed bg-slate-100 text-slate-400'
                                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
                              )}
                            >
                              Reset
                            </button>
                            <button
                              type="button"
                              onClick={handleSaveGroupAccess}
                              disabled={!isAccessDirty || accessSaving}
                              className={cx(
                                'inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition',
                                !isAccessDirty || accessSaving
                                  ? 'cursor-not-allowed bg-slate-200 text-slate-500'
                                  : 'bg-slate-900 text-white hover:bg-slate-800',
                              )}
                            >
                              {accessSaving ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                              Save access
                            </button>
                          </div>
                        </div>

                        <div className="grid gap-4 xl:grid-cols-2">
                          <div className="space-y-3">
                            <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Skills</label>
                            <div className="relative">
                              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                              <input
                                value={skillSearch}
                                onChange={(event) => setSkillSearch(event.target.value)}
                                placeholder="Filter skills"
                                className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5"
                              />
                            </div>
                            <div className="max-h-80 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                              {catalogLoading ? <SettingsLoadingState label="Loading skills..." /> : null}
                              {!catalogLoading && filteredSkills.length === 0 ? (
                                <SettingsEmptyState
                                  title="No skills found"
                                  description="Adjust the filter or add skills from the registry."
                                  align="left"
                                />
                              ) : null}
                              {!catalogLoading && filteredSkills.map((skill) => {
                                const selected = groupAccess.skillIds.includes(skill.id);
                                return (
                                  <button
                                    key={skill.id}
                                    type="button"
                                    onClick={() => setGroupAccess((prev) => ({ ...prev, skillIds: toggleSelection(prev.skillIds, skill.id) }))}
                                    className={cx(
                                      'w-full rounded-2xl border px-3 py-3 text-left transition',
                                      selected
                                        ? 'border-slate-900 bg-slate-900 text-white'
                                        : 'border-slate-200 bg-white text-slate-900 hover:border-slate-300',
                                    )}
                                  >
                                    <p className="text-sm font-semibold">{skill.name || skill.id}</p>
                                    <p className={cx('mt-1 text-xs leading-5', selected ? 'text-slate-200' : 'text-slate-500')}>
                                      {skill.description || skill.id}
                                    </p>
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="space-y-3">
                            <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">MCP servers</label>
                            <div className="relative">
                              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                              <input
                                value={mcpSearch}
                                onChange={(event) => setMcpSearch(event.target.value)}
                                placeholder="Filter MCP servers"
                                className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5"
                              />
                            </div>
                            <div className="max-h-80 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                              {catalogLoading ? <SettingsLoadingState label="Loading MCP servers..." /> : null}
                              {!catalogLoading && filteredMcpServers.length === 0 ? (
                                <SettingsEmptyState
                                  title="No MCP servers found"
                                  description="Adjust the filter or add MCP servers from the agent settings."
                                  align="left"
                                />
                              ) : null}
                              {!catalogLoading && filteredMcpServers.map((server) => {
                                const selected = groupAccess.mcpServerIds.includes(server.name);
                                return (
                                  <button
                                    key={server.name}
                                    type="button"
                                    onClick={() => setGroupAccess((prev) => ({ ...prev, mcpServerIds: toggleSelection(prev.mcpServerIds, server.name) }))}
                                    className={cx(
                                      'w-full rounded-2xl border px-3 py-3 text-left transition',
                                      selected
                                        ? 'border-slate-900 bg-slate-900 text-white'
                                        : 'border-slate-200 bg-white text-slate-900 hover:border-slate-300',
                                    )}
                                  >
                                    <p className="text-sm font-semibold">{server.name}</p>
                                    <p className={cx('mt-1 text-xs leading-5', selected ? 'text-slate-200' : 'text-slate-500')}>
                                      {server.description || 'Allow prompts in this group to target this MCP server.'}
                                    </p>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </SettingsSurface>
        </div>
      </div>

      {pendingDeleteUser ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-4">
          <div className="w-full max-w-2xl rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.2)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-rose-500">Destructive action</p>
                <h3 className="mt-2 text-xl font-semibold text-slate-950">Delete {pendingDeleteUser.displayName}?</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  This removes the user account, deletes any workspaces they own, and detaches authorship metadata from shared records.
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
                    <p className="font-semibold">{deletionImpact.sharedWorkspaceCount} shared workspaces will lose this membership</p>
                    <p className="mt-1 text-xs">{deletionImpact.groupMembershipCount} group memberships and {deletionImpact.oauthTokenCount} OAuth tokens will be removed</p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    <p className="font-semibold">Detached shared references</p>
                    <p className="mt-1 text-xs">
                      {deletionImpact.authoredFileCount} files, {deletionImpact.authoredKnowledgeCount} knowledge items
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    <p className="font-semibold">Detached conversation history</p>
                    <p className="mt-1 text-xs">
                      {deletionImpact.authoredConversationCount} conversations, {deletionImpact.authoredMessageCount} messages
                    </p>
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
                className="rounded-2xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteUser}
                disabled={deletionImpactLoading || deletingUserId === pendingDeleteUser.id}
                className={cx(
                  'inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-semibold text-white transition',
                  deletionImpactLoading || deletingUserId === pendingDeleteUser.id
                    ? 'cursor-not-allowed bg-rose-300'
                    : 'bg-rose-600 hover:bg-rose-700',
                )}
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

import { useEffect, useMemo, useState } from 'react';
import { Plus, ShieldCheck, ShieldOff, Trash2, Users2 } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
import {
  SettingsEmptyState,
  SettingsLoadingState,
  SettingsNotice,
  SettingsSectionHeader,
  SettingsSurface,
} from '../components/settings/SettingsScaffold';
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  fetchGroupMembers,
  fetchGroups,
  fetchUsers,
  removeGroupMember,
  setUserAdmin,
  type ManagedGroup,
  type ManagedUser,
} from '../services/settingsApi';

const UsersPage = () => {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [groupMembers, setGroupMembers] = useState<ManagedUser[]>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId),
    [groups, selectedGroupId],
  );

  const loadBaseData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [loadedUsers, loadedGroups] = await Promise.all([fetchUsers(), fetchGroups()]);
      setUsers(loadedUsers);
      setGroups(loadedGroups);
      if (loadedGroups.length) {
        const nextGroupId = selectedGroupId && loadedGroups.some((group) => group.id === selectedGroupId)
          ? selectedGroupId
          : loadedGroups[0].id;
        setSelectedGroupId(nextGroupId);
      } else {
        setSelectedGroupId('');
        setGroupMembers([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load user management data');
    } finally {
      setLoading(false);
    }
  };

  const loadGroupMembers = async (groupId: string) => {
    if (!groupId) {
      setGroupMembers([]);
      return;
    }
    try {
      const members = await fetchGroupMembers(groupId);
      setGroupMembers(members);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members');
    }
  };

  useEffect(() => {
    void loadBaseData();
  }, []);

  useEffect(() => {
    void loadGroupMembers(selectedGroupId);
  }, [selectedGroupId]);

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
      await loadGroupMembers(selectedGroupId);
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
      await loadGroupMembers(selectedGroupId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const selectableUsers = users.filter((user) => !groupMembers.some((member) => member.id === user.id));
  const usersSummary = `${users.length} user${users.length === 1 ? '' : 's'}`;
  const groupsSummary = `${groups.length} group${groups.length === 1 ? '' : 's'}`;

  return (
    <SettingsShell
      eyebrow="Users"
      title="User & Group Management"
      description="Manage system administrators and in-app user groups for RBAC rollout."
    >
      <div className="space-y-6">
        {error ? <SettingsNotice variant="error">{error}</SettingsNotice> : null}

        <div className="grid gap-6 xl:grid-cols-[1.05fr_1.15fr]">
          <SettingsSurface>
            <SettingsSectionHeader
              eyebrow="Access"
              title="Users"
              description="Promote administrators and review who currently has access to this workspace."
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

              {!loading &&
                users.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-slate-900">{user.displayName}</p>
                      <p className="text-xs text-slate-500">{user.email || user.externalId}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleToggleAdmin(user)}
                      className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition ${user.isAdmin
                        ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`}
                    >
                      {user.isAdmin ? <ShieldCheck size={14} /> : <ShieldOff size={14} />}
                      {user.isAdmin ? 'Admin' : 'Member'}
                    </button>
                  </div>
                ))}
            </div>
          </SettingsSurface>

          <SettingsSurface>
            <SettingsSectionHeader
              eyebrow="Groups"
              title="Group membership"
              description="Create RBAC groups, inspect membership, and keep assignments up to date."
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
                  description="Create your first group to start organizing users for permissions and rollout controls."
                  icon={Plus}
                  align="left"
                />
              ) : (
                <div className="space-y-3">
                  {groups.map((group) => (
                    <div
                      key={group.id}
                      className={`flex items-center justify-between rounded-2xl border px-4 py-3 transition ${group.id === selectedGroupId
                        ? 'border-slate-900 bg-slate-100'
                        : 'border-slate-200 bg-slate-50/70'
                        }`}
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
                <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-5">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Selected group</p>
                      <p className="mt-1 text-base font-semibold text-slate-900">{selectedGroup.name}</p>
                    </div>
                    <p className="text-sm text-slate-500">
                      {groupMembers.length} member{groupMembers.length === 1 ? '' : 's'}
                    </p>
                  </div>

                  <div className="mt-4 flex flex-col gap-3 sm:flex-row">
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

                  <div className="mt-4 space-y-2">
                    {groupMembers.length === 0 ? (
                      <SettingsEmptyState
                        title="No members yet"
                        description="Add users to this group to start testing or enforcing access boundaries."
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
              ) : null}
            </div>
          </SettingsSurface>
        </div>
      </div>
    </SettingsShell>
  );
};

export default UsersPage;

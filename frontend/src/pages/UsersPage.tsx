import { useEffect, useMemo, useState } from 'react';
import { Plus, ShieldCheck, ShieldOff, Trash2, Users2 } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
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

  return (
    <SettingsShell
      eyebrow="Users"
      title="User & Group Management"
      description="Manage system administrators and in-app user groups for RBAC rollout."
    >
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <Users2 size={20} className="text-slate-700" />
            <h3 className="text-lg font-semibold text-slate-900">Users</h3>
          </div>

          {loading ? (
            <p className="text-sm text-slate-600">Loading users…</p>
          ) : (
            <div className="space-y-3">
              {users.map((user) => (
                <div key={user.id} className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{user.displayName}</p>
                    <p className="text-xs text-slate-500">{user.email || user.externalId}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggleAdmin(user)}
                    className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold ${user.isAdmin
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
          )}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-900">Groups</h3>

          <div className="mt-4 flex gap-2">
            <input
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.target.value)}
              placeholder="Create group (e.g. analysts)"
              className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={handleCreateGroup}
              className="inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
            >
              <Plus size={14} />
              Add
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {groups.map((group) => (
              <div key={group.id} className={`flex items-center justify-between rounded-xl border px-3 py-2 ${group.id === selectedGroupId ? 'border-slate-700 bg-slate-50' : 'border-slate-200'}`}>
                <button
                  type="button"
                  className="text-sm font-medium text-slate-900"
                  onClick={() => setSelectedGroupId(group.id)}
                >
                  {group.name}
                </button>
                <button
                  type="button"
                  className="rounded-md p-1 text-rose-600 hover:bg-rose-50"
                  onClick={() => handleDeleteGroup(group.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>

          {selectedGroup && (
            <div className="mt-6 rounded-2xl border border-slate-200 p-4">
              <p className="text-sm font-semibold text-slate-900">Members: {selectedGroup.name}</p>
              <div className="mt-3 flex gap-2">
                <select
                  className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm"
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
                  className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
                >
                  Add member
                </button>
              </div>

              <div className="mt-3 space-y-2">
                {groupMembers.map((member) => (
                  <div key={member.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                    <span className="text-sm text-slate-800">{member.displayName}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveMember(member.id)}
                      className="text-xs font-semibold text-rose-600"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </SettingsShell>
  );
};

export default UsersPage;

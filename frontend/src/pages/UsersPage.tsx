import { Users2 } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';

const UsersPage = () => {
  return (
    <SettingsShell
      eyebrow="Users"
      title="Users"
      description="Manage workspace members and permissions."
    >
      <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex flex-col items-center gap-4 text-center text-slate-600">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
            <Users2 size={28} />
          </span>
          <div>
            <p className="font-semibold text-slate-900">User management is coming soon.</p>
            <p className="mt-2">Invite teammates, manage access, and control permissions from a single place.</p>
          </div>
        </div>
      </div>
    </SettingsShell>
  );
};

export default UsersPage;

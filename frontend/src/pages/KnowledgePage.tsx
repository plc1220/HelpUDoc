import { Link } from 'react-router-dom';
import { NotebookPen } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';

const KnowledgePage = () => {
  return (
    <SettingsShell
      eyebrow="Knowledge"
      title="Knowledge"
      description="Manage the documents and context that power your assistants."
    >
      <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex flex-col items-center gap-4 text-center text-slate-600">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
            <NotebookPen size={28} />
          </span>
          <div>
            <p className="font-semibold text-slate-900">Knowledge hub is coming soon.</p>
            <p className="mt-2">Centralize playbooks, FAQs, and contextual docs to boost every agent response.</p>
          </div>
          <Link to="/settings/agents" className="text-slate-900 font-medium hover:underline">
            Configure agent knowledge sources
          </Link>
        </div>
      </div>
    </SettingsShell>
  );
};

export default KnowledgePage;

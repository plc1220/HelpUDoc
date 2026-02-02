import AgentSettingsTabs from '../components/settings/AgentSettingsTabs';
import SettingsShell from '../components/settings/SettingsShell';

const AgentSettingsPage = () => {
  return (
    <SettingsShell
      eyebrow="Skills & Tools"
      title="Skills Registry & Tooling"
      description="Manage reusable skills and the tools they can use."
    >
      <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <AgentSettingsTabs />
      </div>
    </SettingsShell>
  );
};

export default AgentSettingsPage;

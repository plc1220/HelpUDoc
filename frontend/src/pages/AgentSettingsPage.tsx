import AgentSettingsTabs from '../components/settings/AgentSettingsTabs';
import SettingsShell from '../components/settings/SettingsShell';

const AgentSettingsPage = () => {
  return (
    <SettingsShell
      eyebrow="Agents"
      title="Core Agent & Subagents"
      description="Configure personas, tools, and prompts powering your assistants in a focused workspace."
    >
      <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <AgentSettingsTabs />
      </div>
    </SettingsShell>
  );
};

export default AgentSettingsPage;

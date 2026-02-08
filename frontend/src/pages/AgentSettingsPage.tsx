import AgentSettingsTabs from '../components/settings/AgentSettingsTabs';
import SettingsShell from '../components/settings/SettingsShell';

const AgentSettingsPage = () => {
  return (
    <SettingsShell
      eyebrow="Skills & Tools"
      title="Skills Registry & Tooling"
      description="Manage reusable skills and the tools they can use."
    >
      <AgentSettingsTabs />
    </SettingsShell>
  );
};

export default AgentSettingsPage;

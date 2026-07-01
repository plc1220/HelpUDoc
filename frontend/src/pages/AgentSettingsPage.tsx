import AgentSettingsTabs from '../components/settings/AgentSettingsTabs';
import SettingsShell from '../components/settings/SettingsShell';

const AgentSettingsPage = () => {
  return (
    <SettingsShell
      eyebrow="Plugins & Skills"
      title="Plugins, Skills & Tooling"
      description="Manage plugin bundles, reusable skills, and the tools they can use."
    >
      <AgentSettingsTabs />
    </SettingsShell>
  );
};

export default AgentSettingsPage;

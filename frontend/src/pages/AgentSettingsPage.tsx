import AgentSettingsTabs from '../components/settings/AgentSettingsTabs';
import SettingsShell from '../components/settings/SettingsShell';

const AgentSettingsPage = () => {
  return (
    <SettingsShell
      eyebrow="Extensions"
      title="Plugins & integrations"
      description="Manage plugin bundles and the tools, connections, and MCP servers they provide."
    >
      <AgentSettingsTabs />
    </SettingsShell>
  );
};

export default AgentSettingsPage;

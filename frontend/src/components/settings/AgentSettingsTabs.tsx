import { Suspense, lazy, useState, useEffect, useCallback } from 'react';
import { Wrench, Library, Loader2 } from 'lucide-react';
import { fetchAgentConfig, saveAgentConfig } from '../../services/settingsApi';
import ToolsTab, { type AgentConfig } from './ToolsTab';
import { SettingsEmptyState, SettingsLoadingState, SettingsTabPanel, SettingsTabs } from './SettingsScaffold';
import YAML from 'yaml';
import { getAuthUser } from '../../auth/authStore';

const SkillsRegistryTab = lazy(() => import('./SkillsRegistryTab'));

const AgentSettingsTabs = () => {
    const [activeTab, setActiveTab] = useState<'tools' | 'skills'>('skills');
    const [config, setConfig] = useState<AgentConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadConfig = useCallback(async () => {
        try {
            setLoading(true);
            const yamlContent = await fetchAgentConfig();
            const parsed = YAML.parse(yamlContent);
            setConfig(parsed);
            setError(null);
        } catch (err) {
            console.error('Failed to load config', err);
            const message = err instanceof Error ? err.message : 'Failed to load configuration';
            if (/admin access required/i.test(message)) {
                const currentUser = getAuthUser();
                const identity = currentUser?.email || currentUser?.id || 'unknown';
                setError(`Admin access required. Current identity: ${identity}`);
            } else {
                setError(message);
            }
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadConfig();
    }, [loadConfig]);

    const handleSave = async (newConfig: AgentConfig) => {
        try {
            setSaving(true);
            const yamlString = YAML.stringify(newConfig);
            await saveAgentConfig(yamlString);
            setConfig(newConfig);
        } catch (err) {
            console.error('Failed to save config', err);
            const message = err instanceof Error ? err.message : 'Failed to save configuration';
            if (/admin access required/i.test(message)) {
                const currentUser = getAuthUser();
                const identity = currentUser?.email || currentUser?.id || 'unknown';
                setError(`Admin access required. Current identity: ${identity}`);
            } else {
                setError(message);
            }
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <SettingsTabPanel className="flex min-h-[320px] items-center justify-center">
                <SettingsLoadingState label="Loading agent configuration..." />
            </SettingsTabPanel>
        );
    }

    if (error) {
        return (
            <SettingsTabPanel className="flex min-h-[320px] items-center">
                <SettingsEmptyState
                    title="Unable to load settings"
                    description={error}
                    icon={Loader2}
                    action={
                        <button
                            type="button"
                            onClick={loadConfig}
                            className="settings-portal-button-secondary rounded-xl px-4 py-2 text-sm font-medium transition"
                        >
                            Retry
                        </button>
                    }
                />
            </SettingsTabPanel>
        );
    }

    return (
        <div className="space-y-6">
            <SettingsTabs
                tabs={[
                    { id: 'skills', label: 'Skill Registry', icon: Library },
                    { id: 'tools', label: 'Tools & MCP', icon: Wrench },
                ]}
                value={activeTab}
                onChange={setActiveTab}
            />

            <SettingsTabPanel>
                {activeTab === 'tools' && (
                    <ToolsTab config={config} onSave={handleSave} isSaving={saving} />
                )}
                {activeTab === 'skills' && (
                    <Suspense fallback={<SettingsLoadingState label="Loading skill registry..." />}>
                        <SkillsRegistryTab />
                    </Suspense>
                )}
            </SettingsTabPanel>
        </div>
    );
};

export default AgentSettingsTabs;

import { useState, useEffect, useCallback } from 'react';
import { Users, Network, Wrench, Loader2 } from 'lucide-react';
import { fetchAgentConfig, saveAgentConfig } from '../../services/settingsApi';
import CoreAgentsTab from './CoreAgentsTab';
import SubagentsTab from './SubagentsTab';
import ToolsTab from './ToolsTab';
import YAML from 'yaml';

const AgentSettingsTabs = () => {
    const [activeTab, setActiveTab] = useState<'core' | 'subagents' | 'tools'>('core');
    const [config, setConfig] = useState<any>(null);
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
            setError('Failed to load configuration');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadConfig();
    }, [loadConfig]);

    const handleSave = async (newConfig: any) => {
        try {
            setSaving(true);
            const yamlString = YAML.stringify(newConfig);
            await saveAgentConfig(yamlString);
            setConfig(newConfig);
        } catch (err) {
            console.error('Failed to save config', err);
            setError('Failed to save configuration');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="animate-spin text-slate-400" size={32} />
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-6 text-center">
                <p className="text-rose-600 mb-4">{error}</p>
                <button
                    onClick={loadConfig}
                    className="px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800"
                >
                    Retry
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl w-fit">
                <button
                    onClick={() => setActiveTab('core')}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'core'
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                >
                    <Users size={16} />
                    Core Agents
                </button>
                <button
                    onClick={() => setActiveTab('subagents')}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'subagents'
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                >
                    <Network size={16} />
                    Subagents
                </button>
                <button
                    onClick={() => setActiveTab('tools')}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'tools'
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                >
                    <Wrench size={16} />
                    Tools & MCP
                </button>
            </div>

            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 min-h-[500px]">
                {activeTab === 'core' && (
                    <CoreAgentsTab config={config} onSave={handleSave} isSaving={saving} />
                )}
                {activeTab === 'subagents' && (
                    <SubagentsTab config={config} onSave={handleSave} isSaving={saving} />
                )}
                {activeTab === 'tools' && (
                    <ToolsTab config={config} onSave={handleSave} isSaving={saving} />
                )}
            </div>
        </div>
    );
};

export default AgentSettingsTabs;

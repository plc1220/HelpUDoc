import React, { useState } from 'react';
import { Plus, Trash2, Save, Loader2, Edit2 } from 'lucide-react';
import { savePrompt } from '../../services/settingsApi';

interface CoreAgentsTabProps {
    config: any;
    onSave: (config: any) => Promise<void>;
    isSaving: boolean;
}

const CoreAgentsTab: React.FC<CoreAgentsTabProps> = ({ config, onSave, isSaving }) => {
    const [isAdding, setIsAdding] = useState(false);
    const [newAgentName, setNewAgentName] = useState('');
    const [newAgentDisplay, setNewAgentDisplay] = useState('');
    const [newAgentDesc, setNewAgentDesc] = useState('');

    const agents = config?.agents || [];

    const handleAddAgent = async () => {
        if (!newAgentName || !newAgentDisplay) return;

        const existingIndex = agents.findIndex((a: any) => a.name === newAgentName);

        let updatedAgents;
        if (existingIndex >= 0) {
            updatedAgents = [...agents];
            updatedAgents[existingIndex] = {
                ...updatedAgents[existingIndex],
                display_name: newAgentDisplay,
                description: newAgentDesc,
            };
        } else {
            const newAgent = {
                name: newAgentName,
                display_name: newAgentDisplay,
                description: newAgentDesc,
                system_prompt_id: `${newAgentName}/core`,
                tools: [],
                subagents: [],
            };
            updatedAgents = [...agents, newAgent];

            // Create the prompt file only for new agents
            try {
                await savePrompt(`${newAgentName}/core`, 'You are a helpful assistant.');
            } catch (error) {
                console.error('Failed to create agent prompt file', error);
                alert('Failed to create agent prompt file');
                return;
            }
        }

        const updatedConfig = {
            ...config,
            agents: updatedAgents,
        };

        try {
            await onSave(updatedConfig);
            setIsAdding(false);
            setNewAgentName('');
            setNewAgentDisplay('');
            setNewAgentDesc('');
        } catch (error) {
            console.error('Failed to save agent', error);
            alert('Failed to save agent');
        }
    };

    const handleDeleteAgent = async (index: number) => {
        if (!confirm('Are you sure you want to delete this agent?')) return;
        const updatedAgents = [...agents];
        updatedAgents.splice(index, 1);
        await onSave({ ...config, agents: updatedAgents });
    };

    const handleEditAgent = (index: number) => {
        const agent = agents[index];
        setNewAgentName(agent.name);
        setNewAgentDisplay(agent.display_name);
        setNewAgentDesc(agent.description);
        setIsAdding(true);
    };

    return (
        <div>
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h3 className="text-lg font-semibold text-slate-900">Core Agents</h3>
                    <p className="text-slate-500 text-sm">Manage top-level agents and their configurations.</p>
                </div>
                <button
                    onClick={() => {
                        setIsAdding(true);
                        setNewAgentName('');
                        setNewAgentDisplay('');
                        setNewAgentDesc('');
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800"
                >
                    <Plus size={16} />
                    Add Agent
                </button>
            </div>

            {isAdding && (
                <div className="mb-8 p-4 bg-slate-50 rounded-xl border border-slate-200">
                    <h4 className="font-medium text-slate-900 mb-4">{newAgentName && agents.some((a: any) => a.name === newAgentName) ? 'Edit Agent' : 'New Agent Details'}</h4>
                    <div className="grid grid-cols-2 gap-4 mb-4">
                        <div>
                            <label className="block text-xs font-medium text-slate-500 mb-1">Internal Name (ID)</label>
                            <input
                                type="text"
                                value={newAgentName}
                                onChange={(e) => setNewAgentName(e.target.value)}
                                placeholder="e.g., coding-agent"
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                                disabled={agents.some((a: any) => a.name === newAgentName)}
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-slate-500 mb-1">Display Name</label>
                            <input
                                type="text"
                                value={newAgentDisplay}
                                onChange={(e) => setNewAgentDisplay(e.target.value)}
                                placeholder="e.g., Coding Assistant"
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                            />
                        </div>
                        <div className="col-span-2">
                            <label className="block text-xs font-medium text-slate-500 mb-1">Description</label>
                            <input
                                type="text"
                                value={newAgentDesc}
                                onChange={(e) => setNewAgentDesc(e.target.value)}
                                placeholder="Brief description of the agent's purpose"
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                            />
                        </div>
                    </div>
                    <div className="flex justify-end gap-2">
                        <button
                            onClick={() => {
                                setIsAdding(false);
                                setNewAgentName('');
                                setNewAgentDisplay('');
                                setNewAgentDesc('');
                            }}
                            className="px-3 py-1.5 text-slate-600 text-sm hover:bg-slate-200 rounded-lg"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleAddAgent}
                            disabled={isSaving || !newAgentName || !newAgentDisplay}
                            className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                        >
                            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                            Save Agent
                        </button>
                    </div>
                </div>
            )}

            <div className="grid gap-4">
                {agents.map((agent: any, index: number) => (
                    <div key={index} className="p-4 rounded-xl border border-slate-200 bg-slate-50 flex items-start justify-between">
                        <div>
                            <div className="flex items-center gap-2 mb-1">
                                <h4 className="font-semibold text-slate-900">{agent.display_name}</h4>
                                <span className="text-xs px-2 py-0.5 bg-slate-200 text-slate-600 rounded-full font-mono">
                                    {agent.name}
                                </span>
                            </div>
                            <p className="text-sm text-slate-600 mb-2">{agent.description}</p>
                            <div className="flex gap-4 text-xs text-slate-500">
                                <span>Prompt: {agent.system_prompt_id}</span>
                                <span>Subagents: {agent.subagents?.length || 0}</span>
                                <span>Tools: {agent.tools?.length || 0}</span>
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={() => handleEditAgent(index)}
                                className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-200 rounded-lg transition-colors"
                                title="Edit Agent"
                            >
                                <Edit2 size={16} />
                            </button>
                            <button
                                onClick={() => handleDeleteAgent(index)}
                                className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                                title="Delete Agent"
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>
                    </div>
                ))}
                {agents.length === 0 && (
                    <div className="text-center py-12 text-slate-500">
                        No agents configured. Add one to get started.
                    </div>
                )}
            </div>
        </div>
    );
};

export default CoreAgentsTab;

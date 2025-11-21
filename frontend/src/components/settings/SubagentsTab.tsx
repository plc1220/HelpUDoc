import React, { useState } from 'react';
import { Plus, Trash2, Save, Loader2, Edit2 } from 'lucide-react';
import { savePrompt } from '../../services/settingsApi';

interface SubagentsTabProps {
    config: any;
    onSave: (config: any) => Promise<void>;
    isSaving: boolean;
}

const SubagentsTab: React.FC<SubagentsTabProps> = ({ config, onSave, isSaving }) => {
    const agents = config?.agents || [];
    const [selectedAgentIndex, setSelectedAgentIndex] = useState<number>(0);
    const [isAdding, setIsAdding] = useState(false);

    const [newName, setNewName] = useState('');
    const [newDesc, setNewDesc] = useState('');

    const selectedAgent = agents[selectedAgentIndex];

    const handleAddSubagent = async () => {
        if (!newName || !selectedAgent) return;

        const updatedAgents = [...agents];
        const currentAgent = { ...updatedAgents[selectedAgentIndex] };
        const existingSubIndex = currentAgent.subagents?.findIndex((s: any) => s.name === newName);

        if (existingSubIndex !== undefined && existingSubIndex >= 0) {
            const updatedSubagents = [...(currentAgent.subagents || [])];
            updatedSubagents[existingSubIndex] = {
                ...updatedSubagents[existingSubIndex],
                description: newDesc,
            };
            currentAgent.subagents = updatedSubagents;
        } else {
            const newSubagent = {
                name: newName,
                description: newDesc,
                system_prompt_id: `${selectedAgent.name}/${newName}`,
                tools: [],
            };
            currentAgent.subagents = [...(currentAgent.subagents || []), newSubagent];

            // Create prompt file for new subagent
            try {
                await savePrompt(`${selectedAgent.name}/${newName}`, 'You are a specialized subagent.');
            } catch (error) {
                console.error('Failed to create subagent prompt file', error);
                alert('Failed to create subagent prompt file');
                return;
            }
        }

        updatedAgents[selectedAgentIndex] = currentAgent;
        const updatedConfig = { ...config, agents: updatedAgents };

        try {
            await onSave(updatedConfig);
            setIsAdding(false);
            setNewName('');
            setNewDesc('');
        } catch (error) {
            console.error('Failed to save subagent', error);
            alert('Failed to save subagent');
        }
    };

    const handleDeleteSubagent = async (subIndex: number) => {
        if (!confirm('Are you sure you want to delete this subagent?')) return;

        const updatedAgents = [...agents];
        const currentAgent = { ...updatedAgents[selectedAgentIndex] };
        const newSubagents = [...(currentAgent.subagents || [])];
        newSubagents.splice(subIndex, 1);
        currentAgent.subagents = newSubagents;
        updatedAgents[selectedAgentIndex] = currentAgent;

        await onSave({ ...config, agents: updatedAgents });
    };

    if (agents.length === 0) {
        return (
            <div className="text-center py-12 text-slate-500">
                Please create a Core Agent first.
            </div>
        );
    }

    const handleEditSubagent = (subIndex: number) => {
        const sub = selectedAgent.subagents[subIndex];
        setNewName(sub.name);
        setNewDesc(sub.description);
        setIsAdding(true);
    };

    return (
        <div>
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h3 className="text-lg font-semibold text-slate-900">Subagents</h3>
                    <p className="text-slate-500 text-sm">Manage specialized subagents for {selectedAgent?.display_name}.</p>
                </div>
                <div className="flex items-center gap-4">
                    <select
                        value={selectedAgentIndex}
                        onChange={(e) => setSelectedAgentIndex(Number(e.target.value))}
                        className="px-3 py-2 rounded-lg border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                    >
                        {agents.map((agent: any, idx: number) => (
                            <option key={idx} value={idx}>
                                {agent.display_name}
                            </option>
                        ))}
                    </select>
                    <button
                        onClick={() => {
                            setIsAdding(true);
                            setNewName('');
                            setNewDesc('');
                        }}
                        className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800"
                    >
                        <Plus size={16} />
                        Add Subagent
                    </button>
                </div>
            </div>

            {isAdding && (
                <div className="mb-8 p-4 bg-slate-50 rounded-xl border border-slate-200">
                    <h4 className="font-medium text-slate-900 mb-4">{newName && selectedAgent.subagents?.some((s: any) => s.name === newName) ? 'Edit Subagent' : `New Subagent for ${selectedAgent.display_name}`}</h4>
                    <div className="grid grid-cols-2 gap-4 mb-4">
                        <div>
                            <label className="block text-xs font-medium text-slate-500 mb-1">Name (ID)</label>
                            <input
                                type="text"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder="e.g., researcher"
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                                disabled={selectedAgent.subagents?.some((s: any) => s.name === newName)}
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-slate-500 mb-1">Description</label>
                            <input
                                type="text"
                                value={newDesc}
                                onChange={(e) => setNewDesc(e.target.value)}
                                placeholder="Brief description"
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                            />
                        </div>
                    </div>
                    <div className="flex justify-end gap-2">
                        <button
                            onClick={() => {
                                setIsAdding(false);
                                setNewName('');
                                setNewDesc('');
                            }}
                            className="px-3 py-1.5 text-slate-600 text-sm hover:bg-slate-200 rounded-lg"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleAddSubagent}
                            disabled={isSaving || !newName}
                            className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                        >
                            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                            Save Subagent
                        </button>
                    </div>
                </div>
            )}

            <div className="grid gap-4">
                {selectedAgent?.subagents?.map((sub: any, index: number) => (
                    <div key={index} className="p-4 rounded-xl border border-slate-200 bg-slate-50 flex items-start justify-between">
                        <div>
                            <div className="flex items-center gap-2 mb-1">
                                <h4 className="font-semibold text-slate-900">{sub.name}</h4>
                            </div>
                            <p className="text-sm text-slate-600 mb-2">{sub.description}</p>
                            <div className="flex gap-4 text-xs text-slate-500">
                                <span>Prompt: {sub.system_prompt_id}</span>
                                <span>Tools: {sub.tools?.length || 0}</span>
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={() => handleEditSubagent(index)}
                                className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-200 rounded-lg transition-colors"
                                title="Edit Subagent"
                            >
                                <Edit2 size={16} />
                            </button>
                            <button
                                onClick={() => handleDeleteSubagent(index)}
                                className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                                title="Delete Subagent"
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>
                    </div>
                ))}
                {(!selectedAgent?.subagents || selectedAgent.subagents.length === 0) && (
                    <div className="text-center py-12 text-slate-500">
                        No subagents configured for this agent.
                    </div>
                )}
            </div>
        </div>
    );
};

export default SubagentsTab;

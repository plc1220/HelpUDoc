import React, { useState } from 'react';
import { Plus, Trash2, Save, Loader2, Server, Hammer } from 'lucide-react';

interface ToolsTabProps {
    config: any;
    onSave: (config: any) => Promise<void>;
    isSaving: boolean;
}

const ToolsTab: React.FC<ToolsTabProps> = ({ config, onSave, isSaving }) => {
    const [activeSection, setActiveSection] = useState<'builtin' | 'mcp'>('builtin');

    // Builtin Tools State
    const [isAddingTool, setIsAddingTool] = useState(false);
    const [newToolName, setNewToolName] = useState('');
    const [newToolDesc, setNewToolDesc] = useState('');

    // MCP Server State
    const [isAddingMcp, setIsAddingMcp] = useState(false);
    const [newMcpName, setNewMcpName] = useState('');
    const [newMcpCommand, setNewMcpCommand] = useState('');
    const [newMcpDesc, setNewMcpDesc] = useState('');

    const tools = config?.tools || [];
    const mcpServers = config?.mcp_servers || [];

    const handleAddTool = async () => {
        if (!newToolName) return;
        const newTool = {
            name: newToolName,
            kind: 'builtin',
            description: newToolDesc,
        };
        const updatedConfig = { ...config, tools: [...tools, newTool] };
        await onSave(updatedConfig);
        setIsAddingTool(false);
        setNewToolName('');
        setNewToolDesc('');
    };

    const handleDeleteTool = async (index: number) => {
        if (!confirm('Delete this tool?')) return;
        const updatedTools = [...tools];
        updatedTools.splice(index, 1);
        await onSave({ ...config, tools: updatedTools });
    };

    const handleAddMcp = async () => {
        if (!newMcpName || !newMcpCommand) return;
        const newMcp = {
            name: newMcpName,
            transport: 'stdio',
            command: newMcpCommand,
            description: newMcpDesc,
        };
        const updatedConfig = { ...config, mcp_servers: [...mcpServers, newMcp] };
        await onSave(updatedConfig);
        setIsAddingMcp(false);
        setNewMcpName('');
        setNewMcpCommand('');
        setNewMcpDesc('');
    };

    const handleDeleteMcp = async (index: number) => {
        if (!confirm('Delete this MCP server?')) return;
        const updatedMcp = [...mcpServers];
        updatedMcp.splice(index, 1);
        await onSave({ ...config, mcp_servers: updatedMcp });
    };

    return (
        <div>
            <div className="flex gap-4 mb-6 border-b border-slate-200 pb-4">
                <button
                    onClick={() => setActiveSection('builtin')}
                    className={`flex items-center gap-2 text-sm font-medium pb-1 -mb-5 border-b-2 transition-colors ${activeSection === 'builtin'
                            ? 'border-slate-900 text-slate-900'
                            : 'border-transparent text-slate-500 hover:text-slate-700'
                        }`}
                >
                    <Hammer size={16} />
                    Built-in Tools
                </button>
                <button
                    onClick={() => setActiveSection('mcp')}
                    className={`flex items-center gap-2 text-sm font-medium pb-1 -mb-5 border-b-2 transition-colors ${activeSection === 'mcp'
                            ? 'border-slate-900 text-slate-900'
                            : 'border-transparent text-slate-500 hover:text-slate-700'
                        }`}
                >
                    <Server size={16} />
                    MCP Servers
                </button>
            </div>

            {activeSection === 'builtin' && (
                <div>
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-lg font-semibold text-slate-900">Built-in Tools</h3>
                        <button
                            onClick={() => setIsAddingTool(true)}
                            className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800"
                        >
                            <Plus size={16} />
                            Add Tool
                        </button>
                    </div>

                    {isAddingTool && (
                        <div className="mb-6 p-4 bg-slate-50 rounded-xl border border-slate-200">
                            <div className="grid grid-cols-2 gap-4 mb-4">
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1">Tool Name</label>
                                    <input
                                        type="text"
                                        value={newToolName}
                                        onChange={(e) => setNewToolName(e.target.value)}
                                        placeholder="e.g., google_search"
                                        className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1">Description</label>
                                    <input
                                        type="text"
                                        value={newToolDesc}
                                        onChange={(e) => setNewToolDesc(e.target.value)}
                                        placeholder="Description"
                                        className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                                    />
                                </div>
                            </div>
                            <div className="flex justify-end gap-2">
                                <button onClick={() => setIsAddingTool(false)} className="px-3 py-1.5 text-slate-600 text-sm hover:bg-slate-200 rounded-lg">Cancel</button>
                                <button onClick={handleAddTool} disabled={isSaving} className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700">
                                    {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                    Save
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="grid gap-3">
                        {tools.map((tool: any, idx: number) => (
                            <div key={idx} className="p-3 rounded-lg border border-slate-200 flex justify-between items-center">
                                <div>
                                    <p className="font-medium text-slate-900">{tool.name}</p>
                                    <p className="text-sm text-slate-500">{tool.description}</p>
                                </div>
                                <button onClick={() => handleDeleteTool(idx)} className="p-2 text-slate-400 hover:text-rose-600">
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {activeSection === 'mcp' && (
                <div>
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-lg font-semibold text-slate-900">MCP Servers</h3>
                        <button
                            onClick={() => setIsAddingMcp(true)}
                            className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800"
                        >
                            <Plus size={16} />
                            Add Server
                        </button>
                    </div>

                    {isAddingMcp && (
                        <div className="mb-6 p-4 bg-slate-50 rounded-xl border border-slate-200">
                            <div className="grid grid-cols-2 gap-4 mb-4">
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1">Server Name</label>
                                    <input
                                        type="text"
                                        value={newMcpName}
                                        onChange={(e) => setNewMcpName(e.target.value)}
                                        placeholder="e.g., filesystem"
                                        className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1">Command</label>
                                    <input
                                        type="text"
                                        value={newMcpCommand}
                                        onChange={(e) => setNewMcpCommand(e.target.value)}
                                        placeholder="e.g., npx -y @modelcontextprotocol/server-filesystem"
                                        className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                                    />
                                </div>
                                <div className="col-span-2">
                                    <label className="block text-xs font-medium text-slate-500 mb-1">Description</label>
                                    <input
                                        type="text"
                                        value={newMcpDesc}
                                        onChange={(e) => setNewMcpDesc(e.target.value)}
                                        placeholder="Description"
                                        className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                                    />
                                </div>
                            </div>
                            <div className="flex justify-end gap-2">
                                <button onClick={() => setIsAddingMcp(false)} className="px-3 py-1.5 text-slate-600 text-sm hover:bg-slate-200 rounded-lg">Cancel</button>
                                <button onClick={handleAddMcp} disabled={isSaving} className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700">
                                    {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                    Save
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="grid gap-3">
                        {mcpServers.map((server: any, idx: number) => (
                            <div key={idx} className="p-3 rounded-lg border border-slate-200 flex justify-between items-center">
                                <div>
                                    <p className="font-medium text-slate-900">{server.name}</p>
                                    <p className="text-sm text-slate-500 font-mono bg-slate-100 px-2 py-0.5 rounded w-fit mt-1">{server.command}</p>
                                </div>
                                <button onClick={() => handleDeleteMcp(idx)} className="p-2 text-slate-400 hover:text-rose-600">
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default ToolsTab;

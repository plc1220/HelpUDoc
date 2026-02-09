import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Save, Loader2, Server, Hammer, X, ExternalLink } from 'lucide-react';

interface ToolsTabProps {
    config: any;
    onSave: (config: any) => Promise<void>;
    isSaving: boolean;
}

interface KeyValue {
    id: string;
    key: string;
    value: string;
}

interface McpServerFormState {
    name: string;
    transport: 'stdio' | 'http';
    defaultAccess: 'allow' | 'deny';
    command: string;
    args: { id: string; value: string }[];
    env: KeyValue[];
    envPassthrough: { id: string; value: string }[];
    cwd: string;
    url: string;
    bearerTokenEnvVar: string; // New: Bearer token env var
    headers: KeyValue[]; // New: Headers
    headersFromEnv: KeyValue[]; // New: Headers from env vars
}

const EmptyMcpForm: McpServerFormState = {
    name: '',
    transport: 'stdio',
    defaultAccess: 'allow',
    command: '',
    args: [],
    env: [],
    envPassthrough: [],
    cwd: '',
    url: '',
    bearerTokenEnvVar: '',
    headers: [],
    headersFromEnv: [],
};

const ToolsTab: React.FC<ToolsTabProps> = ({ config, onSave, isSaving }) => {
    const [activeSection, setActiveSection] = useState<'builtin' | 'mcp'>('mcp');

    // Builtin Tools State
    const [isAddingTool, setIsAddingTool] = useState(false);
    const [newToolName, setNewToolName] = useState('');
    const [newToolDesc, setNewToolDesc] = useState('');

    // MCP Server State
    const [isEditingMcp, setIsEditingMcp] = useState(false);
    const [editingMcpIndex, setEditingMcpIndex] = useState<number | null>(null);
    const [mcpForm, setMcpForm] = useState<McpServerFormState>(EmptyMcpForm);

    const tools = config?.tools || [];
    const mcpServers = config?.mcp_servers || [];

    // Initialize form when editing
    useEffect(() => {
        if (editingMcpIndex !== null && mcpServers[editingMcpIndex]) {
            const server = mcpServers[editingMcpIndex];
            setMcpForm({
                name: server.name || '',
                transport: server.transport || 'stdio',
                defaultAccess: server.default_access || server.defaultAccess || 'allow',
                command: server.command || '',
                args: (server.args || []).map((a: string) => ({ id: crypto.randomUUID(), value: a })),
                env: Object.entries(server.env || {}).map(([k, v]) => ({ id: crypto.randomUUID(), key: k, value: String(v) })),
                envPassthrough: (server.envPassthrough || []).map((v: string) => ({ id: crypto.randomUUID(), value: v })),
                cwd: server.cwd || '',
                url: server.url || '',
                bearerTokenEnvVar: server.bearerTokenEnvVar || '',
                headers: Object.entries(server.headers || {}).map(([k, v]) => ({ id: crypto.randomUUID(), key: k, value: String(v) })),
                headersFromEnv: Object.entries(server.headersFromEnv || {}).map(([k, v]) => ({ id: crypto.randomUUID(), key: k, value: String(v) })),
            });
            setIsEditingMcp(true);
        }
    }, [editingMcpIndex, mcpServers]);

    const handleSaveTool = async () => {
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

    const handleSaveMcp = async () => {
        if (!mcpForm.name) return;

        const newServerConfig: any = {
            name: mcpForm.name,
            transport: mcpForm.transport,
            default_access: mcpForm.defaultAccess,
        };

        if (mcpForm.transport === 'stdio') {
            newServerConfig.command = mcpForm.command;
            if (mcpForm.args.length > 0) newServerConfig.args = mcpForm.args.map(a => a.value).filter(Boolean);
            if (mcpForm.env.length > 0) {
                newServerConfig.env = mcpForm.env.reduce((acc, curr) => {
                    if (curr.key) acc[curr.key] = curr.value;
                    return acc;
                }, {} as Record<string, string>);
            }
            if (mcpForm.envPassthrough.length > 0) newServerConfig.envPassthrough = mcpForm.envPassthrough.map(e => e.value).filter(Boolean);
            if (mcpForm.cwd) newServerConfig.cwd = mcpForm.cwd;
        } else {
            newServerConfig.url = mcpForm.url;
            if (mcpForm.bearerTokenEnvVar) newServerConfig.bearerTokenEnvVar = mcpForm.bearerTokenEnvVar;
            if (mcpForm.headers.length > 0) {
                newServerConfig.headers = mcpForm.headers.reduce((acc, curr) => {
                    if (curr.key) acc[curr.key] = curr.value;
                    return acc;
                }, {} as Record<string, string>);
            }
            if (mcpForm.headersFromEnv.length > 0) {
                newServerConfig.headersFromEnv = mcpForm.headersFromEnv.reduce((acc, curr) => {
                    if (curr.key) acc[curr.key] = curr.value;
                    return acc;
                }, {} as Record<string, string>);
            }
        }

        let updatedMcpServers = [...mcpServers];
        if (editingMcpIndex !== null) {
            updatedMcpServers[editingMcpIndex] = newServerConfig;
        } else {
            updatedMcpServers.push(newServerConfig);
        }

        await onSave({ ...config, mcp_servers: updatedMcpServers });
        setIsEditingMcp(false);
        setEditingMcpIndex(null);
        setMcpForm(EmptyMcpForm);
    };

    const handleDeleteMcp = async (index: number) => {
        if (!confirm('Delete this MCP server?')) return;
        const updatedMcp = [...mcpServers];
        updatedMcp.splice(index, 1);
        await onSave({ ...config, mcp_servers: updatedMcp });
    };

    // Helper to update arrays in state
    const updateArg = (id: string, value: string) => {
        setMcpForm(prev => ({ ...prev, args: prev.args.map(a => a.id === id ? { ...a, value } : a) }));
    };
    const removeArg = (id: string) => {
        setMcpForm(prev => ({ ...prev, args: prev.args.filter(a => a.id !== id) }));
    };
    const addArg = () => {
        setMcpForm(prev => ({ ...prev, args: [...prev.args, { id: crypto.randomUUID(), value: '' }] }));
    };

    // Helper helpers env
    const updateEnv = (id: string, field: 'key' | 'value', value: string) => {
        setMcpForm(prev => ({ ...prev, env: prev.env.map(e => e.id === id ? { ...e, [field]: value } : e) }));
    };
    const removeEnv = (id: string) => {
        setMcpForm(prev => ({ ...prev, env: prev.env.filter(e => e.id !== id) }));
    };
    const addEnv = () => {
        setMcpForm(prev => ({ ...prev, env: [...prev.env, { id: crypto.randomUUID(), key: '', value: '' }] }));
    };

    const updateEnvPassthrough = (id: string, value: string) => {
        setMcpForm(prev => ({ ...prev, envPassthrough: prev.envPassthrough.map(a => a.id === id ? { ...a, value } : a) }));
    };
    const removeEnvPassthrough = (id: string) => {
        setMcpForm(prev => ({ ...prev, envPassthrough: prev.envPassthrough.filter(a => a.id !== id) }));
    };
    const addEnvPassthrough = () => {
        setMcpForm(prev => ({ ...prev, envPassthrough: [...prev.envPassthrough, { id: crypto.randomUUID(), value: '' }] }));
    };

    // Helper helpers headers
    const updateHeader = (id: string, field: 'key' | 'value', value: string) => {
        setMcpForm(prev => ({ ...prev, headers: prev.headers.map(e => e.id === id ? { ...e, [field]: value } : e) }));
    };
    const removeHeader = (id: string) => {
        setMcpForm(prev => ({ ...prev, headers: prev.headers.filter(e => e.id !== id) }));
    };
    const addHeader = () => {
        setMcpForm(prev => ({ ...prev, headers: [...prev.headers, { id: crypto.randomUUID(), key: '', value: '' }] }));
    };

    const updateHeaderFromEnv = (id: string, field: 'key' | 'value', value: string) => {
        setMcpForm(prev => ({ ...prev, headersFromEnv: prev.headersFromEnv.map(e => e.id === id ? { ...e, [field]: value } : e) }));
    };
    const removeHeaderFromEnv = (id: string) => {
        setMcpForm(prev => ({ ...prev, headersFromEnv: prev.headersFromEnv.filter(e => e.id !== id) }));
    };
    const addHeaderFromEnv = () => {
        setMcpForm(prev => ({ ...prev, headersFromEnv: [...prev.headersFromEnv, { id: crypto.randomUUID(), key: '', value: '' }] }));
    };

    return (
        <div>
            <div className="flex gap-4 mb-6 border-b border-slate-200 pb-4">
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
                        <div className="mb-6 p-4 bg-slate-50 rounded-xl border border-slate-200 shadow-sm">
                            <div className="grid grid-cols-2 gap-4 mb-4">
                                <div>
                                    <label className="block text-xs font-medium text-slate-700 mb-1">Tool Name</label>
                                    <input type="text" value={newToolName} onChange={(e) => setNewToolName(e.target.value)} placeholder="e.g., google_search"
                                        className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:border-slate-500 focus:ring-1 focus:ring-slate-500 outline-none transition-all" />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-700 mb-1">Description</label>
                                    <input type="text" value={newToolDesc} onChange={(e) => setNewToolDesc(e.target.value)} placeholder="Description"
                                        className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:border-slate-500 focus:ring-1 focus:ring-slate-500 outline-none transition-all" />
                                </div>
                            </div>
                            <div className="flex justify-end gap-2">
                                <button onClick={() => setIsAddingTool(false)} className="px-3 py-1.5 text-slate-600 text-sm hover:bg-slate-200 rounded-lg">Cancel</button>
                                <button onClick={handleSaveTool} disabled={isSaving} className="flex items-center gap-2 px-3 py-1.5 bg-slate-900 text-white text-sm rounded-lg hover:bg-slate-800">
                                    {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                    Save
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="grid gap-3">
                        {tools.map((tool: any, idx: number) => (
                            <div key={idx} className="p-4 rounded-xl border border-slate-200 bg-white flex justify-between items-center shadow-sm">
                                <div>
                                    <p className="font-semibold text-slate-900">{tool.name}</p>
                                    <p className="text-sm text-slate-500">{tool.description}</p>
                                </div>
                                <button onClick={() => handleDeleteTool(idx)} className="p-2 text-slate-400 hover:text-rose-600 transition-colors">
                                    <Trash2 size={18} />
                                </button>
                            </div>
                        ))}
                        {tools.length === 0 && !isAddingTool && (
                            <p className="text-center text-slate-500 py-8">No built-in tools configured.</p>
                        )}
                    </div>
                </div>
            )}

            {activeSection === 'mcp' && (
                <div>
                    {!isEditingMcp ? (
                        <>
                            <div className="flex justify-between items-center mb-6">
                                <div>
                                    <h3 className="text-lg font-semibold text-slate-900">Connect to a custom MCP</h3>
                                    <p className="text-slate-500 text-sm flex items-center gap-1">Docs <ExternalLink size={10} /></p>
                                </div>
                                <button
                                    onClick={() => { setMcpForm(EmptyMcpForm); setEditingMcpIndex(null); setIsEditingMcp(true); }}
                                    className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 shadow-sm transition-all"
                                >
                                    <Plus size={16} />
                                    Add Server
                                </button>
                            </div>

                            <div className="grid gap-3">
                                {mcpServers.map((server: any, idx: number) => (
                                    <div key={idx} className="group p-4 rounded-xl border border-slate-200 bg-white hover:border-slate-300 transition-all shadow-sm">
                                        <div className="flex justify-between items-start">
                                            <div onClick={() => { setMcpForm(EmptyMcpForm); setEditingMcpIndex(idx); setIsEditingMcp(true); /* Will trigger effect */ }} className="cursor-pointer flex-1">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <p className="font-semibold text-slate-900">{server.name}</p>
                                                    <span className="text-[10px] font-mono px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded uppercase tracking-wider">{server.transport || 'stdio'}</span>
                                                </div>
                                                <p className="text-xs text-slate-500 font-mono truncate max-w-md">
                                                    {server.transport === 'stdio' ? server.command : server.url}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button onClick={() => { setMcpForm(EmptyMcpForm); setEditingMcpIndex(idx); setIsEditingMcp(true); }} className="p-2 text-slate-400 hover:text-slate-900 rounded-lg hover:bg-slate-50">
                                                    <Hammer size={16} />
                                                </button>
                                                <button onClick={() => handleDeleteMcp(idx)} className="p-2 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50">
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                                {mcpServers.length === 0 && (
                                    <div className="text-center py-12 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                                        <Server className="mx-auto text-slate-300 mb-3" size={32} />
                                        <p className="text-slate-500 font-medium">No MCP servers connected</p>
                                        <p className="text-slate-400 text-sm mt-1">Add a server to extend capabilities</p>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="bg-[#1C1C1E] text-slate-200 rounded-xl border border-[#2C2C2E] overflow-hidden shadow-2xl">
                            <div className="p-6">
                                <div className="flex justify-between items-center mb-6">
                                    <div>
                                        <h3 className="text-xl font-semibold text-white">Connect to a custom MCP</h3>
                                        <p className="text-[#8E8E93] text-sm flex items-center gap-1 hover:text-white cursor-pointer transition-colors">Docs <ExternalLink size={12} /></p>
                                    </div>
                                    <button onClick={() => setIsEditingMcp(false)} className="text-[#8E8E93] hover:text-white transition-colors">
                                        <X size={20} />
                                    </button>
                                </div>

                                <div className="space-y-5">
                                    <div className="space-y-1.5">
                                        <label className="block text-sm font-medium text-white">Name</label>
                                        <input
                                            type="text"
                                            value={mcpForm.name}
                                            onChange={(e) => setMcpForm(prev => ({ ...prev, name: e.target.value }))}
                                            placeholder="MCP server name"
                                            className="w-full px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm"
                                        />
                                    </div>

                                    <div className="grid grid-cols-2 bg-[#2C2C2E] p-1 rounded-lg">
                                        <button
                                            onClick={() => setMcpForm(prev => ({ ...prev, transport: 'stdio' }))}
                                            className={`py-1.5 text-sm font-medium rounded-md transition-all ${mcpForm.transport === 'stdio' ? 'bg-[#636366] text-white shadow-sm' : 'text-[#8E8E93] hover:text-white'}`}
                                        >
                                            STDIO
                                        </button>
                                        <button
                                            onClick={() => setMcpForm(prev => ({ ...prev, transport: 'http' }))}
                                            className={`py-1.5 text-sm font-medium rounded-md transition-all ${mcpForm.transport === 'http' ? 'bg-[#636366] text-white shadow-sm' : 'text-[#8E8E93] hover:text-white'}`}
                                        >
                                            Streamable HTTP
                                        </button>
                                    </div>

                                    <div className="space-y-1.5">
                                        <label className="block text-sm font-medium text-white">Default access</label>
                                        <div className="grid grid-cols-2 bg-[#2C2C2E] p-1 rounded-lg">
                                            <button
                                                onClick={() => setMcpForm(prev => ({ ...prev, defaultAccess: 'allow' }))}
                                                className={`py-1.5 text-sm font-medium rounded-md transition-all ${mcpForm.defaultAccess === 'allow' ? 'bg-[#636366] text-white shadow-sm' : 'text-[#8E8E93] hover:text-white'}`}
                                            >
                                                Allow
                                            </button>
                                            <button
                                                onClick={() => setMcpForm(prev => ({ ...prev, defaultAccess: 'deny' }))}
                                                className={`py-1.5 text-sm font-medium rounded-md transition-all ${mcpForm.defaultAccess === 'deny' ? 'bg-[#636366] text-white shadow-sm' : 'text-[#8E8E93] hover:text-white'}`}
                                            >
                                                Deny
                                            </button>
                                        </div>
                                        <p className="text-xs text-[#8E8E93]">
                                            For non-admins, servers default to <span className="font-mono">deny</span> require explicit allow.
                                        </p>
                                    </div>

                                    {mcpForm.transport === 'stdio' ? (
                                        <>
                                            <div className="space-y-1.5">
                                                <label className="block text-sm font-medium text-white">Command to launch</label>
                                                <input
                                                    type="text"
                                                    value={mcpForm.command}
                                                    onChange={(e) => setMcpForm(prev => ({ ...prev, command: e.target.value }))}
                                                    placeholder="openai-dev-mcp serve-sqlite"
                                                    className="w-full px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm font-mono"
                                                />
                                            </div>

                                            <div className="space-y-1.5">
                                                <label className="block text-sm font-medium text-white">Arguments</label>
                                                <div className="space-y-2">
                                                    {mcpForm.args.map((arg) => (
                                                        <div key={arg.id} className="flex gap-2">
                                                            <input
                                                                type="text"
                                                                value={arg.value}
                                                                onChange={(e) => updateArg(arg.id, e.target.value)}
                                                                className="flex-1 px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm font-mono"
                                                            />
                                                            <button onClick={() => removeArg(arg.id)} className="p-2 text-[#8E8E93] hover:text-rose-500 transition-colors">
                                                                <Trash2 size={16} />
                                                            </button>
                                                        </div>
                                                    ))}
                                                    <button onClick={addArg} className="w-full py-2 rounded-lg bg-[#2C2C2E] text-white hover:bg-[#3A3A3C] text-xs font-medium transition-colors border border-[#3A3A3C] flex items-center justify-center gap-2">
                                                        <Plus size={14} /> Add argument
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="space-y-1.5">
                                                <label className="block text-sm font-medium text-white">Environment variables</label>
                                                <div className="space-y-2">
                                                    {mcpForm.env.map((env) => (
                                                        <div key={env.id} className="flex gap-2">
                                                            <input
                                                                type="text"
                                                                placeholder="Key"
                                                                value={env.key}
                                                                onChange={(e) => updateEnv(env.id, 'key', e.target.value)}
                                                                className="flex-1 px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm font-mono"
                                                            />
                                                            <input
                                                                type="text"
                                                                placeholder="Value"
                                                                value={env.value}
                                                                onChange={(e) => updateEnv(env.id, 'value', e.target.value)}
                                                                className="flex-1 px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm font-mono"
                                                            />
                                                            <button onClick={() => removeEnv(env.id)} className="p-2 text-[#8E8E93] hover:text-rose-500 transition-colors">
                                                                <Trash2 size={16} />
                                                            </button>
                                                        </div>
                                                    ))}
                                                    <button onClick={addEnv} className="w-full py-2 rounded-lg bg-[#2C2C2E] text-white hover:bg-[#3A3A3C] text-xs font-medium transition-colors border border-[#3A3A3C] flex items-center justify-center gap-2">
                                                        <Plus size={14} /> Add environment variable
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="space-y-1.5">
                                                <label className="block text-sm font-medium text-white">Environment variable passthrough</label>
                                                <div className="space-y-2">
                                                    {mcpForm.envPassthrough.map((env) => (
                                                        <div key={env.id} className="flex gap-2">
                                                            <input
                                                                type="text"
                                                                value={env.value}
                                                                onChange={(e) => updateEnvPassthrough(env.id, e.target.value)}
                                                                className="flex-1 px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm font-mono"
                                                            />
                                                            <button onClick={() => removeEnvPassthrough(env.id)} className="p-2 text-[#8E8E93] hover:text-rose-500 transition-colors">
                                                                <Trash2 size={16} />
                                                            </button>
                                                        </div>
                                                    ))}
                                                    <button onClick={addEnvPassthrough} className="w-full py-2 rounded-lg bg-[#2C2C2E] text-white hover:bg-[#3A3A3C] text-xs font-medium transition-colors border border-[#3A3A3C] flex items-center justify-center gap-2">
                                                        <Plus size={14} /> Add variable
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="space-y-1.5">
                                                <label className="block text-sm font-medium text-white">Working directory</label>
                                                <input
                                                    type="text"
                                                    value={mcpForm.cwd}
                                                    onChange={(e) => setMcpForm(prev => ({ ...prev, cwd: e.target.value }))}
                                                    placeholder="~/code"
                                                    className="w-full px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm font-mono"
                                                />
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <div className="space-y-1.5">
                                                <label className="block text-sm font-medium text-white">URL</label>
                                                <input
                                                    type="text"
                                                    value={mcpForm.url}
                                                    onChange={(e) => setMcpForm(prev => ({ ...prev, url: e.target.value }))}
                                                    placeholder="https://mcp.example.com/mcp"
                                                    className="w-full px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm font-mono"
                                                />
                                            </div>

                                            <div className="space-y-1.5">
                                                <label className="block text-sm font-medium text-white">Bearer token env var</label>
                                                <input
                                                    type="text"
                                                    value={mcpForm.bearerTokenEnvVar}
                                                    onChange={(e) => setMcpForm(prev => ({ ...prev, bearerTokenEnvVar: e.target.value }))}
                                                    placeholder="MCP_BEARER_TOKEN"
                                                    className="w-full px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm font-mono"
                                                />
                                            </div>

                                            <div className="space-y-1.5">
                                                <label className="block text-sm font-medium text-white">Headers</label>
                                                <div className="space-y-2">
                                                    {mcpForm.headers.map((env) => (
                                                        <div key={env.id} className="flex gap-2">
                                                            <input
                                                                type="text"
                                                                placeholder="Key"
                                                                value={env.key}
                                                                onChange={(e) => updateHeader(env.id, 'key', e.target.value)}
                                                                className="flex-1 px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm font-mono"
                                                            />
                                                            <input
                                                                type="text"
                                                                placeholder="Value"
                                                                value={env.value}
                                                                onChange={(e) => updateHeader(env.id, 'value', e.target.value)}
                                                                className="flex-1 px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm font-mono"
                                                            />
                                                            <button onClick={() => removeHeader(env.id)} className="p-2 text-[#8E8E93] hover:text-rose-500 transition-colors">
                                                                <Trash2 size={16} />
                                                            </button>
                                                        </div>
                                                    ))}
                                                    <button onClick={addHeader} className="w-full py-2 rounded-lg bg-[#2C2C2E] text-white hover:bg-[#3A3A3C] text-xs font-medium transition-colors border border-[#3A3A3C] flex items-center justify-center gap-2">
                                                        <Plus size={14} /> Add header
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="space-y-1.5">
                                                <label className="block text-sm font-medium text-white">Headers from environment variables</label>
                                                <div className="space-y-2">
                                                    {mcpForm.headersFromEnv.map((env) => (
                                                        <div key={env.id} className="flex gap-2">
                                                            <input
                                                                type="text"
                                                                placeholder="Key"
                                                                value={env.key}
                                                                onChange={(e) => updateHeaderFromEnv(env.id, 'key', e.target.value)}
                                                                className="flex-1 px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm font-mono"
                                                            />
                                                            <input
                                                                type="text"
                                                                placeholder="Value"
                                                                value={env.value}
                                                                onChange={(e) => updateHeaderFromEnv(env.id, 'value', e.target.value)}
                                                                className="flex-1 px-3 py-2.5 rounded-lg border border-[#3A3A3C] bg-[#2C2C2E] text-white placeholder-[#8E8E93] focus:border-[#0A84FF] focus:ring-1 focus:ring-[#0A84FF] outline-none transition-all text-sm font-mono"
                                                            />
                                                            <button onClick={() => removeHeaderFromEnv(env.id)} className="p-2 text-[#8E8E93] hover:text-rose-500 transition-colors">
                                                                <Trash2 size={16} />
                                                            </button>
                                                        </div>
                                                    ))}
                                                    <button onClick={addHeaderFromEnv} className="w-full py-2 rounded-lg bg-[#2C2C2E] text-white hover:bg-[#3A3A3C] text-xs font-medium transition-colors border border-[#3A3A3C] flex items-center justify-center gap-2">
                                                        <Plus size={14} /> Add variable
                                                    </button>
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>

                                <div className="mt-8 flex justify-end">
                                    <button
                                        onClick={handleSaveMcp}
                                        disabled={isSaving}
                                        className="px-6 py-2 bg-[#F2F2F7] text-black rounded-lg font-medium hover:bg-white transition-colors disabled:opacity-50"
                                    >
                                        {isSaving ? 'Saving...' : 'Save'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default ToolsTab;

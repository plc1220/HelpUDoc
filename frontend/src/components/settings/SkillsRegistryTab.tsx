import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Loader2, Save, FolderOpen, AlertCircle, Search, ChevronRight } from 'lucide-react';
import Editor from '@monaco-editor/react';
import {
  createSkill,
  fetchSkillContent,
  fetchSkillFiles,
  fetchSkills,
  saveSkillContent,
} from '../../services/settingsApi';
import type { SkillDefinition } from '../../types';

const SkillsRegistryTab: React.FC = () => {
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isAdding, setIsAdding] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);

  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);

  const [searchTerm, setSearchTerm] = useState('');

  const loadSkills = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchSkills();
      setSkills(data);
      setError(null);
    } catch (err) {
      console.error('Failed to load skills', err);
      setError('Failed to load skills');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (!selectedSkillId && skills.length > 0) {
      setSelectedSkillId(skills[0].id);
    }
  }, [skills, selectedSkillId]);

  useEffect(() => {
    const loadFiles = async () => {
      if (!selectedSkillId) {
        setFiles([]);
        setSelectedFile(null);
        return;
      }
      try {
        setFilesLoading(true);
        const data = await fetchSkillFiles(selectedSkillId);
        setFiles(data);
        // Auto-select the main file (SKILL.md preferred, then README.md, then first file)
        if (data.length > 0) {
          const preferred = data.find(f => f === 'SKILL.md') || data.find(f => f === 'README.md') || data[0];
          setSelectedFile(preferred);
        } else {
          setSelectedFile(null);
        }
      } catch (err) {
        console.error('Failed to load skill files', err);
        setFiles([]);
      } finally {
        setFilesLoading(false);
      }
    };

    loadFiles();
  }, [selectedSkillId]);

  useEffect(() => {
    const loadContent = async () => {
      if (!selectedSkillId || !selectedFile) {
        setFileContent('');
        return;
      }
      try {
        setFileLoading(true);
        const content = await fetchSkillContent(selectedSkillId, selectedFile);
        setFileContent(content);
      } catch (err) {
        console.error('Failed to load skill file content', err);
        setFileContent('');
      } finally {
        setFileLoading(false);
      }
    };

    loadContent();
  }, [selectedSkillId, selectedFile]);

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === selectedSkillId) || null,
    [skills, selectedSkillId]
  );

  const filteredSkills = useMemo(() => {
    if (!searchTerm) return skills;
    const lower = searchTerm.toLowerCase();
    return skills.filter(s =>
      s.id.toLowerCase().includes(lower) ||
      (s.name && s.name.toLowerCase().includes(lower)) ||
      (s.description && s.description.toLowerCase().includes(lower))
    );
  }, [skills, searchTerm]);

  const handleCreateSkill = async () => {
    if (!newId) {
      setCreateError('Skill ID is required');
      return;
    }

    try {
      setCreateLoading(true);
      setCreateError(null);
      await createSkill({ id: newId, name: newName || undefined, description: newDesc || undefined });
      await loadSkills();
      setSelectedSkillId(newId);
      setIsAdding(false);
      setNewId('');
      setNewName('');
      setNewDesc('');
    } catch (err) {
      console.error('Failed to create skill', err);
      const message = err instanceof Error ? err.message : 'Failed to create skill';
      setCreateError(message);
    } finally {
      setCreateLoading(false);
    }
  };

  const handleSaveFile = async () => {
    if (!selectedSkillId || !selectedFile) {
      return;
    }
    try {
      setFileSaving(true);
      await saveSkillContent(selectedSkillId, selectedFile, fileContent);
    } catch (err) {
      console.error('Failed to save skill file', err);
      const message = err instanceof Error ? err.message : 'Failed to save skill file';
      alert(message);
    } finally {
      setFileSaving(false);
    }
  };

  const getLanguage = (fileName: string) => {
    if (fileName.endsWith('.json')) return 'json';
    if (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) return 'typescript';
    if (fileName.endsWith('.js') || fileName.endsWith('.jsx')) return 'javascript';
    if (fileName.endsWith('.py')) return 'python';
    if (fileName.endsWith('.md')) return 'markdown';
    if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) return 'yaml';
    if (fileName.endsWith('.css')) return 'css';
    if (fileName.endsWith('.html')) return 'html';
    return 'plaintext';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="animate-spin text-slate-400" size={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-rose-100 text-rose-600 mb-4">
          <AlertCircle size={24} />
        </div>
        <p className="text-rose-600 mb-4">{error}</p>
        <button
          onClick={loadSkills}
          className="px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ height: 'calc(100vh - 280px)', minHeight: '550px' }} className="flex gap-5">
      {/* Left Sidebar - Skills List */}
      <div className="w-72 flex-shrink-0 flex flex-col bg-white border border-slate-200 rounded-xl overflow-hidden">
        {/* Sidebar Header */}
        <div className="p-3 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Skills</span>
            <div className="flex items-center gap-1">
              <button
                onClick={loadSkills}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-colors"
                title="Refresh"
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>
          {/* Search */}
          <div className="relative mb-2">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-slate-400 transition-all"
            />
          </div>
          {/* Add Skill Button */}
          <button
            onClick={() => {
              setIsAdding(true);
              setCreateError(null);
              setNewId('');
              setNewName('');
              setNewDesc('');
            }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors"
          >
            <Plus size={16} />
            Add Skill
          </button>
        </div>

        {/* Add Skill Form (inline) */}
        {isAdding && (
          <div className="p-3 border-b border-slate-200 bg-amber-50">
            <div className="space-y-2">
              <input
                type="text"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="skill-id *"
                className="w-full px-2.5 py-1.5 rounded-md border border-slate-300 text-sm font-mono bg-white focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Display Name"
                className="w-full px-2.5 py-1.5 rounded-md border border-slate-300 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <input
                type="text"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Description"
                className="w-full px-2.5 py-1.5 rounded-md border border-slate-300 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              {createError && <p className="text-xs text-rose-600">{createError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={() => setIsAdding(false)}
                  className="flex-1 px-2 py-1.5 text-slate-600 text-sm hover:bg-slate-100 rounded-md transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateSkill}
                  disabled={createLoading}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-emerald-600 text-white text-sm rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50"
                >
                  {createLoading ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Create
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Skills List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {filteredSkills.map((skill) => (
            <button
              key={skill.id}
              onClick={() => setSelectedSkillId(skill.id)}
              className={`w-full text-left p-2.5 rounded-lg border transition-all ${selectedSkillId === skill.id
                ? 'border-slate-400 bg-slate-100'
                : 'border-transparent hover:bg-slate-50'
                }`}
            >
              <div className="flex items-center gap-2">
                {/* Status Dot */}
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${skill.valid ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                <span className="font-medium text-slate-900 truncate text-sm">{skill.name || skill.id}</span>
              </div>
              <p className="text-xs font-mono text-slate-400 mt-0.5 ml-4">{skill.id}</p>
              {skill.description && (
                <p className="text-xs text-slate-500 mt-1 ml-4 line-clamp-2">{skill.description}</p>
              )}
            </button>
          ))}
          {filteredSkills.length === 0 && (
            <div className="text-center py-8 text-slate-400 text-sm">
              {searchTerm ? 'No skills match your search.' : 'No skills yet.'}
            </div>
          )}
        </div>
      </div>

      {/* Right Panel - Editor Area */}
      <div className="flex-1 flex flex-col bg-white border border-slate-200 rounded-xl overflow-hidden">
        {selectedSkill ? (
          <>
            {/* Editor Header / Toolbar */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2 min-w-0">
                {/* Breadcrumb */}
                <span className="font-medium text-slate-700 truncate">{selectedSkill.name || selectedSkill.id}</span>
                {selectedFile && (
                  <>
                    <ChevronRight size={14} className="text-slate-400 flex-shrink-0" />
                    <span className="text-sm font-mono text-slate-500 truncate">{selectedFile}</span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={handleSaveFile}
                  disabled={!selectedFile || fileSaving}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 transition-colors font-medium"
                >
                  {fileSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Save
                </button>
              </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 flex min-h-0">
              {/* Files Sidebar (thin) */}
              <div className="w-40 flex-shrink-0 border-r border-slate-200 bg-slate-50 flex flex-col">
                <div className="p-2 border-b border-slate-100">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                    <FolderOpen size={12} />
                    Files
                  </div>
                </div>
                {filesLoading ? (
                  <div className="flex-1 flex items-center justify-center">
                    <Loader2 size={16} className="animate-spin text-slate-400" />
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto py-1">
                    {files.map((file) => (
                      <button
                        key={file}
                        onClick={() => setSelectedFile(file)}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors truncate ${selectedFile === file
                          ? 'bg-white text-emerald-700 font-medium border-l-2 border-emerald-500'
                          : 'text-slate-600 hover:bg-slate-100 border-l-2 border-transparent'
                          }`}
                        title={file}
                      >
                        {file}
                      </button>
                    ))}
                    {files.length === 0 && (
                      <p className="text-xs text-slate-400 p-3 text-center italic">No files</p>
                    )}
                  </div>
                )}
              </div>

              {/* Code Editor */}
              <div className="flex-1 relative bg-[#1e1e1e]">
                {fileLoading ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-[#1e1e1e]">
                    <Loader2 size={24} className="animate-spin text-slate-500" />
                  </div>
                ) : selectedFile ? (
                  <Editor
                    height="100%"
                    theme="vs-dark"
                    language={getLanguage(selectedFile)}
                    value={fileContent}
                    onChange={(value) => setFileContent(value || '')}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineHeight: 20,
                      wordWrap: 'on',
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      padding: { top: 12, bottom: 12 },
                      lineNumbers: 'on',
                      renderLineHighlight: 'line',
                      cursorBlinking: 'smooth',
                      smoothScrolling: true,
                    }}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-slate-500 bg-slate-100">
                    <p className="text-sm">Select a file to edit</p>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 bg-slate-50">
            <FolderOpen size={40} className="mb-3 opacity-20" />
            <p className="font-medium text-slate-500">No skill selected</p>
            <p className="text-sm mt-1">Select a skill from the list to view and edit its files.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default SkillsRegistryTab;

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Loader2, Save, FileText } from 'lucide-react';
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

  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);

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
        setSelectedFile(null);
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

  const handleCreateSkill = async () => {
    if (!newId) {
      setCreateError('Skill id is required');
      return;
    }

    try {
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
          onClick={loadSkills}
          className="px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Skill Registry</h3>
          <p className="text-slate-500 text-sm">Create and manage reusable skills for your assistant.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadSkills}
            className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 rounded-lg hover:bg-slate-100"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          <button
            onClick={() => {
              setIsAdding(true);
              setCreateError(null);
              setNewId('');
              setNewName('');
              setNewDesc('');
            }}
            className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800"
          >
            <Plus size={16} />
            Add Skill
          </button>
        </div>
      </div>

      {isAdding && (
        <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
          <h4 className="font-medium text-slate-900 mb-4">New Skill</h4>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Skill ID</label>
              <input
                type="text"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="e.g., data-cleaning"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Display Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Skill name"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">Description</label>
              <input
                type="text"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="What this skill is for"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
              />
            </div>
          </div>
          {createError && <p className="text-sm text-rose-600 mb-3">{createError}</p>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setIsAdding(false);
                setCreateError(null);
              }}
              className="px-3 py-1.5 text-slate-600 text-sm hover:bg-slate-200 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateSkill}
              className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700"
            >
              <Save size={14} />
              Save Skill
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        <div className="space-y-3">
          {skills.map((skill) => (
            <button
              key={skill.id}
              onClick={() => setSelectedSkillId(skill.id)}
              className={`w-full text-left p-3 rounded-xl border transition-colors ${selectedSkillId === skill.id
                ? 'border-slate-900 bg-slate-50'
                : 'border-slate-200 hover:border-slate-400 hover:bg-slate-50'
                }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-slate-900">{skill.name || skill.id}</p>
                  <p className="text-xs text-slate-500 font-mono">{skill.id}</p>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${skill.valid
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-amber-100 text-amber-700'
                    }`}
                >
                  {skill.valid ? 'Ready' : 'Needs attention'}
                </span>
              </div>
              <p className="text-sm text-slate-500 mt-2">
                {skill.description || skill.warning || skill.error || 'No description available.'}
              </p>
            </button>
          ))}
          {skills.length === 0 && (
            <div className="text-center py-8 text-slate-500">No skills yet. Add one to get started.</div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 min-h-[360px]">
          {selectedSkill ? (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between">
                  <h4 className="text-lg font-semibold text-slate-900">{selectedSkill.name || selectedSkill.id}</h4>
                  <span className="text-xs font-mono px-2 py-0.5 bg-slate-200 text-slate-600 rounded-full">
                    {selectedSkill.id}
                  </span>
                </div>
                <p className="text-sm text-slate-600 mt-1">
                  {selectedSkill.description || 'No description provided.'}
                </p>
                {selectedSkill.error && (
                  <p className="text-sm text-rose-600 mt-2">{selectedSkill.error}</p>
                )}
                {selectedSkill.warning && !selectedSkill.error && (
                  <p className="text-sm text-amber-600 mt-2">{selectedSkill.warning}</p>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-4">
                <div className="bg-white rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500 mb-2">
                    <FileText size={14} />
                    Files
                  </div>
                  {filesLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 size={18} className="animate-spin text-slate-400" />
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {files.map((file) => (
                        <button
                          key={file}
                          onClick={() => setSelectedFile(file)}
                          className={`w-full text-left px-2 py-1 rounded-md text-sm ${selectedFile === file
                            ? 'bg-slate-900 text-white'
                            : 'text-slate-600 hover:bg-slate-100'
                            }`}
                        >
                          {file}
                        </button>
                      ))}
                      {files.length === 0 && (
                        <p className="text-sm text-slate-500">No files yet.</p>
                      )}
                    </div>
                  )}
                </div>

                <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-col">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs uppercase tracking-wide text-slate-500">
                      {selectedFile || 'Select a file'}
                    </div>
                    <button
                      onClick={handleSaveFile}
                      disabled={!selectedFile || fileSaving}
                      className="flex items-center gap-2 px-2.5 py-1 text-xs bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {fileSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                      Save
                    </button>
                  </div>
                  {fileLoading ? (
                    <div className="flex-1 flex items-center justify-center py-10">
                      <Loader2 size={20} className="animate-spin text-slate-400" />
                    </div>
                  ) : (
                    <textarea
                      value={fileContent}
                      onChange={(e) => setFileContent(e.target.value)}
                      placeholder="Select a file to view or edit its contents."
                      className="flex-1 w-full min-h-[220px] resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900"
                      disabled={!selectedFile}
                    />
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-slate-500">
              Select a skill to view its files.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SkillsRegistryTab;

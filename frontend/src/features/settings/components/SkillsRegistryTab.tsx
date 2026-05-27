import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronRight,
  FolderOpen,
  Loader2,
  Lock,
  RefreshCw,
  Search,
} from 'lucide-react';
import {
  fetchSkillContent,
  fetchSkillFiles,
  fetchSkills,
} from '../../../services/settingsApi';
import type { SkillDefinition } from '../../../types';
import EditorLoadingState from '../../../components/EditorLoadingState';

const MonacoEditor = lazy(() => import('@monaco-editor/react'));

const workbenchColumnClass = 'settings-workbench-column flex flex-col overflow-hidden rounded-xl';

const SkillsRegistryTab: React.FC = () => {
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);

  const [searchTerm, setSearchTerm] = useState('');

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === selectedSkillId) || null,
    [skills, selectedSkillId],
  );

  const filteredSkills = useMemo(() => {
    if (!searchTerm) return skills;
    const lower = searchTerm.toLowerCase();
    return skills.filter(
      (skill) =>
        skill.id.toLowerCase().includes(lower)
        || (skill.name && skill.name.toLowerCase().includes(lower))
        || (skill.description && skill.description.toLowerCase().includes(lower)),
    );
  }, [skills, searchTerm]);

  const loadSkills = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchSkills();
      setSkills(data);
      setError(null);
    } catch (err) {
      console.error('Failed to load skills', err);
      setError(err instanceof Error ? err.message : 'Failed to load skills');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSkills();
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
        if (data.length > 0) {
          const preferred = data.find((file) => file === 'SKILL.md') || data[0];
          setSelectedFile(preferred);
        } else {
          setSelectedFile(null);
        }
      } catch (err) {
        console.error('Failed to load skill files', err);
        setFiles([]);
        setSelectedFile(null);
      } finally {
        setFilesLoading(false);
      }
    };

    void loadFiles();
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

    void loadContent();
  }, [selectedSkillId, selectedFile]);

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
          onClick={() => void loadSkills()}
          className="settings-button-primary rounded-lg px-4 py-2 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ height: 'calc(100vh - 260px)', minHeight: '620px' }} className="settings-workbench flex gap-4">
      <div className={`w-80 flex-shrink-0 ${workbenchColumnClass}`}>
        <div className="p-3 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Skills</span>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">
                <Lock size={12} />
                CD-managed
              </span>
              <button
                onClick={() => void loadSkills()}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-colors"
                title="Refresh"
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search..."
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-slate-400 transition-all"
            />
          </div>
        </div>

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
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${skill.valid ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                <span className="font-medium text-slate-900 truncate text-sm">{skill.name || skill.id}</span>
              </div>
              <p className="text-xs font-mono text-slate-400 mt-0.5 ml-4">{skill.id}</p>
              {skill.description && <p className="text-xs text-slate-500 mt-1 ml-4 line-clamp-2">{skill.description}</p>}
            </button>
          ))}
          {filteredSkills.length === 0 && (
            <div className="text-center py-8 text-slate-400 text-sm">
              {searchTerm ? 'No skills match your search.' : 'No skills found.'}
            </div>
          )}
        </div>
      </div>

      <div className={`flex-1 ${workbenchColumnClass}`}>
        {selectedSkill ? (
          <>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium text-slate-700 truncate">{selectedSkill.name || selectedSkill.id}</span>
                {selectedFile && (
                  <>
                    <ChevronRight size={14} className="text-slate-400 flex-shrink-0" />
                    <span className="text-sm font-mono text-slate-500 truncate">{selectedFile}</span>
                  </>
                )}
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600">
                <Lock size={12} />
                Read only
              </span>
            </div>

            <div className="flex-1 flex min-h-0">
              <div className="w-44 flex-shrink-0 border-r border-slate-200 bg-slate-50 flex flex-col">
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
                  </div>
                )}
              </div>

              <div className="settings-workbench-editor flex-1 relative">
                {fileLoading ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-[#1e1e1e]">
                    <Loader2 size={24} className="animate-spin text-slate-500" />
                  </div>
                ) : selectedFile ? (
                  <Suspense fallback={<EditorLoadingState />}>
                    <MonacoEditor
                      height="100%"
                      theme="vs-dark"
                      language={getLanguage(selectedFile)}
                      value={fileContent}
                      options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        fontSize: 13,
                        lineHeight: 20,
                        wordWrap: 'on',
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        padding: { top: 12, bottom: 12 },
                      }}
                    />
                  </Suspense>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-slate-500 bg-slate-100">
                    <p className="text-sm">Select a file</p>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 bg-slate-50">
            <FolderOpen size={40} className="mb-3 opacity-20" />
            <p className="font-medium text-slate-500">No skill selected</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default SkillsRegistryTab;

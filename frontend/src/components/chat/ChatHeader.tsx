import { Brain, ChevronRight, History, Maximize2, Minimize2, Plus } from 'lucide-react';
import type { ChangeEvent } from 'react';

import type { AgentPersona } from '../../types';

export default function ChatHeader({
  colorMode,
  isAgentPaneVisible,
  isEditMode,
  isHistoryOpen,
  isAgentPaneFullScreen,
  personas,
  selectedPersona,
  onToggleVisibility,
  onModeChange,
  onToggleHistory,
  onOpenMemory,
  onNewChat,
  onToggleFullScreen,
}: {
  colorMode: 'light' | 'dark';
  isAgentPaneVisible: boolean;
  isEditMode: boolean;
  isHistoryOpen: boolean;
  isAgentPaneFullScreen: boolean;
  personas: AgentPersona[];
  selectedPersona: string;
  onToggleVisibility: () => void;
  onModeChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onToggleHistory: () => void;
  onOpenMemory: () => void;
  onNewChat: () => void;
  onToggleFullScreen: () => void;
}) {
  const isDarkMode = colorMode === 'dark';
  return (
    <div className={`sticky top-0 z-30 border-b px-4 py-3 backdrop-blur-md ${
      isDarkMode ? 'border-slate-700/70 bg-slate-950/60' : 'border-slate-200/70 bg-white/80'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleVisibility}
            className={`rounded-xl p-2 transition-all duration-200 ${
              isDarkMode ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
            }`}
            disabled={isEditMode}
            aria-label={isAgentPaneVisible ? 'Collapse chat pane' : 'Expand chat pane'}
          >
            <ChevronRight
              size={18}
              className={`transition-transform duration-300 ${isAgentPaneVisible ? '' : 'rotate-180'}`}
            />
          </button>
          {isAgentPaneVisible && (
            <div className="flex items-center gap-2">
              <span className={`text-[11px] font-semibold uppercase tracking-wide ${
                isDarkMode ? 'text-slate-400' : 'text-slate-500'
              }`}>Mode</span>
              <select
                value={selectedPersona}
                onChange={onModeChange}
                className={`rounded-xl border px-2.5 py-1 text-sm font-semibold shadow-sm transition-all duration-200 focus:outline-none ${
                  isDarkMode
                    ? 'border-slate-700/80 bg-slate-800/90 text-slate-100 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20'
                    : 'border-slate-200/80 bg-slate-100/90 text-slate-700 focus:border-blue-400 focus:ring-2 focus:ring-blue-200'
                }`}
                aria-label="Select agent mode"
                disabled={!personas.length}
              >
                {personas.map((persona) => (
                  <option key={persona.name} value={persona.name}>
                    {persona.displayName || persona.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {isAgentPaneVisible && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenMemory}
              className={`rounded-xl p-2 transition-all duration-200 ${
                isDarkMode ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
              }`}
              title="Open memory panel"
              aria-label="Open memory panel"
            >
              <Brain size={18} />
            </button>
            <button
              type="button"
              onClick={onToggleHistory}
              className={`rounded-xl p-2 transition-all duration-200 ${
                isHistoryOpen
                  ? isDarkMode
                    ? 'bg-sky-500/14 text-sky-200 ring-1 ring-sky-400/35'
                    : 'bg-blue-50 text-blue-600 ring-1 ring-blue-200'
                  : isDarkMode
                    ? 'text-slate-300 hover:bg-slate-800'
                    : 'text-slate-600 hover:bg-slate-100'
              }`}
              title="Recent conversations"
              aria-pressed={isHistoryOpen}
              aria-label="Toggle recent conversations"
            >
              <History size={18} />
            </button>
            <span className={`h-5 w-px ${isDarkMode ? 'bg-slate-700' : 'bg-slate-200'}`} aria-hidden="true" />
            <button
              onClick={onNewChat}
              className={`rounded-xl p-2 transition-all duration-200 ${
                isDarkMode ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
              }`}
              title="Start new chat"
              aria-label="Start new chat"
            >
              <Plus size={18} />
            </button>
            <button
              onClick={onToggleFullScreen}
              className={`rounded-xl p-2 transition-all duration-200 ${
                isDarkMode ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
              }`}
              title={isAgentPaneFullScreen ? 'Exit full screen chat' : 'Enter full screen chat'}
              aria-label={isAgentPaneFullScreen ? 'Exit full screen chat' : 'Enter full screen chat'}
            >
              {isAgentPaneFullScreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

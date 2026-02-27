import { ChevronRight, History, Maximize2, Minimize2, Plus } from 'lucide-react';
import type { ChangeEvent } from 'react';

import type { AgentPersona } from '../../types';

export default function ChatHeader({
  isAgentPaneVisible,
  isEditMode,
  isHistoryOpen,
  isAgentPaneFullScreen,
  personas,
  selectedPersona,
  onToggleVisibility,
  onModeChange,
  onToggleHistory,
  onNewChat,
  onToggleFullScreen,
}: {
  isAgentPaneVisible: boolean;
  isEditMode: boolean;
  isHistoryOpen: boolean;
  isAgentPaneFullScreen: boolean;
  personas: AgentPersona[];
  selectedPersona: string;
  onToggleVisibility: () => void;
  onModeChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onToggleHistory: () => void;
  onNewChat: () => void;
  onToggleFullScreen: () => void;
}) {
  return (
    <div className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/80 px-4 py-3 backdrop-blur-md">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleVisibility}
            className="rounded-xl p-2 text-slate-600 transition-all duration-200 hover:bg-slate-100"
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
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Mode</span>
              <select
                value={selectedPersona}
                onChange={onModeChange}
                className="rounded-xl border border-slate-200/80 bg-slate-100/90 px-2.5 py-1 text-sm font-semibold text-slate-700 shadow-sm transition-all duration-200 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200"
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
              onClick={onToggleHistory}
              className={`rounded-xl p-2 transition-all duration-200 ${
                isHistoryOpen
                  ? 'bg-blue-50 text-blue-600 ring-1 ring-blue-200'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
              title="Recent conversations"
              aria-pressed={isHistoryOpen}
              aria-label="Toggle recent conversations"
            >
              <History size={18} />
            </button>
            <span className="h-5 w-px bg-slate-200" aria-hidden="true" />
            <button
              onClick={onNewChat}
              className="rounded-xl p-2 text-slate-600 transition-all duration-200 hover:bg-slate-100"
              title="Start new chat"
              aria-label="Start new chat"
            >
              <Plus size={18} />
            </button>
            <button
              onClick={onToggleFullScreen}
              className="rounded-xl p-2 text-slate-600 transition-all duration-200 hover:bg-slate-100"
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

import { CalendarClock, ChevronRight, History, Maximize2, Minimize2, Plus } from 'lucide-react';
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
  onNewChat,
  onScheduleChat,
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
  onNewChat: () => void;
  onScheduleChat?: () => void;
  onToggleFullScreen: () => void;
}) {
  const isDarkMode = colorMode === 'dark';
  return (
    <div className={`sticky top-0 z-30 border-b px-3 py-2.5 backdrop-blur-md ${
      isDarkMode ? 'border-[#223047]/70 bg-[#0d1524]/92' : 'border-slate-200/70 bg-white/80'
    }`}>
      <div className="flex min-w-0 items-center justify-between gap-1">
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
          <button
            onClick={onToggleVisibility}
            className={`shrink-0 rounded-xl p-1 transition-all duration-200 sm:p-1.5 ${
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
            <div className="flex min-w-0 items-center gap-1 sm:gap-2">
              <span className={`hidden text-[10px] font-semibold uppercase tracking-wide sm:inline ${
                isDarkMode ? 'text-slate-400' : 'text-slate-500'
              }`}>Mode</span>
              <select
                value={selectedPersona}
                onChange={onModeChange}
                className={`max-w-20 rounded-xl border px-2 py-1 text-xs font-semibold shadow-sm transition-all duration-200 focus:outline-none sm:max-w-none sm:px-2.5 ${
                  isDarkMode
                    ? 'border-[#2b3a55] bg-[#152033] text-slate-100 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20'
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
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <button
              type="button"
              onClick={onToggleHistory}
              className={`rounded-xl p-1 transition-all duration-200 sm:p-1.5 ${
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
            <span className={`hidden h-5 w-px sm:block ${isDarkMode ? 'bg-slate-700' : 'bg-slate-200'}`} aria-hidden="true" />
            <button
              onClick={onNewChat}
              className={`rounded-xl p-1 transition-all duration-200 sm:p-1.5 ${
                isDarkMode ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
              }`}
              title="Start new chat"
              aria-label="Start new chat"
            >
              <Plus size={18} />
            </button>
            {onScheduleChat ? (
              <button
                onClick={onScheduleChat}
                className={`rounded-xl p-1 transition-all duration-200 sm:p-1.5 ${
                  isDarkMode ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
                }`}
                title="Schedule this chat"
                aria-label="Schedule this chat"
              >
                <CalendarClock size={18} />
              </button>
            ) : null}
            <button
              onClick={onToggleFullScreen}
              className={`rounded-xl p-1 transition-all duration-200 sm:p-1.5 ${
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

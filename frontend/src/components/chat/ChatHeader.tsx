import { CalendarClock, ChevronRight, History, Maximize2, Minimize2, Plus } from 'lucide-react';
export default function ChatHeader({
  colorMode,
  isAgentPaneVisible,
  isEditMode,
  isHistoryOpen,
  isAgentPaneFullScreen,
  onToggleVisibility,
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
  onToggleVisibility: () => void;
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

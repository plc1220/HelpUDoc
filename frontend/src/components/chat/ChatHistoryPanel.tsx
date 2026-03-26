import { Loader2, Trash, X } from 'lucide-react';

import type { AgentPersona, ConversationSummary } from '../../types';

type ConversationStreamingMap = Record<string, boolean>;

const normalizePersonaName = (name: string): string => {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized || normalized === 'general-assistant') {
    return 'fast';
  }
  return normalized === 'pro' ? 'pro' : 'fast';
};

export default function ChatHistoryPanel({
  colorMode,
  isHistoryOpen,
  conversationHistory,
  activeConversationId,
  conversationStreaming,
  personas,
  onClose,
  onSelectConversation,
  onDeleteConversation,
}: {
  colorMode: 'light' | 'dark';
  isHistoryOpen: boolean;
  conversationHistory: ConversationSummary[];
  activeConversationId: string | null;
  conversationStreaming: ConversationStreamingMap;
  personas: AgentPersona[];
  onClose: () => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
}) {
  const isDarkMode = colorMode === 'dark';
  return (
    <>
      {isHistoryOpen && (
        <button
          type="button"
          aria-label="Close history panel"
          onClick={onClose}
          className={`absolute inset-0 z-10 backdrop-blur-sm ${
            isDarkMode ? 'bg-slate-950/55' : 'bg-slate-900/18'
          }`}
        />
      )}
      <div
        className={`absolute inset-y-0 right-0 z-20 flex w-80 max-w-[90%] flex-col border-l shadow-2xl backdrop-blur-md transition-transform duration-200 ${
          isDarkMode
            ? 'border-slate-700/70 bg-slate-950/92 ring-1 ring-white/5'
            : 'border-slate-200/80 bg-white/92 ring-1 ring-slate-200/60'
        } ${
          isHistoryOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
        }`}
        aria-hidden={!isHistoryOpen}
      >
        <div className={`flex items-center justify-between border-b px-4 py-3 ${
          isDarkMode ? 'border-slate-700/70' : 'border-slate-200/80'
        }`}>
          <div>
            <p className={`text-sm font-semibold ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>Recent Conversations</p>
            <p className={`mt-0.5 text-[11px] uppercase tracking-[0.18em] ${
              isDarkMode ? 'text-slate-500' : 'text-slate-400'
            }`}>History</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`rounded-full p-1.5 transition-all duration-200 ${
              isDarkMode
                ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
            }`}
            aria-label="Close history"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {conversationHistory.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className={`rounded-3xl border px-5 py-5 ${
                isDarkMode
                  ? 'border-slate-700/70 bg-slate-900/85 shadow-[0_24px_60px_-36px_rgba(15,23,42,0.98)]'
                  : 'border-slate-200/80 bg-white/90 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.18)]'
              }`}>
                <p className={`text-sm font-medium ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>No conversations yet</p>
                <p className={`mt-1 text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Start a new chat to build your history.</p>
              </div>
            </div>
          ) : (
            conversationHistory.map((conversation) => {
              const isActive = conversation.id === activeConversationId;
              const isConversationStreaming = conversationStreaming[conversation.id];
              const normalizedPersona = normalizePersonaName(conversation.persona);
              const personaLabel =
                personas.find((persona) => persona.name === normalizedPersona)?.displayName || normalizedPersona;
              return (
                <div key={conversation.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectConversation(conversation.id);
                      onClose();
                    }}
                    className={`w-full rounded-2xl border p-3 pr-9 text-left transition-all duration-200 ${
                      isActive
                        ? isDarkMode
                          ? 'border-sky-500/45 bg-sky-500/10 shadow-[0_16px_40px_-28px_rgba(14,165,233,0.55)]'
                          : 'border-sky-300/80 bg-sky-50/90 shadow-[0_16px_40px_-28px_rgba(14,165,233,0.18)]'
                        : isDarkMode
                          ? 'border-slate-800 bg-slate-900/70 hover:border-slate-700 hover:bg-slate-900'
                          : 'border-slate-200 bg-white/92 hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <p className={`truncate text-sm font-medium ${
                      isActive
                        ? isDarkMode ? 'text-slate-50' : 'text-sky-900'
                        : isDarkMode ? 'text-slate-200' : 'text-slate-800'
                    }`}>{conversation.title}</p>
                    <p className={`mt-1 flex items-center gap-1 text-xs ${
                      isActive
                        ? isDarkMode ? 'text-sky-100/80' : 'text-sky-700'
                        : isDarkMode ? 'text-slate-500' : 'text-slate-500'
                    }`}>
                      {isConversationStreaming ? <Loader2 size={12} className={`animate-spin ${isDarkMode ? 'text-sky-300' : 'text-sky-500'}`} /> : null}
                      <span>
                        Mode: {personaLabel} · {new Date(conversation.updatedAt).toLocaleString()}
                      </span>
                    </p>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete conversation"
                    className={`absolute right-2 top-2 rounded-md p-1 opacity-0 transition-all duration-200 group-hover:opacity-100 focus:opacity-100 ${
                      isDarkMode
                        ? 'text-slate-500 hover:bg-rose-500/10 hover:text-rose-300'
                        : 'text-slate-400 hover:bg-rose-50 hover:text-rose-600'
                    }`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteConversation(conversation.id);
                    }}
                  >
                    <Trash size={14} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

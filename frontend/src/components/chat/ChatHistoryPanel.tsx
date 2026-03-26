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
  isHistoryOpen,
  conversationHistory,
  activeConversationId,
  conversationStreaming,
  personas,
  onClose,
  onSelectConversation,
  onDeleteConversation,
}: {
  isHistoryOpen: boolean;
  conversationHistory: ConversationSummary[];
  activeConversationId: string | null;
  conversationStreaming: ConversationStreamingMap;
  personas: AgentPersona[];
  onClose: () => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
}) {
  return (
    <>
      {isHistoryOpen && (
        <button
          type="button"
          aria-label="Close history panel"
          onClick={onClose}
          className="absolute inset-0 z-10 bg-slate-950/55 backdrop-blur-sm"
        />
      )}
      <div
        className={`absolute inset-y-0 right-0 z-20 flex w-80 max-w-[90%] flex-col border-l border-slate-700/70 bg-slate-950/92 shadow-2xl ring-1 ring-white/5 backdrop-blur-md transition-transform duration-200 ${
          isHistoryOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
        }`}
        aria-hidden={!isHistoryOpen}
      >
        <div className="flex items-center justify-between border-b border-slate-700/70 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-100">Recent Conversations</p>
            <p className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-slate-500">History</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-slate-400 transition-all duration-200 hover:bg-slate-800 hover:text-slate-100"
            aria-label="Close history"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {conversationHistory.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="rounded-3xl border border-slate-700/70 bg-slate-900/85 px-5 py-5 shadow-[0_24px_60px_-36px_rgba(15,23,42,0.98)]">
                <p className="text-sm font-medium text-slate-100">No conversations yet</p>
                <p className="mt-1 text-xs text-slate-400">Start a new chat to build your history.</p>
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
                        ? 'border-sky-500/45 bg-sky-500/10 shadow-[0_16px_40px_-28px_rgba(14,165,233,0.55)]'
                        : 'border-slate-800 bg-slate-900/70 hover:border-slate-700 hover:bg-slate-900'
                    }`}
                  >
                    <p className={`truncate text-sm font-medium ${isActive ? 'text-slate-50' : 'text-slate-200'}`}>{conversation.title}</p>
                    <p className={`mt-1 flex items-center gap-1 text-xs ${isActive ? 'text-sky-100/80' : 'text-slate-500'}`}>
                      {isConversationStreaming ? <Loader2 size={12} className="animate-spin text-sky-300" /> : null}
                      <span>
                        Mode: {personaLabel} · {new Date(conversation.updatedAt).toLocaleString()}
                      </span>
                    </p>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete conversation"
                    className="absolute right-2 top-2 rounded-md p-1 text-slate-500 opacity-0 transition-all duration-200 hover:bg-rose-500/10 hover:text-rose-300 group-hover:opacity-100 focus:opacity-100"
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

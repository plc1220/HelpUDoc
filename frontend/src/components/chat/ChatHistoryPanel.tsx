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
          className="absolute inset-0 z-10 bg-slate-900/20 backdrop-blur-sm"
        />
      )}
      <div
        className={`absolute inset-y-0 right-0 z-20 flex w-80 max-w-[90%] flex-col border-l border-slate-200/80 bg-white/90 shadow-2xl ring-1 ring-black/10 backdrop-blur-md transition-transform duration-200 ${
          isHistoryOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
        }`}
        aria-hidden={!isHistoryOpen}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <p className="text-sm font-semibold text-slate-700">Recent Conversations</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-slate-500 transition-all duration-200 hover:bg-slate-100"
            aria-label="Close history"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {conversationHistory.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 shadow-sm">
                <p className="text-sm font-medium text-slate-600">No conversations yet</p>
                <p className="mt-1 text-xs text-slate-500">Start a new chat to build your history.</p>
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
                    className={`w-full rounded-xl border p-2 pr-9 text-left transition-all duration-200 ${
                      isActive
                        ? 'border-blue-500 bg-blue-50 shadow-sm'
                        : 'border-slate-200 hover:border-blue-300 hover:bg-slate-50'
                    }`}
                  >
                    <p className="truncate text-sm font-medium text-slate-800">{conversation.title}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
                      {isConversationStreaming ? <Loader2 size={12} className="animate-spin text-blue-500" /> : null}
                      <span>
                        Mode: {personaLabel} · {new Date(conversation.updatedAt).toLocaleString()}
                      </span>
                    </p>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete conversation"
                    className="absolute right-1 top-1 rounded-md p-1 text-slate-400 opacity-0 transition-all duration-200 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
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

import { Button } from '@astryxdesign/core/Button';
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import { ChatToolCalls } from '@astryxdesign/core/Chat';
import { TextArea } from '@astryxdesign/core/TextArea';
import {
  AtSign,
  Bot,
  FileText,
  MessageCircle,
  MoreHorizontal,
  Reply,
  Send,
  StickyNote,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Workspace } from '../../types';
import {
  createWorkspaceCollaborationObject,
  invokeLumoForWorkspaceTeamMessage,
  listWorkspaceTeamMessages,
  postWorkspaceTeamMessage,
  type WorkspaceCollaborationObjectType,
  type WorkspaceTeamMessage,
} from '../../services/workspaceCollaborationApi';
import {
  listWorkspaceCollaborators,
  type WorkspaceCollaborator,
} from '../../services/workspaceApi';

type CollaborationConversion = {
  label: string;
  type: WorkspaceCollaborationObjectType;
  visibility: 'private' | 'workspace_audience';
  requiresCommenter?: boolean;
  requiresContributor?: boolean;
  requiresFile?: boolean;
};

const CONVERSIONS: CollaborationConversion[] = [
  { label: 'Private note', type: 'sticky_note', visibility: 'private' },
  {
    label: 'Team note',
    type: 'sticky_note',
    visibility: 'workspace_audience',
    requiresCommenter: true,
  },
  {
    label: 'Task',
    type: 'task',
    visibility: 'workspace_audience',
    requiresCommenter: true,
  },
  {
    label: 'Annotation',
    type: 'annotation',
    visibility: 'workspace_audience',
    requiresCommenter: true,
    requiresFile: true,
  },
  {
    label: 'Proposal',
    type: 'change_proposal',
    visibility: 'workspace_audience',
    requiresContributor: true,
  },
];

const COMMENT_ROLES = new Set(['commenter', 'contributor', 'editor', 'owner']);
const CONTRIBUTOR_ROLES = new Set(['contributor', 'editor', 'owner']);

const formatTimestamp = (value: string) => new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}).format(new Date(value));

const titleFromMessage = (message: WorkspaceTeamMessage, label: string) => {
  const compact = message.body.replace(/\s+/g, ' ').replace(/@lumo\b[:,]?/ig, '').trim();
  return `${label}: ${compact.slice(0, 72)}${compact.length > 72 ? '…' : ''}`;
};

const mergeMessages = (
  current: WorkspaceTeamMessage[],
  incoming: WorkspaceTeamMessage[],
): WorkspaceTeamMessage[] => {
  const byId = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => byId.set(message.id, message));
  return Array.from(byId.values()).sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
};

const renderMessageBody = (body: string) => body.split(/(@lumo\b)/ig).map((part, index) =>
  /^@lumo$/i.test(part) ? (
    <span key={`${part}-${index}`} className="font-semibold text-violet-600 dark:text-violet-300">
      {part}
    </span>
  ) : part);

export default function WorkspaceTeamChatPanel({
  workspace,
  filePath,
  colorMode,
}: {
  workspace: Workspace;
  filePath?: string;
  colorMode: 'light' | 'dark';
}) {
  const isDarkMode = colorMode === 'dark';
  const [messages, setMessages] = useState<WorkspaceTeamMessage[]>([]);
  const [collaborators, setCollaborators] = useState<WorkspaceCollaborator[]>([]);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<WorkspaceTeamMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lumoBusyMessageId, setLumoBusyMessageId] = useState<string | null>(null);
  const [lumoRetryMessageId, setLumoRetryMessageId] = useState<string | null>(null);
  const [actionMessageId, setActionMessageId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const role = workspace.role || 'viewer';
  const canComment = COMMENT_ROLES.has(role);
  const canPropose = CONTRIBUTOR_ROLES.has(role);

  const loadMessages = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const next = await listWorkspaceTeamMessages(workspace.id);
      setMessages(next);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load Team Chat');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [workspace.id]);

  useEffect(() => {
    setMessages([]);
    setDraft('');
    setReplyTo(null);
    setNotice('');
    setError('');
    void loadMessages(true);
    void listWorkspaceCollaborators(workspace.id)
      .then((access) => setCollaborators(access.collaborators ?? []))
      .catch(() => setCollaborators([]));
    const timer = window.setInterval(() => void loadMessages(false), 5000);
    return () => window.clearInterval(timer);
  }, [loadMessages, workspace.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, lumoBusyMessageId]);

  const messageThreads = useMemo(() => {
    const repliesByRoot = new Map<string, WorkspaceTeamMessage[]>();
    const roots: WorkspaceTeamMessage[] = [];
    messages.forEach((message) => {
      if (!message.threadRootId) {
        roots.push(message);
        return;
      }
      const replies = repliesByRoot.get(message.threadRootId) || [];
      replies.push(message);
      repliesByRoot.set(message.threadRootId, replies);
    });
    return { roots, repliesByRoot };
  }, [messages]);

  const mentionQuery = useMemo(() => {
    const match = draft.match(/(?:^|\s)@([^@\n]*)$/);
    return match ? match[1].trim().toLowerCase() : null;
  }, [draft]);

  const mentionSuggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const options = [
      { id: 'lumo', displayName: 'Lumo', role: 'AI · read-only' },
      ...collaborators.map((collaborator) => ({
        id: collaborator.userId,
        displayName: collaborator.displayName,
        role: collaborator.role,
      })),
    ];
    return options
      .filter((option) => option.displayName.toLowerCase().includes(mentionQuery))
      .slice(0, 8);
  }, [collaborators, mentionQuery]);

  const selectMention = (displayName: string) => {
    setDraft((value) => value.replace(/@[^@\n]*$/, `@${displayName} `));
  };

  const invokeLumo = async (sourceMessageId: string) => {
    setLumoBusyMessageId(sourceMessageId);
    setLumoRetryMessageId(null);
    try {
      const lumoReply = await invokeLumoForWorkspaceTeamMessage(workspace.id, sourceMessageId);
      setMessages((current) => mergeMessages(current, [lumoReply]));
      setError('');
    } catch (invokeError) {
      setLumoRetryMessageId(sourceMessageId);
      setError(invokeError instanceof Error ? invokeError.message : 'Lumo could not respond');
    } finally {
      setLumoBusyMessageId(null);
    }
  };

  const handleSend = async () => {
    const body = draft.trim();
    if (!body || sending || !canComment) return;
    setSending(true);
    setError('');
    const mentionedUserIds = collaborators
      .filter((collaborator) =>
        body.toLowerCase().includes(`@${collaborator.displayName}`.toLowerCase()))
      .map((collaborator) => collaborator.userId);
    try {
      const message = await postWorkspaceTeamMessage(workspace.id, {
        body,
        replyToMessageId: replyTo?.id,
        mentionedUserIds,
      });
      setMessages((current) => mergeMessages(current, [message]));
      setDraft('');
      setReplyTo(null);
      if (message.mentionsLumo) {
        await invokeLumo(message.id);
      }
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const handleConvert = async (
    message: WorkspaceTeamMessage,
    conversion: CollaborationConversion,
  ) => {
    setError('');
    setNotice('');
    try {
      await createWorkspaceCollaborationObject(workspace.id, {
        type: conversion.type,
        visibility: conversion.visibility,
        title: titleFromMessage(message, conversion.label),
        body: message.body,
        filePath: conversion.requiresFile ? filePath : undefined,
        sourceTeamMessageId: message.id,
      });
      setNotice(`${conversion.label} created from the conversation.`);
      setActionMessageId(null);
    } catch (conversionError) {
      setError(conversionError instanceof Error
        ? conversionError.message
        : `Failed to create ${conversion.label.toLowerCase()}`);
    }
  };

  const availableConversions = CONVERSIONS.filter((conversion) => {
    if (conversion.requiresContributor && !canPropose) return false;
    if (conversion.requiresCommenter && !canComment) return false;
    if (conversion.requiresFile && !filePath) return false;
    return true;
  });

  const renderMessage = (message: WorkspaceTeamMessage, isReply = false) => {
    const isLumo = message.authorType === 'lumo';
    const isActionsOpen = actionMessageId === message.id;
    const publishedVersion = message.originVersionNumber
      ? `Published v${message.originVersionNumber}`
      : 'Shared workspace';
    return (
      <article
        key={message.id}
        className={`group rounded-2xl border px-3 py-2.5 ${
          isReply ? 'ml-7' : ''
        } ${
          message.isMentioned
            ? isDarkMode
              ? 'border-violet-400/50 bg-violet-400/10'
              : 'border-violet-200 bg-violet-50'
            : isDarkMode
              ? 'border-slate-800 bg-slate-900/55'
              : 'border-slate-200 bg-white'
        }`}
      >
        <div className="flex items-start gap-2.5">
          <div className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${
            isLumo
              ? 'bg-violet-500/15 text-violet-500'
              : isDarkMode
                ? 'bg-slate-800 text-slate-200'
                : 'bg-slate-100 text-slate-700'
          }`}>
            {isLumo
              ? <Bot size={16} />
              : <span className="text-xs font-semibold">{message.authorName.slice(0, 1).toUpperCase()}</span>}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`text-sm font-semibold ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>
                {message.authorName}
              </span>
              {isLumo ? (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  isDarkMode ? 'bg-violet-400/15 text-violet-200' : 'bg-violet-50 text-violet-700'
                }`}>
                  Read-only · {publishedVersion}
                </span>
              ) : null}
              <span className={`text-[11px] ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                {formatTimestamp(message.createdAt)}
              </span>
            </div>
            <p className={`mt-1 whitespace-pre-wrap text-sm leading-6 ${
              isDarkMode ? 'text-slate-200' : 'text-slate-700'
            }`}>
              {renderMessageBody(message.body)}
            </p>
            {isLumo ? (
              <div className="mt-2">
                <ChatToolCalls
                  calls={[{
                    key: `${message.id}-published-context`,
                    name: 'published_workspace_context',
                    status: 'complete',
                    target: publishedVersion,
                    node: 'read-only',
                  }]}
                />
              </div>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {canComment ? (
                <Button
                  label="Reply"
                  size="sm"
                  variant="ghost"
                  icon={<Reply size={14} />}
                  onClick={() => setReplyTo(message)}
                />
              ) : null}
              <Button
                label="Use message"
                size="sm"
                variant="ghost"
                icon={<MoreHorizontal size={14} />}
                onClick={() => setActionMessageId(isActionsOpen ? null : message.id)}
              />
              {message.isMine ? (
                <span className={`ml-auto text-[10px] ${isDarkMode ? 'text-slate-600' : 'text-slate-400'}`}>
                  Sent
                </span>
              ) : null}
            </div>
            {isActionsOpen ? (
              <div className="mt-2 overflow-x-auto pb-1">
                <ButtonGroup label="Create collaboration item from message" size="sm">
                  {availableConversions.map((conversion) => (
                    <Button
                      key={`${conversion.type}-${conversion.visibility}`}
                      label={conversion.label}
                      variant={conversion.type === 'change_proposal' ? 'primary' : 'secondary'}
                      icon={conversion.type === 'task'
                        ? <MessageCircle size={14} />
                        : conversion.type === 'annotation'
                          ? <FileText size={14} />
                          : <StickyNote size={14} />}
                      onClick={() => void handleConvert(message, conversion)}
                    />
                  ))}
                </ButtonGroup>
              </div>
            ) : null}
          </div>
        </div>
      </article>
    );
  };

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${isDarkMode ? 'bg-[#0d1524]' : 'bg-slate-50'}`}>
      <div className={`border-b px-4 py-2.5 ${
        isDarkMode ? 'border-slate-800 bg-slate-950/30' : 'border-slate-200 bg-white'
      }`}>
        <div>
          <div className="min-w-0">
            <div className={`flex items-center gap-2 text-sm font-semibold ${
              isDarkMode ? 'text-slate-100' : 'text-slate-900'
            }`}>
              <Users size={15} />
              <span># team-chat</span>
            </div>
            <p className={`mt-0.5 text-[11px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              Visible to workspace members. Message normally, or tag <strong>@Lumo</strong> for a read-only answer.
            </p>
          </div>
        </div>
      </div>

      {(error || notice) ? (
        <div className={`mx-3 mt-3 rounded-xl border px-3 py-2 text-xs ${
          error
            ? isDarkMode
              ? 'border-rose-400/30 bg-rose-400/10 text-rose-200'
              : 'border-rose-200 bg-rose-50 text-rose-700'
            : isDarkMode
              ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
        }`}>
          <div className="flex items-center justify-between gap-2">
            <span>{error || notice}</span>
            {lumoRetryMessageId ? (
              <Button
                label="Retry Lumo"
                size="sm"
                variant="secondary"
                onClick={() => void invokeLumo(lumoRetryMessageId)}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className={`grid h-full place-items-center text-sm ${
            isDarkMode ? 'text-slate-500' : 'text-slate-400'
          }`}>Loading Team Chat…</div>
        ) : !messageThreads.roots.length ? (
          <div className="grid h-full place-items-center px-8 text-center">
            <div>
              <div className={`mx-auto grid h-12 w-12 place-items-center rounded-2xl ${
                isDarkMode ? 'bg-slate-800 text-slate-300' : 'bg-white text-slate-500 shadow-sm'
              }`}>
                <MessageCircle size={22} />
              </div>
              <p className={`mt-3 text-sm font-semibold ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>
                Start the workspace conversation
              </p>
              <p className={`mt-1 text-xs leading-5 ${isDarkMode ? 'text-slate-500' : 'text-slate-500'}`}>
                Share context, tag teammates, or ask @Lumo about the published version.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messageThreads.roots.map((root) => (
              <section key={root.id} className="space-y-2">
                {renderMessage(root)}
                {(messageThreads.repliesByRoot.get(root.id) || []).map((reply) =>
                  renderMessage(reply, true))}
              </section>
            ))}
            {lumoBusyMessageId ? (
              <div className={`ml-7 rounded-2xl border px-3 py-3 ${
                isDarkMode ? 'border-violet-400/20 bg-violet-400/5' : 'border-violet-100 bg-white'
              }`}>
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-violet-500">
                  <Bot size={16} />
                  Lumo is checking the shared workspace
                </div>
                <ChatToolCalls
                  calls={[{
                    key: `${lumoBusyMessageId}-reading`,
                    name: 'published_workspace_context',
                    status: 'running',
                    target: workspace.currentPublishedVersionNumber
                      ? `Published v${workspace.currentPublishedVersionNumber}`
                      : 'Shared workspace',
                    node: 'read-only',
                  }]}
                />
              </div>
            ) : null}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className={`border-t p-3 ${isDarkMode ? 'border-slate-800 bg-[#0d1524]' : 'border-slate-200 bg-white'}`}>
        {replyTo ? (
          <div className={`mb-2 flex items-center justify-between rounded-xl px-3 py-2 text-xs ${
            isDarkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'
          }`}>
            <span className="truncate">Replying to {replyTo.authorName}: {replyTo.body}</span>
            <Button label="Cancel reply" size="sm" variant="ghost" onClick={() => setReplyTo(null)} />
          </div>
        ) : null}
        <div className="relative">
          <TextArea
            label="Team Chat message"
            isLabelHidden
            value={draft}
            rows={3}
            width="100%"
            placeholder={canComment
              ? 'Message the team… Use @Lumo for read-only help'
              : 'Viewer access is read-only'}
            isDisabled={!canComment || sending}
            disabledMessage="Commenter access is required to post in Team Chat."
            startIcon={<AtSign size={16} />}
            onChange={(value) => setDraft(value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
          />
          {mentionSuggestions.length ? (
            <div className={`absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-xl border shadow-xl ${
              isDarkMode ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
            }`}>
              {mentionSuggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${
                    isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-slate-50'
                  }`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectMention(suggestion.displayName)}
                >
                  <span className={isDarkMode ? 'text-slate-100' : 'text-slate-800'}>
                    @{suggestion.displayName}
                  </span>
                  <span className={isDarkMode ? 'text-slate-500' : 'text-slate-400'}>
                    {suggestion.role}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className={`text-[11px] ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
            {canComment ? 'Enter to send · Shift+Enter for a new line' : 'You can read Team Chat with Viewer access.'}
          </span>
          <Button
            label={replyTo ? 'Send reply' : 'Send'}
            variant="primary"
            size="sm"
            icon={<Send size={14} />}
            isDisabled={!canComment || !draft.trim() || sending}
            isLoading={sending}
            onClick={() => void handleSend()}
          />
        </div>
      </div>
    </div>
  );
}

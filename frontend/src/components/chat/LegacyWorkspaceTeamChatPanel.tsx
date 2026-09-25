import { useLocation } from 'react-router-dom';
import { Button } from '@astryxdesign/core/Button';
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import TeamChatComposer from './TeamChatComposer';
import { getFiles, getFileDownloadUrl } from '../../services/fileApi';
import { fetchSlashMetadata } from '../../services/agentApi';
import { getPublishedVersionSnapshot } from '../../services/workspaceApi';
import { respondToTeamInteraction } from '../../services/workspaceCollaborationApi';
import {
  Bot,
  FileText,
  MessageCircle,
  MoreHorizontal,
  Reply,
  StickyNote,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Components } from 'react-markdown';

import type { Workspace, TeamChatReference } from '../../types';
import {
  createWorkspaceCollaborationObject,
  convertWorkspaceCollaborationObjectToProposal,
  listWorkspaceTeamMessages,
  postWorkspaceTeamMessage,
  type WorkspaceCollaborationObjectType,
  type WorkspaceTeamMessage,
} from '../../services/workspaceCollaborationApi';
import {
  listWorkspaceCollaborators,
  type WorkspaceCollaborator,
} from '../../services/workspaceApi';
import LumoMarkdown from '../markdown/LumoMarkdown';

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

export default function LegacyWorkspaceTeamChatPanel({
  workspace,
  filePath,
  colorMode,
  markdownComponents,
  onOpenPrivateWorkingCopy,
  viewedVersion,
  onFilesChanged,
}: {
  viewedVersion?: { versionId: string; versionNumber: number };
  onFilesChanged?: () => void;
  workspace: Workspace;
  filePath?: string;
  colorMode: 'light' | 'dark';
  markdownComponents: Components;
  onOpenPrivateWorkingCopy?: () => Promise<void>;
}) {
  const location = useLocation();
  const notificationQuery = new URLSearchParams(location.search);
  const targetMessageId = notificationQuery.get('workspaceId') === workspace.id ? notificationQuery.get('messageId') : null;
  const scrolledNotification = useRef<string | null>(null);
  const isDarkMode = colorMode === 'dark';
  const [messages, setMessages] = useState<WorkspaceTeamMessage[]>([]);
  const [collaborators, setCollaborators] = useState<WorkspaceCollaborator[]>([]);
  const [referenceOptions, setReferenceOptions] = useState<Array<TeamChatReference & { description?: string }>>([]);
  const [interactionText, setInteractionText] = useState<Record<string, string>>({});
  const workspaceRef = useRef(workspace.id);
  workspaceRef.current = workspace.id;
  const knownArtifacts = useRef(new Set<string>());
  const filesChangedRef = useRef(onFilesChanged);
  filesChangedRef.current = onFilesChanged;
  const [replyTo, setReplyTo] = useState<WorkspaceTeamMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [actionMessageId, setActionMessageId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const role = workspace.role || 'viewer';
  const canComment = COMMENT_ROLES.has(role);
  const canPropose = CONTRIBUTOR_ROLES.has(role);
  const canLumoWrite = workspace.canEdit === true;
  const workingContextLabel = 'Shared Working version';
  const viewedVersionId = viewedVersion?.versionId;

  const loadMessages = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const next = await listWorkspaceTeamMessages(workspace.id, 200, targetMessageId || undefined);
      if (workspaceRef.current !== workspace.id) return;
      setMessages((current) => mergeMessages(current, next));
      for (const message of next) {
        const artifacts = message.metadata?.artifacts as unknown[] | undefined;
        if (artifacts?.length && !knownArtifacts.current.has(message.id)) {
          knownArtifacts.current.add(message.id); filesChangedRef.current?.();
        }
      }
      setError('');
    } catch (loadError) {
      if (workspaceRef.current === workspace.id) setError(loadError instanceof Error ? loadError.message : 'Failed to load Workspace Chat');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [workspace.id, targetMessageId]);

  useEffect(() => {
    setMessages([]);
    setCollaborators([]);
    setSending(false);
    setInteractionText({});
    setReplyTo(null);
    setNotice('');
    setError('');
    void loadMessages(true);
    void listWorkspaceCollaborators(workspace.id)
      .then((access) => { if (workspaceRef.current === workspace.id) setCollaborators(access.collaborators ?? []); })
      .catch(() => { if (workspaceRef.current === workspace.id) setCollaborators([]); });
    knownArtifacts.current.clear();
    const timer = window.setInterval(() => void loadMessages(false), 5000);
    return () => window.clearInterval(timer);
  }, [loadMessages, workspace.id]);

  useEffect(() => {
    if (targetMessageId && scrolledNotification.current !== location.search) {
      const target = document.getElementById(`team-message-${targetMessageId}`);
      if (target) { target.scrollIntoView({ block: 'center' }); scrolledNotification.current = location.search; }
      return;
    }
    if (!targetMessageId) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, targetMessageId, location.search]);

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

  useEffect(() => {
    let cancelled = false;
    setReferenceOptions([]);
    void Promise.allSettled([
      viewedVersionId ? getPublishedVersionSnapshot(workspace.id, viewedVersionId).then((value) => value.files) : getFiles(workspace.id),
      fetchSlashMetadata(workspace.id),
    ]).then(([fileResult, metadataResult]) => {
      const files = fileResult.status === 'fulfilled' ? fileResult.value : [];
      const metadata = metadataResult.status === 'fulfilled' ? metadataResult.value : { skills: [] };
      if (cancelled) return;
      setReferenceOptions([
        { kind: 'agent', id: 'lumo', label: 'Lumo', description: canLumoWrite ? 'Agent · can edit Working' : 'Agent · read-only' },
        ...collaborators.map((person): TeamChatReference & { description: string } => ({ kind: 'person', id: person.userId, label: person.displayName, description: person.role })),
        ...(Array.isArray(files) ? files : []).map((file): TeamChatReference => ({ kind: 'file', id: String(file.id), label: file.name, version: Number(file.version) || undefined, publishedVersionId: viewedVersionId })),
        ...metadata.skills.filter((skill) => skill.valid).map((skill): TeamChatReference & { description?: string } => ({ kind: 'skill', id: skill.id, label: skill.name, description: skill.description })),
      ]);
    }).catch((error) => { if (!cancelled) setError(error instanceof Error ? error.message : 'Unable to load references'); });
    return () => { cancelled = true; };
  }, [workspace.id, collaborators, canLumoWrite, viewedVersionId]);

  const handleSend = async (body: string, references: TeamChatReference[]) => {
    if (!body.trim() || sending || !canComment) return;
    const target = workspace.id;
    setSending(true); setError('');
    try {
      const message = await postWorkspaceTeamMessage(target, {
        body, references, replyToMessageId: replyTo?.id,
        mentionedUserIds: references.filter((ref) => ref.kind === 'person').map((ref) => ref.id),
      });
      if (workspaceRef.current !== target) return;
      setMessages((current) => mergeMessages(current, [message])); setReplyTo(null);
    } catch (sendError) {
      if (workspaceRef.current === target) setError(sendError instanceof Error ? sendError.message : 'Failed to send message');
      throw sendError;
    } finally { if (workspaceRef.current === target) setSending(false); }
  };

  const respond = async (messageId: string, input: { decision?: 'approve' | 'reject'; actionId?: string; message?: string }) => {
    try { await respondToTeamInteraction(workspace.id, messageId, input); await loadMessages(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to respond'); }
  };

  const handleConvert = async (
    message: WorkspaceTeamMessage,
    conversion: CollaborationConversion,
  ) => {
    setError('');
    setNotice('');
    try {
      const created = await createWorkspaceCollaborationObject(workspace.id, {
        type: conversion.type === 'change_proposal' ? 'sticky_note' : conversion.type,
        visibility: conversion.visibility,
        title: titleFromMessage(message, conversion.label),
        body: message.body,
        filePath: conversion.requiresFile ? filePath : undefined,
        sourceTeamMessageId: message.id,
      });
      if (conversion.type === 'change_proposal') {
        await convertWorkspaceCollaborationObjectToProposal(workspace.id, created.id);
      }
      setNotice(`${conversion.label} created from the conversation.`);
      setActionMessageId(null);
      if (conversion.type === 'change_proposal' && onOpenPrivateWorkingCopy) {
        await onOpenPrivateWorkingCopy();
      }
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
    const lumoCapability = message.metadata?.readOnly === false ? 'Can edit Working' : message.metadata?.readOnly === true ? 'Read-only' : 'Capability not recorded';
    const artifacts = (message.metadata?.artifacts || []) as Array<{ fileId: number; name: string; version: number }>;
    const events = (message.metadata?.toolEvents || []) as Array<{ type: string; name?: string; tool?: string }>;
    return (
      <article
        key={message.id}
        id={`team-message-${message.id}`}
        style={targetMessageId === message.id ? { outline: '2px solid #8b5cf6', outlineOffset: 2 } : undefined}
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
                  {lumoCapability} · {workingContextLabel}
                </span>
              ) : null}
              <span className={`text-[11px] ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                {formatTimestamp(message.createdAt)}
              </span>
            </div>
            <LumoMarkdown components={{ ...markdownComponents, a: ({ href, children }) => {
              const artifact = artifacts.find((file) => href === '/' + file.name || href === '/workspace/' + file.name || href === file.name);
              if (artifact) return <a className="underline text-blue-400" href={getFileDownloadUrl(workspace.id, artifact.fileId, artifact.version)}>{children}</a>;
              if (!href || !/^https?:\/\//i.test(href)) return <span title="No committed workspace file matches this reference">{children} <small>(file unavailable)</small></span>;
              return <a href={href} target="_blank" rel="noreferrer" className="underline text-blue-400">{children}</a>;
            } }} className={`mt-1 text-sm leading-6 ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
              {message.body}
            </LumoMarkdown>
            {!!artifacts.length && <div className="mt-2 flex flex-col gap-1">{artifacts.map((file) => <a key={`${file.fileId}:${file.version}`} href={getFileDownloadUrl(workspace.id, file.fileId, file.version)} className="rounded-lg border border-blue-400/30 p-2 text-xs text-blue-400"><FileText size={14} className="inline" /> {file.name} · v{file.version}</a>)}</div>}
            {!!events.length && <details className="mt-2 text-xs opacity-75"><summary>Recorded tool activity ({events.length})</summary>{events.map((event, index) => <div key={index}>{event.name || event.tool || 'Tool'} · {event.type.replace('tool_', '')}</div>)}</details>}
            {!isLumo && message.metadata?.runStatus ? <div className="mt-2 rounded-lg border border-blue-400/20 p-2 text-xs" role="status">
              Lumo: {String(message.metadata.runStatus).replace('_', ' ')}
              {message.metadata.error ? <p className="mt-1 text-rose-400">{String(message.metadata.error)}</p> : null}
              {message.metadata.runStatus === 'awaiting_approval' && message.isMine ? (() => {
                const pending = message.metadata.pendingInterrupt as { title?: string; description?: string; actionRequests?: Array<{name?: string; args?: unknown}>; actions?: Array<{ id: string; label: string }>; responseSpec?: { choices?: Array<{ label?: string; value?: string }> } } | undefined;
                return <div className="mt-2 space-y-2"><strong>{pending?.title || 'Lumo needs your input'}</strong><p>{pending?.description}</p>
                  {!!pending?.actionRequests?.length && <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(pending.actionRequests, null, 2)}</pre>}
                  {!!pending?.responseSpec?.choices?.length && <p>{pending.responseSpec.choices.map((item) => item.label).join(' · ')}</p>}
                  <textarea aria-label="Response to Lumo" value={interactionText[message.id] || ''} onChange={(e) => setInteractionText((current) => ({ ...current, [message.id]: e.target.value }))} className="w-full rounded border border-slate-500 bg-transparent p-2" />
                  {pending?.actionRequests?.length ? <><button className="mr-3 underline" onClick={() => void respond(message.id, { decision: 'approve' })}>Approve shown actions</button><button className="underline" onClick={() => void respond(message.id, { decision: 'reject' })}>Reject</button></> : pending?.actions?.length ? pending.actions.map((action) => <button className="mr-3 underline" key={action.id} onClick={() => void respond(message.id, { actionId: action.id, message: interactionText[message.id] })}>{action.label}</button>) : <button className="underline" onClick={() => void respond(message.id, { message: interactionText[message.id] })}>Send response</button>}
                </div>;
              })() : null}
            </div> : null}
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
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={`flex items-center gap-2 text-sm font-semibold ${
              isDarkMode ? 'text-slate-100' : 'text-slate-900'
            }`}>
              <Users size={15} />
              <span># team-chat</span>
            </div>
            <p className={`mt-0.5 text-[11px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              Visible to workspace members. Message normally, or tag <strong>@Lumo</strong> for {canLumoWrite
                ? 'help that can update shared files directly.'
                : canPropose
                  ? 'read-only guidance. Work privately to make edits.'
                  : 'read-only guidance.'}
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

          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className={`grid h-full place-items-center text-sm ${
            isDarkMode ? 'text-slate-500' : 'text-slate-400'
          }`}>Loading Workspace Chat…</div>
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
                Share context, tag teammates, or ask @Lumo about the Shared Working version.
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
        {viewedVersion && <p className="mb-2 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-500">Viewing Locked v{viewedVersion.versionNumber}. File references use this snapshot; Lumo writes to Working.</p>}
        <TeamChatComposer key={workspace.id} options={referenceOptions} disabled={!canComment} sending={sending} reply={Boolean(replyTo)} onSend={handleSend} />

      </div>
    </div>
  );
}

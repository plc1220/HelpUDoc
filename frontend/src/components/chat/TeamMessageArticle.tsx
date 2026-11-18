import { Button } from '@astryxdesign/core/Button';
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import { Bot, FileText, MessageCircle, MoreHorizontal, Reply, StickyNote } from 'lucide-react';
import type { Components } from 'react-markdown';
import LumoMarkdown from '../markdown/LumoMarkdown';
import { getFileDownloadUrl } from '../../services/fileApi';
import type { WorkspaceTeamMessage } from '../../services/workspaceCollaborationApi';
import type { CollaborationConversion } from './teamConversions';

const formatTimestamp = (value: string) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));

/**
 * Single source of truth for rendering one Team Chat message (spec F1 reuse).
 * Both the legacy flat panel and the new thread detail render through this
 * component so their behavior — Lumo capability badge, artifacts, recorded tool
 * activity, awaiting-approval interaction UI, and the "Use message" conversion
 * actions — can never fork. Thread-only affordances (quote link, read-state
 * data attributes) are passed in by the caller.
 */
export default function TeamMessageArticle({
  message,
  workspaceId,
  isDarkMode,
  markdownComponents,
  canComment,
  conversions,
  isActionsOpen,
  interactionText,
  highlighted,
  domId,
  extraArticleProps,
  quote,
  onReply,
  onToggleActions,
  onConvert,
  onInteractionTextChange,
  onRespond,
}: {
  message: WorkspaceTeamMessage;
  workspaceId: string;
  isDarkMode: boolean;
  markdownComponents: Components;
  canComment: boolean;
  conversions: CollaborationConversion[];
  isActionsOpen: boolean;
  interactionText: string;
  highlighted?: boolean;
  /** DOM id for scroll targeting (deep links / quote jumps). */
  domId?: string;
  /** Extra props (e.g. data-seq for read-state observation) on the article. */
  extraArticleProps?: Record<string, unknown>;
  /** Optional quoted-target affordance rendered above the body. */
  quote?: React.ReactNode;
  onReply?: (message: WorkspaceTeamMessage) => void;
  onToggleActions: (message: WorkspaceTeamMessage) => void;
  onConvert: (message: WorkspaceTeamMessage, conversion: CollaborationConversion) => void;
  onInteractionTextChange: (messageId: string, value: string) => void;
  onRespond: (messageId: string, input: { decision?: 'approve' | 'reject'; actionId?: string; message?: string }) => void;
}) {
  const isLumo = message.authorType === 'lumo';
  const lumoCapability =
    message.metadata?.readOnly === false ? 'Can edit Working' : message.metadata?.readOnly === true ? 'Read-only' : 'Capability not recorded';
  const artifacts = (message.metadata?.artifacts || []) as Array<{ fileId: number; name: string; version: number }>;
  const events = (message.metadata?.toolEvents || []) as Array<{ type: string; name?: string; tool?: string }>;
  return (
    <article
      id={domId}
      style={highlighted ? { outline: '2px solid #8b5cf6', outlineOffset: 2 } : undefined}
      className={`group rounded-2xl border px-3 py-2.5 ${
        message.isMentioned
          ? isDarkMode
            ? 'border-violet-400/50 bg-violet-400/10'
            : 'border-violet-200 bg-violet-50'
          : isDarkMode
            ? 'border-slate-800 bg-slate-900/55'
            : 'border-slate-200 bg-white'
      }`}
      {...extraArticleProps}
    >
      <div className="flex items-start gap-2.5">
        <div
          className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${
            isLumo ? 'bg-violet-500/15 text-violet-500' : isDarkMode ? 'bg-slate-800 text-slate-200' : 'bg-slate-100 text-slate-700'
          }`}
        >
          {isLumo ? <Bot size={16} /> : <span className="text-xs font-semibold">{message.authorName.slice(0, 1).toUpperCase()}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`text-sm font-semibold ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>{message.authorName}</span>
            {isLumo ? (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isDarkMode ? 'bg-violet-400/15 text-violet-200' : 'bg-violet-50 text-violet-700'}`}>
                {lumoCapability} · Shared Working version
              </span>
            ) : null}
            <span className={`text-[11px] ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{formatTimestamp(message.createdAt)}</span>
          </div>
          {quote}
          <LumoMarkdown
            components={{
              ...markdownComponents,
              a: ({ href, children }) => {
                const artifact = artifacts.find((file) => href === '/' + file.name || href === '/workspace/' + file.name || href === file.name);
                if (artifact) return <a className="underline text-blue-400" href={getFileDownloadUrl(workspaceId, artifact.fileId, artifact.version)}>{children}</a>;
                if (!href || !/^https?:\/\//i.test(href)) return <span title="No committed workspace file matches this reference">{children} <small>(file unavailable)</small></span>;
                return <a href={href} target="_blank" rel="noreferrer" className="underline text-blue-400">{children}</a>;
              },
            }}
            className={`mt-1 text-sm leading-6 ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}
          >
            {message.body}
          </LumoMarkdown>
          {!!artifacts.length && (
            <div className="mt-2 flex flex-col gap-1">
              {artifacts.map((file) => (
                <a key={`${file.fileId}:${file.version}`} href={getFileDownloadUrl(workspaceId, file.fileId, file.version)} className="rounded-lg border border-blue-400/30 p-2 text-xs text-blue-400">
                  <FileText size={14} className="inline" /> {file.name} · v{file.version}
                </a>
              ))}
            </div>
          )}
          {!!events.length && (
            <details className="mt-2 text-xs opacity-75">
              <summary>Recorded tool activity ({events.length})</summary>
              {events.map((event, index) => (
                <div key={index}>{event.name || event.tool || 'Tool'} · {event.type.replace('tool_', '')}</div>
              ))}
            </details>
          )}
          {!isLumo && message.metadata?.runStatus ? (
            <div className="mt-2 rounded-lg border border-blue-400/20 p-2 text-xs" role="status">
              Lumo: {String(message.metadata.runStatus).replace('_', ' ')}
              {message.metadata.error ? <p className="mt-1 text-rose-400">{String(message.metadata.error)}</p> : null}
              {message.metadata.runStatus === 'awaiting_approval' && message.isMine
                ? (() => {
                    const pending = message.metadata.pendingInterrupt as
                      | { title?: string; description?: string; actionRequests?: Array<{ name?: string; args?: unknown }>; actions?: Array<{ id: string; label: string }>; responseSpec?: { choices?: Array<{ label?: string; value?: string }> } }
                      | undefined;
                    return (
                      <div className="mt-2 space-y-2">
                        <strong>{pending?.title || 'Lumo needs your input'}</strong>
                        <p>{pending?.description}</p>
                        {!!pending?.actionRequests?.length && <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(pending.actionRequests, null, 2)}</pre>}
                        {!!pending?.responseSpec?.choices?.length && <p>{pending.responseSpec.choices.map((item) => item.label).join(' · ')}</p>}
                        <textarea
                          aria-label="Response to Lumo"
                          value={interactionText}
                          onChange={(e) => onInteractionTextChange(message.id, e.target.value)}
                          className="w-full rounded border border-slate-500 bg-transparent p-2"
                        />
                        {pending?.actionRequests?.length ? (
                          <>
                            <button className="mr-3 underline" onClick={() => onRespond(message.id, { decision: 'approve' })}>Approve shown actions</button>
                            <button className="underline" onClick={() => onRespond(message.id, { decision: 'reject' })}>Reject</button>
                          </>
                        ) : pending?.actions?.length ? (
                          pending.actions.map((action) => (
                            <button className="mr-3 underline" key={action.id} onClick={() => onRespond(message.id, { actionId: action.id, message: interactionText })}>{action.label}</button>
                          ))
                        ) : (
                          <button className="underline" onClick={() => onRespond(message.id, { message: interactionText })}>Send response</button>
                        )}
                      </div>
                    );
                  })()
                : null}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {canComment && onReply ? (
              <Button label="Reply" size="sm" variant="ghost" icon={<Reply size={14} />} onClick={() => onReply(message)} />
            ) : null}
            <Button label="Use message" size="sm" variant="ghost" icon={<MoreHorizontal size={14} />} onClick={() => onToggleActions(message)} />
            {message.isMine ? <span className={`ml-auto text-[10px] ${isDarkMode ? 'text-slate-600' : 'text-slate-400'}`}>Sent</span> : null}
          </div>
          {isActionsOpen ? (
            <div className="mt-2 overflow-x-auto pb-1">
              <ButtonGroup label="Create collaboration item from message" size="sm">
                {conversions.map((conversion) => (
                  <Button
                    key={`${conversion.type}-${conversion.visibility}`}
                    label={conversion.label}
                    variant={conversion.type === 'change_proposal' ? 'primary' : 'secondary'}
                    icon={conversion.type === 'task' ? <MessageCircle size={14} /> : conversion.type === 'annotation' ? <FileText size={14} /> : <StickyNote size={14} />}
                    onClick={() => onConvert(message, conversion)}
                  />
                ))}
              </ButtonGroup>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

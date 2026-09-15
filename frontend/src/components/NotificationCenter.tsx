import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { createContext, useCallback, useContext, useEffect, useRef, useState, useId, type ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Popover } from '@astryxdesign/core/Popover';
import { Toast } from '@astryxdesign/core/Toast';
import { Bell, CheckCheck, Check, CircleHelp, AtSign, FileCheck2, Volume2, VolumeX, X } from 'lucide-react';
import './NotificationCenter.css';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { apiFetch, buildApiUrl } from '../services/apiClient';
import { useBrowserNotifications } from '../hooks/useBrowserNotifications';
import { useNotificationSound } from '../hooks/useNotificationSound';

type Notification = {
  id: string;
  eventType: string;
  createdAt: string;
  readAt: string | null;
  payload: { title?: string; description?: string; workspaceId?: string; conversationId?: string; messageId?: string; annotationId?: string; filePath?: string };
};

const eventLabels: Record<string, string> = {
  'agent.completed': 'Your task is ready',
  'agent.feedback_required': 'Your feedback is needed',
  'chat.message': 'New team message',
  'chat.mentioned': 'You were mentioned',
  'skill_review.approve': 'Skill review approved',
  'skill_review.submitted': 'Skill submitted for review',
  'skill_review.request_changes': 'Changes requested',
};
const notificationTitle = (item: Notification) => item.payload.title || eventLabels[item.eventType] || item.eventType.replaceAll(/[._]/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
const notificationTime = (date: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const NotificationContext = createContext<{
  unread: number; activeId: string | null; content: ReactNode;
  open: (id: string) => void; close: () => void;
} | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const navigate = useNavigate();
  const sound = useNotificationSound(userId);
  const browser = useBrowserNotifications(userId);
  const showBrowserAlert = browser.show;
  const reconcileBrowserAlerts = browser.reconcile;
  const openRef = useRef<(item: Notification) => void>(() => {});
  const playNotificationSound = sound.play;
  const [anchor, setAnchor] = useState<string | null>(null);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [view, setView] = useState('unread');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notification | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let active = true;
    let inFlight = false;
    seen.current = null;
    setAnchor(null); setItems([]); setUnread(0); setLoading(true); setNotice(null); setError('');
    const refresh = async () => {
      if (!userId || inFlight) return;
      inFlight = true;
      try {
        const response = await apiFetch(buildApiUrl('/notifications'));
        if (!response.ok) throw new Error('Could not load notifications.');
        const data = await response.json() as { notifications: Notification[]; unreadCount: number };
        if (!active) return;
        const newItems = data.notifications.filter((item) => !item.readAt && seen.current && !seen.current.has(item.id));
        const latest = newItems.find((item) => item.eventType !== 'chat.message');
        for (const item of newItems) showBrowserAlert({ id: item.id, eventType: item.eventType, title: notificationTitle(item), body: item.payload.description }, () => openRef.current(item));
        reconcileBrowserAlerts(data.notifications.filter((item) => !item.readAt).map((item) => item.id));
        if (latest) { setNotice(latest); playNotificationSound(); }
        if (!seen.current) seen.current = new Set();
        data.notifications.forEach((item) => seen.current!.add(item.id));
        setItems(data.notifications); setUnread(data.unreadCount); setError('');
      } catch {
        if (active) setError('Could not load notifications. Try again.');
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [userId, playNotificationSound, showBrowserAlert, reconcileBrowserAlerts]); // Poll independently of the currently open workspace or task.

  const markRead = useCallback(async (id?: string) => {
    const response = await apiFetch(buildApiUrl(id ? `/notifications/${id}/read` : '/notifications/read-all'), { method: 'POST' });
    if (!response.ok) throw new Error('Could not mark notifications as read.');
    setNotice((current) => !id || current?.id === id ? null : current);
    await refreshRef.current();
  }, []);

  const openNotification = async (item: Notification) => {
    try {
      await markRead(item.id);
      setAnchor(null); setNotice(null);
      if (item.payload.workspaceId) {
        const query = new URLSearchParams({ workspaceId: item.payload.workspaceId, notificationId: item.id });
        if (item.payload.conversationId) query.set('conversationId', item.payload.conversationId);
        if (item.payload.messageId) query.set('messageId', item.payload.messageId);
        if (item.payload.annotationId) query.set('annotationId', item.payload.annotationId);
        if (item.payload.filePath) query.set('filePath', item.payload.filePath);
        navigate(`/?${query}`);
      }
    } catch { setError('Could not mark notification as read. Try again.'); }
  };

  useEffect(() => { openRef.current = (item) => { void openNotification(item); }; });

  const visibleItems = view === 'unread' ? items.filter((item) => !item.readAt) : items;
  const content = <section className="notification-inbox" aria-label="Notification inbox">
    <header className="notification-header">
      <div><h2>Notifications</h2><span className="notification-subtitle">{unread ? `${unread} unread` : 'You’re up to date'}</span></div>
      <div className="notification-actions">
        <IconButton label="Mark all read" tooltip="Mark all read" icon={<CheckCheck size={17} />} variant="ghost" size="sm" isDisabled={!unread} onClick={() => void markRead().catch(() => setError('Could not mark notifications as read. Try again.'))} />
        <IconButton label="Close notifications" icon={<X size={17} />} variant="ghost" size="sm" onClick={() => setAnchor(null)} />
      </div>
    </header>
    <div className="notification-view"><SegmentedControl label="Notification view" value={view} onChange={setView} layout="fill" size="sm"><SegmentedControlItem value="unread" label="Unread" /><SegmentedControlItem value="all" label="All" /></SegmentedControl></div>
    {error && <div className="notification-error" role="alert"><span>{error}</span><Button label="Retry" variant="ghost" size="sm" onClick={() => void refreshRef.current()} /></div>}
    <div className="notification-list">
      {!visibleItems.length && <div className="notification-empty"><Bell size={24} strokeWidth={1.5} /><p>{loading ? 'Loading notifications…' : error ? 'Notifications are unavailable.' : 'You’re all caught up.'}</p><span>{view === 'unread' ? 'Read notifications are saved in All.' : 'Task updates and mentions will appear here.'}</span></div>}
      {visibleItems.map((item) => {
        const Icon = item.eventType === 'agent.feedback_required' ? CircleHelp : item.eventType === 'chat.mentioned' ? AtSign : item.eventType === 'agent.completed' ? Check : FileCheck2;
        return <button key={item.id} type="button" className="notification-item" data-unread={!item.readAt} onClick={() => void openNotification(item)}>
          <span className="notification-event-icon"><Icon size={18} strokeWidth={1.7} /></span>
          <span className="notification-copy"><span className="notification-title">{notificationTitle(item)}</span>
            {item.payload.description && <span className="notification-description">{item.payload.description.slice(0, 240)}</span>}
            <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{notificationTime(item.createdAt)}</time>
          </span>
          {!item.readAt && <span className="notification-unread-dot" aria-label="Unread" />}
        </button>;
      })}
    </div>
    <footer className="notification-footer">
      <div className="notification-browser-settings">
        <div className="notification-sound-row">
          <Button label={browser.enabled ? 'Disable browser alerts' : 'Enable browser alerts'} variant="ghost" size="sm" isDisabled={!browser.supported || browser.permission === 'denied'} onClick={browser.enabled ? browser.disable : browser.enable} />
          {browser.enabled && <Button label="Test alert" variant="ghost" size="sm" onClick={browser.test} />}
        </div>
        {browser.enabled && <SegmentedControl label="Browser alert preference" value={browser.scope} onChange={(value) => browser.setScope(value === 'all' ? 'all' : 'important')} layout="fill" size="sm"><SegmentedControlItem value="important" label="Mentions & tasks" /><SegmentedControlItem value="all" label="All messages & tasks" /></SegmentedControl>}
        <p className="notification-sound-hint">{!browser.supported ? 'Browser alerts are unavailable in this browser.' : browser.permission === 'denied' ? 'Notifications are blocked. Allow them in your browser’s site settings.' : 'Desktop alerts while HelpUDoc is open, including in a background tab.'}</p>
        {browser.error && <p className="notification-error" role="status">{browser.error}</p>}
      </div>
      <div className="notification-sound-row">
        <Button label={sound.enabled ? 'Mute sound' : 'Enable sound'} icon={sound.enabled ? <Volume2 size={15} /> : <VolumeX size={15} />} variant="ghost" size="sm" aria-pressed={sound.enabled} onClick={sound.enabled ? sound.mute : sound.enable} />
        {sound.enabled ? <Button label="Test sound" variant="ghost" size="sm" onClick={sound.test} /> : <span className="notification-sound-hint">Sound is off</span>}
      </div>
      {sound.enabled && !sound.ready && <p className="notification-sound-hint">Click Test sound to activate audio in this tab.</p>}
      {sound.error && <p className="notification-error" role="status">{sound.error}</p>}
    </footer>
  </section>;

  return <NotificationContext.Provider value={userId ? { unread, activeId: anchor, content, close: () => setAnchor(null), open: (id) => { setAnchor(id); setView('unread'); void refreshRef.current(); } } : null}>
    {children}
    {notice && !anchor && <div className="notification-toast"><Toast type="info" body={notificationTitle(notice)} isAutoHide autoHideDuration={7000} onDismiss={() => setNotice(null)} endContent={<Button label="View" variant="ghost" size="sm" onClick={() => void openNotification(notice)} />} /></div>}
  </NotificationContext.Provider>;
}

export default function NotificationCenter({ placement = 'above' }: { placement?: 'above' | 'below' | 'end' }) {
  const context = useContext(NotificationContext);
  const id = useId();
  if (!context) return null;
  return <Popover label="Notifications" placement={placement} alignment={placement === 'end' ? 'end' : 'start'} width="min(380px, calc(100vw - 32px))" className="notification-popover" style={{ padding: 0 }} isOpen={context.activeId === id} onOpenChange={(open) => open ? context.open(id) : context.activeId === id && context.close()} content={context.content}>
    <span className="notification-trigger">
      <IconButton label={`Notifications${context.unread ? `, ${context.unread} unread` : ''}`} tooltip="Notifications" icon={<Bell size={19} strokeWidth={1.7} />} variant="ghost" size="md" />
      {context.unread > 0 && <span className="notification-count" aria-hidden="true">{context.unread > 99 ? '99+' : context.unread}</span>}
    </span>
  </Popover>;
}

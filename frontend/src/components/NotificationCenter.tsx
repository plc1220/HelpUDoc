import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Badge, Box, Button, Divider, IconButton, List, ListItemButton, ListItemText, Popover, Snackbar, Typography } from '@mui/material';
import { NotificationsOutlined, VolumeOffOutlined, VolumeUpOutlined } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { apiFetch, buildApiUrl } from '../services/apiClient';
import { useNotificationSound } from '../hooks/useNotificationSound';

type Notification = {
  id: string;
  eventType: string;
  createdAt: string;
  readAt: string | null;
  payload: { title?: string; description?: string; workspaceId?: string; conversationId?: string; messageId?: string };
};

const NotificationContext = createContext<{ unread: number; open: (anchor: HTMLElement) => void } | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const navigate = useNavigate();
  const sound = useNotificationSound(userId);
  const playNotificationSound = sound.play;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
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
        const latest = data.notifications.find((item) => !item.readAt && seen.current && !seen.current.has(item.id));
        if (latest) { setNotice(latest); playNotificationSound(); }
        seen.current = new Set(data.notifications.map((item) => item.id));
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
  }, [userId, playNotificationSound]); // Poll independently of the currently open workspace or task.

  const markRead = useCallback(async (id?: string) => {
    const response = await apiFetch(buildApiUrl(id ? `/notifications/${id}/read` : '/notifications/read-all'), { method: 'POST' });
    if (!response.ok) throw new Error('Could not mark notifications as read.');
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
        navigate(`/?${query}`);
      }
    } catch { setError('Could not mark notification as read. Try again.'); }
  };

  return <NotificationContext.Provider value={userId ? { unread, open: (element) => { setAnchor(element); void refreshRef.current(); } } : null}>
    {children}
    <Popover open={Boolean(anchor)} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
      <Box sx={{ width: 380, maxWidth: 'calc(100vw - 24px)' }}>
        <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography component="h2" fontWeight={600}>Notifications</Typography>
          <Button size="small" disabled={!unread} onClick={() => void markRead().catch(() => setError('Could not mark notifications as read. Try again.'))}>Mark all read</Button>
        </Box>
        <Box sx={{ px: 2, pb: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Button size="small" startIcon={sound.enabled ? <VolumeUpOutlined /> : <VolumeOffOutlined />} aria-pressed={sound.enabled} onClick={sound.enabled ? sound.mute : sound.enable}>
              {sound.enabled ? 'Mute sound' : 'Enable sound'}
            </Button>
            {sound.enabled && <Button size="small" onClick={sound.test}>Test sound</Button>}
          </Box>
          <Typography variant="caption" color="text.secondary">
            {sound.enabled && !sound.ready ? 'Click Test sound to activate audio in this tab.' : 'Sound alerts play while this app is open.'}
          </Typography>
          {sound.error && <Alert severity="info" sx={{ mt: 1 }}>{sound.error}</Alert>}
        </Box>
        <Divider />
        {error && <Alert severity="error" action={<Button onClick={() => void refreshRef.current()}>Retry</Button>}>{error}</Alert>}
        <List sx={{ maxHeight: '60vh', overflowY: 'auto', py: 0 }}>
          {!items.length && <Typography sx={{ p: 3 }} color="text.secondary">{loading ? 'Loading notifications…' : error ? 'Notifications are unavailable.' : 'You’re all caught up.'}</Typography>}
          {items.map((item) => <ListItemButton key={item.id} alignItems="flex-start" onClick={() => void openNotification(item)} sx={{ bgcolor: item.readAt ? undefined : 'action.selected', borderBottom: 1, borderColor: 'divider' }}>
            <ListItemText primary={<Typography fontWeight={item.readAt ? 400 : 600} fontSize={14}>{item.payload.title || item.eventType.replaceAll(/[._]/g, ' ')}</Typography>} secondary={<>
              <span style={{ display: 'block', overflowWrap: 'anywhere' }}>{item.payload.description?.slice(0, 240)}</span>
              <span>{new Date(item.createdAt).toLocaleString()}</span>
            </>} />
          </ListItemButton>)}
        </List>
      </Box>
    </Popover>
    <Snackbar open={Boolean(notice) && !anchor} autoHideDuration={7000} onClose={() => setNotice(null)} message={notice?.payload.title || 'New notification'} action={<Button color="inherit" onClick={() => notice && void openNotification(notice)}>View</Button>} />
  </NotificationContext.Provider>;
}

export default function NotificationCenter() {
  const context = useContext(NotificationContext);
  if (!context) return null;
  return <IconButton aria-label={`Notifications${context.unread ? `, ${context.unread} unread` : ''}`} title="Notifications" onClick={(event) => context.open(event.currentTarget)}>
    <Badge badgeContent={context.unread} color="error" max={99}><NotificationsOutlined fontSize="small" /></Badge>
  </IconButton>;
}

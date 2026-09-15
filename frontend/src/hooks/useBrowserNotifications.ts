import { useCallback, useEffect, useRef, useState } from 'react';

export type BrowserAlert = { id: string; eventType: string; title: string; body?: string };
type Preference = 'important' | 'all';
const supported = () => typeof window.Notification !== 'undefined' && window.isSecureContext;

/** Desktop alerts for new durable events while a signed-in tab is running. */
export function useBrowserNotifications(userId?: string) {
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [scope, setScope] = useState<Preference>('important');
  const [error, setError] = useState('');
  const controls = useRef<{ enable: () => Promise<void>; disable: () => void; test: () => void; scope: (value: Preference) => void; show: (alert: BrowserAlert, open: () => void) => void; reconcile: (ids: string[]) => void }>({ enable: async () => {}, disable: () => {}, test: () => {}, scope: () => {}, show: () => {}, reconcile: () => {} });

  useEffect(() => {
    let active = true;
    let optedIn = false;
    let preference: Preference = 'important';
    const key = `helpudoc.notifications.browser.${userId}`;
    const deliveredKey = `${key}.delivered`;
    const openAlerts = new Map<string, Notification>();
    const delivered = new Set<string>();
    const readPreference = () => {
      try {
        const saved = JSON.parse(localStorage.getItem(key) || '{}');
        optedIn = !!userId && saved.enabled === true;
        preference = saved.scope === 'all' ? 'all' : 'important';
      } catch { optedIn = false; }
      setEnabled(optedIn); setScope(preference);
      setPermission(supported() ? Notification.permission : 'default');
    };
    const save = () => {
      setEnabled(optedIn); setScope(preference);
      try { localStorage.setItem(key, JSON.stringify({ enabled: optedIn, scope: preference })); } catch { /* Session preference remains usable. */ }
    };
    const closeAll = () => { openAlerts.forEach((alert) => alert.close()); openAlerts.clear(); };
    const display = (alert: BrowserAlert, open: () => void) => {
      const notification = new Notification(alert.title, {
        body: alert.body?.slice(0, 240), tag: `helpudoc:${userId}:${alert.id}`, silent: true,
      });
      openAlerts.set(alert.id, notification);
      notification.onclick = () => { notification.close(); if (active) { window.focus(); open(); } };
      notification.onclose = () => openAlerts.delete(alert.id);
      notification.onerror = () => { if (active) setError('Browser alerts could not be displayed. Check your browser and system notification settings.'); };
    };
    const show = async (alert: BrowserAlert, open: () => void) => {
      const deliver = () => {
        if (!active || !userId || !optedIn || !supported() || Notification.permission !== 'granted') return;
        if (alert.eventType === 'chat.message' && preference !== 'all') return;
        if (delivered.has(alert.id)) return;
        let history: string[] = [];
        try { history = JSON.parse(localStorage.getItem(deliveredKey) || '[]'); } catch { /* In-memory deduplication remains available. */ }
        if (!Array.isArray(history)) history = [];
        if (history.includes(alert.id)) return;
        try {
          display(alert, open);
          delivered.add(alert.id);
          try { localStorage.setItem(deliveredKey, JSON.stringify([...history, alert.id].slice(-300))); } catch { /* Session-only storage. */ }
        } catch { setError('Browser alerts are unavailable here. Try another desktop browser.'); }
      };
      // Serialize tabs so a single event produces one desktop alert per browser profile.
      if (navigator.locks) await navigator.locks.request(deliveredKey, deliver);
      else deliver();
    };
    controls.current = {
      enable: async () => {
        if (!userId || !supported()) return;
        try {
          // Keep the permission prompt directly inside the user's click gesture.
          const result = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
          if (!active) return;
          setPermission(result); optedIn = result === 'granted'; save(); setError('');
        } catch { if (active) setError('Could not enable browser notifications. Try again.'); }
      },
      disable: () => { optedIn = false; save(); closeAll(); setError(''); },
      scope: (value) => { preference = value; save(); },
      test: () => {
        if (!active || !optedIn || !supported() || Notification.permission !== 'granted') return;
        try { display({ id: 'test', eventType: 'test', title: 'Browser notifications are ready', body: 'Task updates and mentions will appear here.' }, () => {}); setError(''); }
        catch { setError('Browser alerts are unavailable here. Try another desktop browser.'); }
      },
      show: (alert, open) => { void show(alert, open).catch(() => { if (active) setError('Could not display a browser notification.'); }); },
      reconcile: (ids) => { const unread = new Set(ids); openAlerts.forEach((alert, id) => { if (id !== 'test' && !unread.has(id)) { alert.close(); openAlerts.delete(id); } }); },
    };
    readPreference(); setError('');
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) { readPreference(); if (!optedIn) closeAll(); } };
    const onFocus = () => { if (supported()) setPermission(Notification.permission); };
    window.addEventListener('storage', onStorage); window.addEventListener('focus', onFocus);
    return () => { active = false; closeAll(); window.removeEventListener('storage', onStorage); window.removeEventListener('focus', onFocus); };
  }, [userId]);

  return {
    supported: supported(), enabled: enabled && permission === 'granted', permission, scope, error,
    enable: () => { void controls.current.enable(); }, disable: () => controls.current.disable(), test: () => controls.current.test(),
    setScope: (value: Preference) => controls.current.scope(value),
    show: useCallback((alert: BrowserAlert, open: () => void) => controls.current.show(alert, open), []),
    reconcile: useCallback((ids: string[]) => controls.current.reconcile(ids), []),
  };
}

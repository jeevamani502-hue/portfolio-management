/**
 * The bell in the header.
 *
 * Every alert, F&O entry and exit signal, and paper-position advice lands
 * here — persisted, so nothing fired while the tab was closed is lost. The
 * unread count is the only thing shown until the panel is opened; the
 * message and the numbers behind it are one click away, never a modal.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellRing, Check, Monitor, MonitorOff, Send } from 'lucide-react';
import { useNotifications } from '@/store/notifications';
import { api } from '@/services/api';
import { Button, Tooltip } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { NotificationDto } from '@/types/api';

const KIND_LABEL: Record<NotificationDto['kind'], string> = {
  alert: 'Alert',
  fno_entry: 'F&O entry',
  fno_exit: 'F&O exit',
  paper_advice: 'Paper position',
  live: 'Live trading',
  system: 'System',
};

const SEVERITY_DOT: Record<NotificationDto['severity'], string> = {
  info: 'bg-primary',
  action: 'bg-up',
  warning: 'bg-delayed',
};

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [testSent, setTestSent] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const items = useNotifications((s) => s.items);
  const unreadCount = useNotifications((s) => s.unreadCount);
  const loaded = useNotifications((s) => s.loaded);
  const desktopEnabled = useNotifications((s) => s.desktopEnabled);
  const desktopPermission = useNotifications((s) => s.desktopPermission);
  const load = useNotifications((s) => s.load);
  const markRead = useNotifications((s) => s.markRead);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const enableDesktop = useNotifications((s) => s.enableDesktop);
  const disableDesktop = useNotifications((s) => s.disableDesktop);

  // Load on mount, then poll as a fallback for anything the socket missed.
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  // A desktop notification click asks for navigation through the store.
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const link = (e as CustomEvent<string>).detail;
      if (link) navigate(link);
    };
    window.addEventListener('bt:navigate', onNavigate);
    return () => window.removeEventListener('bt:navigate', onNavigate);
  }, [navigate]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openItem = (n: NotificationDto) => {
    if (!n.readAt) void markRead([n.id]);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const sendTest = async () => {
    try {
      await api.notifications.test();
      setTestSent('Sent — it should appear here and, if enabled, on your desktop.');
    } catch {
      setTestSent('Could not send the test notification.');
    }
    window.setTimeout(() => setTestSent(null), 6000);
  };

  const BellIcon = unreadCount > 0 ? BellRing : Bell;

  return (
    <div ref={panelRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : 'Notifications'}
        aria-expanded={open}
        className="relative text-muted-foreground transition-colors hover:text-foreground"
      >
        <BellIcon className={cn('h-4 w-4', unreadCount > 0 && 'text-foreground')} />
        {unreadCount > 0 && (
          <span
            className="absolute -right-1.5 -top-1.5 min-w-[1rem] rounded-full bg-primary px-1 text-center
                       text-[10px] font-semibold leading-4 text-primary-foreground"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-8 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border
                     border-border bg-card text-card-foreground shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="text-sm font-semibold">
              Notifications
              {unreadCount > 0 && (
                <span className="ml-1.5 text-2xs font-normal text-muted-foreground">{unreadCount} unread</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Tooltip content={desktopEnabled ? 'Desktop notifications on — click to turn off' : desktopPermission === 'denied' ? 'Desktop notifications are blocked in your browser settings' : desktopPermission === 'unsupported' ? 'This browser does not support desktop notifications' : 'Show desktop notifications for alerts and signals'}>
                <button
                  onClick={() => (desktopEnabled ? disableDesktop() : void enableDesktop())}
                  disabled={desktopPermission === 'denied' || desktopPermission === 'unsupported'}
                  aria-label="Toggle desktop notifications"
                  className={cn(
                    'rounded p-1.5 transition-colors hover:bg-accent disabled:opacity-40',
                    desktopEnabled ? 'text-up' : 'text-muted-foreground',
                  )}
                >
                  {desktopEnabled ? <Monitor className="h-3.5 w-3.5" /> : <MonitorOff className="h-3.5 w-3.5" />}
                </button>
              </Tooltip>
              <Tooltip content="Send yourself a test notification">
                <button
                  onClick={() => void sendTest()}
                  aria-label="Send a test notification"
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              {unreadCount > 0 && (
                <Tooltip content="Mark all as read">
                  <button
                    onClick={() => void markAllRead()}
                    aria-label="Mark all as read"
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              )}
            </div>
          </div>

          {testSent && (
            <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
              {testSent}
            </div>
          )}

          <ul className="max-h-[70vh] divide-y divide-border overflow-y-auto">
            {!loaded ? (
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</li>
            ) : items.length === 0 ? (
              <li className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
                Nothing yet. Alerts, F&amp;O entry and exit signals, and paper-position advice will
                appear here as they fire — and stay here even if the tab was closed at the time.
              </li>
            ) : (
              items.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => openItem(n)}
                    className={cn(
                      'flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/60',
                      !n.readAt && 'bg-primary/5',
                    )}
                  >
                    <span
                      className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[n.severity], n.readAt && 'opacity-40')}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={cn('truncate text-sm', !n.readAt && 'font-medium')}>{n.title}</span>
                        <span className="shrink-0 text-2xs text-muted-foreground">{relativeTime(n.createdAt)}</span>
                      </span>
                      <span className="mt-0.5 line-clamp-3 block text-2xs leading-relaxed text-muted-foreground">
                        {n.message}
                      </span>
                      <span className="mt-1 block text-[10px] uppercase tracking-wide text-muted-foreground/70">
                        {KIND_LABEL[n.kind]}
                      </span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>

          <div className="border-t border-border px-3 py-2">
            <Button variant="ghost" size="sm" className="w-full justify-center" onClick={() => { setOpen(false); navigate('/alerts'); }}>
              Manage alerts
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Notification feed.
 *
 * Two sources feed it: the persisted list loaded on sign-in (so an alert that
 * fired while the browser was closed is still there), and the websocket push
 * that arrives as things happen. Desktop notifications are opt-in and off by
 * default — the browser permission prompt is only ever shown after the user
 * clicks the button asking for it.
 */
import { create } from 'zustand';
import { api } from '@/services/api';
import type { NotificationDto } from '@/types/api';

const DESKTOP_KEY = 'bt-desktop-notifications';

type Permission = NotificationPermission | 'unsupported';

const readDesktopPreference = (): boolean => {
  try {
    return localStorage.getItem(DESKTOP_KEY) === 'on';
  } catch {
    return false;
  }
};

const currentPermission = (): Permission =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

interface NotificationState {
  items: NotificationDto[];
  unreadCount: number;
  loaded: boolean;
  desktopEnabled: boolean;
  desktopPermission: Permission;

  load: () => Promise<void>;
  /** A notification pushed over the websocket. */
  receive: (n: NotificationDto) => void;
  markRead: (ids: number[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  enableDesktop: () => Promise<boolean>;
  disableDesktop: () => void;
  reset: () => void;
}

const MAX_ITEMS = 200;

export const useNotifications = create<NotificationState>((set, get) => ({
  items: [],
  unreadCount: 0,
  loaded: false,
  desktopEnabled: readDesktopPreference() && currentPermission() === 'granted',
  desktopPermission: currentPermission(),

  load: async () => {
    try {
      const res = await api.notifications.list({ limit: 100 });
      set({ items: res.items, unreadCount: res.unreadCount, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  receive: (n) => {
    set((s) => {
      if (s.items.some((i) => i.id === n.id)) return s;
      return {
        items: [n, ...s.items].slice(0, MAX_ITEMS),
        unreadCount: n.readAt ? s.unreadCount : s.unreadCount + 1,
      };
    });
    showDesktop(n, get().desktopEnabled);
  },

  markRead: async (ids) => {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    set((s) => {
      const changed = s.items.filter((i) => ids.includes(i.id) && !i.readAt).length;
      return {
        items: s.items.map((i) => (ids.includes(i.id) && !i.readAt ? { ...i, readAt: now } : i)),
        unreadCount: Math.max(0, s.unreadCount - changed),
      };
    });
    try {
      await api.notifications.markRead(ids);
    } catch {
      // The optimistic update stands; the server catches up on the next load.
    }
  },

  markAllRead: async () => {
    const now = new Date().toISOString();
    set((s) => ({
      items: s.items.map((i) => (i.readAt ? i : { ...i, readAt: now })),
      unreadCount: 0,
    }));
    try {
      await api.notifications.markAllRead();
    } catch {
      // As above.
    }
  },

  enableDesktop: async () => {
    if (typeof Notification === 'undefined') {
      set({ desktopPermission: 'unsupported' });
      return false;
    }
    let permission = Notification.permission;
    if (permission === 'default') {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = 'denied';
      }
    }
    const granted = permission === 'granted';
    try {
      localStorage.setItem(DESKTOP_KEY, granted ? 'on' : 'off');
    } catch {
      // Private browsing; the toggle still works for this session.
    }
    set({ desktopEnabled: granted, desktopPermission: permission });
    return granted;
  },

  disableDesktop: () => {
    try {
      localStorage.setItem(DESKTOP_KEY, 'off');
    } catch {
      // As above.
    }
    set({ desktopEnabled: false });
  },

  reset: () => set({ items: [], unreadCount: 0, loaded: false }),
}));

/**
 * Show a system notification, when allowed.
 *
 * Clicking it focuses the tab and asks the app to navigate; the store cannot
 * hold a router, so it raises a window event the layout listens for.
 */
function showDesktop(n: NotificationDto, enabled: boolean): void {
  if (!enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const toast = new Notification(n.title, {
      body: n.message.length > 220 ? `${n.message.slice(0, 217)}…` : n.message,
      tag: `bt-${n.id}`,
      // Warnings (a stop hit, a thesis invalidated) must not be auto-dismissed
      // by the OS before they are seen.
      requireInteraction: n.severity === 'warning',
    });
    toast.onclick = () => {
      window.focus();
      if (n.link) window.dispatchEvent(new CustomEvent('bt:navigate', { detail: n.link }));
      toast.close();
    };
  } catch {
    // Some browsers throw on the constructor outside a service worker; the
    // in-app bell still carries the notification.
  }
}

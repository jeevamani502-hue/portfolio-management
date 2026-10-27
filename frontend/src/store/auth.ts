import { create } from 'zustand';
import {
  api, setAccessToken, getAccessToken, setUnauthorizedHandler, refreshAccessToken, ApiRequestError,
} from '@/services/api';
import type { AuthUserDto } from '@/types/api';
import { storeRefreshToken } from '@/lib/server';

interface AuthState {
  user: AuthUserDto | null;
  /** Set while an administrator is viewing the app as another user. */
  impersonating: { adminUser: AuthUserDto; adminToken: string } | null;
  /** Null until the initial session probe finishes. */
  initialised: boolean;
  loading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName?: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Attempt to restore a session from the refresh cookie on page load. */
  restore: () => Promise<void>;
  clearError: () => void;
  /** Admin only: switch the whole app to another user's view for 30 minutes. */
  viewAs: (userId: string) => Promise<void>;
  /** Back to the administrator's own session. */
  endViewAs: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  impersonating: null,
  initialised: false,
  loading: false,
  error: null,

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const res = await api.auth.login(email, password);
      setAccessToken(res.accessToken);
      if (res.refreshToken) storeRefreshToken(res.refreshToken);
      set({ user: res.user, loading: false, initialised: true });
    } catch (err) {
      const message =
        err instanceof ApiRequestError ? err.message : 'Sign-in failed. Please try again.';
      set({ error: message, loading: false });
      throw err;
    }
  },

  register: async (email, password, fullName) => {
    set({ loading: true, error: null });
    try {
      const res = await api.auth.register(email, password, fullName);
      setAccessToken(res.accessToken);
      if (res.refreshToken) storeRefreshToken(res.refreshToken);
      set({ user: res.user, loading: false, initialised: true });
    } catch (err) {
      const message =
        err instanceof ApiRequestError ? err.message : 'Registration failed. Please try again.';
      set({ error: message, loading: false });
      throw err;
    }
  },

  logout: async () => {
    try {
      await api.auth.logout();
    } catch {
      // A failed logout call must still clear local state.
    }
    setAccessToken(null);
    storeRefreshToken(null);
    set({ user: null, error: null });
  },

  restore: async () => {
    try {
      // Goes through the shared in-flight promise in api.ts, so a 401 retry
      // happening at the same time reuses this refresh instead of starting a
      // second one that would present an already-rotated token.
      const token = await refreshAccessToken();
      if (!token) {
        set({ initialised: true, user: null });
        return;
      }
      const user = await api.auth.me();
      set({ user, initialised: true });
    } catch {
      setAccessToken(null);
      set({ initialised: true, user: null });
    }
  },

  clearError: () => set({ error: null }),

  viewAs: async (userId) => {
    const adminUser = useAuth.getState().user;
    const adminToken = getAccessToken();
    if (!adminUser || !adminToken) throw new Error('Sign in as an administrator first.');
    const res = await api.admin.impersonate(userId);
    setAccessToken(res.accessToken);
    set({ user: res.user, impersonating: { adminUser, adminToken } });
  },

  endViewAs: () => {
    const imp = useAuth.getState().impersonating;
    if (!imp) return;
    setAccessToken(imp.adminToken);
    set({ user: imp.adminUser, impersonating: null });
  },
}));

// When the API client exhausts its refresh attempt, drop the session.
setUnauthorizedHandler(() => {
  // A view-as session that expires falls back to the administrator, not to sign-in.
  const imp = useAuth.getState().impersonating;
  if (imp) {
    setAccessToken(imp.adminToken);
    useAuth.setState({ user: imp.adminUser, impersonating: null });
    return;
  }
  setAccessToken(null);
  useAuth.setState({ user: null, initialised: true });
});

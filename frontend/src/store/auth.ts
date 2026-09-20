import { create } from 'zustand';
import {
  api, setAccessToken, setUnauthorizedHandler, refreshAccessToken, ApiRequestError,
} from '@/services/api';
import type { AuthUserDto } from '@/types/api';

interface AuthState {
  user: AuthUserDto | null;
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
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  initialised: false,
  loading: false,
  error: null,

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const res = await api.auth.login(email, password);
      setAccessToken(res.accessToken);
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
}));

// When the API client exhausts its refresh attempt, drop the session.
setUnauthorizedHandler(() => {
  setAccessToken(null);
  useAuth.setState({ user: null, initialised: true });
});

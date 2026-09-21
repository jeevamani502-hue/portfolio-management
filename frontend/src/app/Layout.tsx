/**
 * Application shell: sidebar, top bar with market status, and the feed
 * indicator that tells the user at a glance whether prices are live.
 */
import { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, TrendingUp, LineChart, Layers, Radar, Briefcase, Eye,
  Newspaper, Bell, FlaskConical,
  ClipboardList, Bot, Settings as SettingsIcon, LogOut,
  Menu, X, Search, Sun, Moon, Wifi, WifiOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import { useAuth } from '@/store/auth';
import { useTicks, connect, disconnect } from '@/services/ws';
import { Button, Tooltip, Badge } from '@/components/ui';
import { SymbolSearch } from '@/components/market/SymbolSearch';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/markets', label: 'Markets', icon: TrendingUp },
  { to: '/stocks', label: 'Stocks', icon: LineChart },
  { to: '/fno', label: 'F&O', icon: Layers },
  { to: '/scanner', label: 'Swing Scanner', icon: Radar },
  { to: '/portfolio', label: 'Portfolio', icon: Briefcase },
  { to: '/watchlist', label: 'Watchlist', icon: Eye },
  { to: '/news', label: 'News', icon: Newspaper },
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/paper', label: 'Paper Trading', icon: ClipboardList },
  { to: '/backtest', label: 'Backtesting', icon: FlaskConical },
  { to: '/analyst', label: 'AI Analyst', icon: Bot },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

function useTheme() {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem('bt-theme');
    if (stored) return stored === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('bt-theme', dark ? 'dark' : 'light');
    } catch {
      // Private browsing; the toggle still works for this session.
    }
  }, [dark]);

  return { dark, toggle: () => setDark((d) => !d) };
}

function FeedIndicator() {
  const feedState = useTicks((s) => s.feedState);
  const feedReason = useTicks((s) => s.feedReason);

  const config = {
    connected: { icon: Wifi, label: 'Streaming', cls: 'text-live' },
    connecting: { icon: Wifi, label: 'Connecting', cls: 'text-delayed' },
    disconnected: { icon: WifiOff, label: 'Not streaming', cls: 'text-muted-foreground' },
    unavailable: { icon: WifiOff, label: 'No live feed', cls: 'text-delayed' },
  }[feedState];

  const Icon = config.icon;

  return (
    <Tooltip
      content={
        <div className="space-y-1">
          <div className="font-semibold">{config.label}</div>
          <div>
            {feedState === 'connected'
              ? 'Prices are streaming over the websocket. Values still carry their own freshness status.'
              : 'Prices are fetched on request instead of streamed. Each value shows how fresh it actually is.'}
          </div>
          {feedReason && <div className="opacity-80">{feedReason}</div>}
        </div>
      }
    >
      <span className={cn('inline-flex items-center gap-1.5 text-2xs font-medium', config.cls)}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
        <span className="hidden sm:inline">{config.label}</span>
      </span>
    </Tooltip>
  );
}

function MarketStatusBadge() {
  const { data } = useQuery({
    queryKey: ['market', 'status'],
    queryFn: () => api.market.status(),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  if (!data) return null;

  const variant =
    data.phase === 'OPEN' ? 'up'
    : data.phase === 'PRE_OPEN' || data.phase === 'CLOSING' || data.phase === 'POST' ? 'warning'
    : 'muted';

  return (
    <Tooltip
      content={
        <div className="space-y-1">
          <div className="font-semibold">{data.label}</div>
          <div>{data.nowIst}</div>
          {data.nextTransition && (
            <div>
              Next: {data.nextTransition.phase.replace(/_/g, ' ').toLowerCase()} at{' '}
              {new Date(data.nextTransition.at).toLocaleTimeString('en-IN', {
                hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
              })}
            </div>
          )}
        </div>
      }
    >
      <Badge variant={variant}>{data.label}</Badge>
    </Tooltip>
  );
}

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { dark, toggle } = useTheme();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();

  // Open the websocket once the user is authenticated.
  useEffect(() => {
    if (user) connect();
    return () => { if (!user) disconnect(); };
  }, [user]);

  // Cmd/Ctrl-K opens symbol search, the way every terminal does it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleLogout = async () => {
    disconnect();
    await logout();
    navigate('/login');
  };

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-border bg-card',
          'transition-transform lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-primary text-2xs font-bold text-primary-foreground">
              BT
            </div>
            <span className="text-sm font-semibold tracking-tight">Bharat Terminal</span>
          </div>
          <button
            className="lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : false}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-border p-3">
          <div className="mb-2 truncate text-2xs text-muted-foreground" title={user?.email}>
            {user?.fullName || user?.email}
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={handleLogout}>
            <LogOut className="h-3.5 w-3.5" aria-hidden />
            Sign out
          </Button>
        </div>
      </aside>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur">
          <button
            className="lg:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>

          <button
            onClick={() => setSearchOpen(true)}
            className="flex h-8 flex-1 max-w-sm items-center gap-2 rounded-md border border-border
                       bg-muted/40 px-2.5 text-xs text-muted-foreground transition-colors
                       hover:bg-muted"
          >
            <Search className="h-3.5 w-3.5" aria-hidden />
            <span>Search stocks, indices…</span>
            <kbd className="ml-auto hidden rounded border border-border px-1 text-2xs sm:inline">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-3">
            <FeedIndicator />
            <MarketStatusBadge />
            <button
              onClick={toggle}
              aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4">
          <Outlet />
        </main>

        <footer className="border-t border-border px-4 py-3">
          <p className="text-2xs leading-relaxed text-muted-foreground">
            Research and analytics only — not investment advice. Every figure shown is sourced and
            timestamped; where data cannot be obtained, the platform says so rather than estimating.
            Rule-based scores measure how many conditions currently agree and are not forecasts.
          </p>
        </footer>
      </div>

      {searchOpen && <SymbolSearch onClose={() => setSearchOpen(false)} />}
    </div>
  );
}

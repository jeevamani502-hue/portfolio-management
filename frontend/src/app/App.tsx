import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from '@/store/auth';
import { Layout } from '@/app/Layout';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { Spinner } from '@/components/ui';

import { Login } from '@/pages/auth/Login';
import { Dashboard } from '@/pages/Dashboard';
import { Markets } from '@/pages/Markets';
import { StockAnalysis } from '@/pages/StockAnalysis';
import { StockIndex } from '@/pages/StockIndex';
import { Fno } from '@/pages/Fno';
import { SwingScanner } from '@/pages/SwingScanner';
import { Portfolio } from '@/pages/Portfolio';
import { Watchlist } from '@/pages/Watchlist';
import { News } from '@/pages/News';
import { Alerts } from '@/pages/Alerts';
import { PaperTrading } from '@/pages/PaperTrading';
import { LiveTrading } from '@/pages/LiveTrading';
import { Agent } from '@/pages/Agent';
import { Backtesting } from '@/pages/Backtesting';
import { AiAnalyst } from '@/pages/AiAnalyst';
import { Settings } from '@/pages/Settings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Market data goes stale fast; components that need tighter freshness
      // set their own refetchInterval.
      staleTime: 15_000,
      retry: (failureCount, error) => {
        // Never retry a 4xx: a missing symbol or a bad token will not fix
        // itself, and retrying just multiplies upstream load.
        const status = (error as { status?: number } | null)?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: true,
    },
  },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const user = useAuth((s) => s.user);
  const initialised = useAuth((s) => s.initialised);
  const location = useLocation();

  if (!initialised) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6 text-muted-foreground" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;

  return <>{children}</>;
}

function Bootstrap({ children }: { children: React.ReactNode }) {
  const restore = useAuth((s) => s.restore);
  const initialised = useAuth((s) => s.initialised);

  useEffect(() => {
    if (!initialised) void restore();
  }, [initialised, restore]);

  return <>{children}</>;
}

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Bootstrap>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route
                path="/"
                element={
                  <RequireAuth>
                    <Layout />
                  </RequireAuth>
                }
              >
                <Route index element={<Dashboard />} />
                <Route path="markets" element={<Markets />} />
                <Route path="stocks" element={<StockIndex />} />
                <Route path="stocks/:symbol" element={<StockAnalysis />} />
                <Route path="fno" element={<Fno />} />
                <Route path="fno/:symbol" element={<Fno />} />
                <Route path="scanner" element={<SwingScanner />} />
                <Route path="portfolio" element={<Portfolio />} />
                <Route path="watchlist" element={<Watchlist />} />
                <Route path="news" element={<News />} />
                <Route path="alerts" element={<Alerts />} />
                <Route path="paper" element={<PaperTrading />} />
                <Route path="live" element={<LiveTrading />} />
                <Route path="agent" element={<Agent />} />
                <Route path="backtest" element={<Backtesting />} />
                <Route path="analyst" element={<AiAnalyst />} />
                <Route path="settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </Bootstrap>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

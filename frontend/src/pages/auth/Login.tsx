import { useState, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { LineChart } from 'lucide-react';
import { useAuth } from '@/store/auth';
import { Button, Input, Label, Card, CardContent, Alert, Spinner } from '@/components/ui';

export function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');

  const user = useAuth((s) => s.user);
  const initialised = useAuth((s) => s.initialised);
  const loading = useAuth((s) => s.loading);
  const error = useAuth((s) => s.error);
  const login = useAuth((s) => s.login);
  const register = useAuth((s) => s.register);
  const clearError = useAuth((s) => s.clearError);
  const location = useLocation();

  useEffect(() => {
    clearError();
  }, [mode, clearError]);

  if (initialised && user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, fullName || undefined);
    } catch {
      // The store already holds the message; nothing else to do here.
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
            <LineChart className="h-5 w-5 text-primary-foreground" aria-hidden />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">AdviSha</h1>
          <p className="text-xs text-muted-foreground">
            Indian market research, analytics and portfolio intelligence
          </p>
        </div>

        <Card>
          <CardContent className="space-y-4 pt-4">
            <div className="flex rounded-md border border-border p-0.5">
              {(['login', 'register'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    mode === m
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {m === 'login' ? 'Sign in' : 'Create account'}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="space-y-3">
              {mode === 'register' && (
                <div className="space-y-1.5">
                  <Label htmlFor="fullName">Full name (optional)</Label>
                  <Input
                    id="fullName"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    autoComplete="name"
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
                {mode === 'register' && (
                  <p className="text-2xs text-muted-foreground">
                    At least 10 characters, with upper case, lower case and a digit.
                  </p>
                )}
              </div>

              {error && <Alert variant="error">{error}</Alert>}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Spinner />}
                {mode === 'login' ? 'Sign in' : 'Create account'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-2xs leading-relaxed text-muted-foreground">
          This platform is a research and analytics tool. It does not provide investment advice,
          and it never displays a market value it could not source.
        </p>
      </div>
    </div>
  );
}

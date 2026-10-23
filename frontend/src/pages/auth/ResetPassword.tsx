import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LineChart } from 'lucide-react';
import { api } from '@/services/api';
import { Button, Input, Label, Card, CardContent, Alert, Spinner } from '@/components/ui';

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError('The two passwords do not match.'); return; }
    setBusy(true); setError(null);
    try {
      await api.auth.reset(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
            <LineChart className="h-5 w-5 text-primary-foreground" aria-hidden />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
        </div>
        <Card>
          <CardContent className="space-y-4 pt-4">
            {!token ? (
              <Alert variant="error">This link is missing its token. Open the link exactly as it was sent, or request a new one.</Alert>
            ) : done ? (
              <Alert variant="default" title="Password changed">
                You can sign in with the new password now. Every other session has been signed out.
              </Alert>
            ) : (
              <form onSubmit={submit} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="password">New password</Label>
                  <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                  <p className="text-2xs text-muted-foreground">At least 10 characters, with upper case, lower case and a digit.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="confirm">Type it again</Label>
                  <Input id="confirm" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
                </div>
                {error && <Alert variant="error">{error}</Alert>}
                <Button type="submit" className="w-full" disabled={busy || !password}>
                  {busy && <Spinner />} Set new password
                </Button>
              </form>
            )}
            <p className="text-center text-xs"><Link to="/login" className="text-primary hover:underline">Go to sign in</Link></p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

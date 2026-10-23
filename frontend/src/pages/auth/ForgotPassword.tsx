import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LineChart } from 'lucide-react';
import { api } from '@/services/api';
import { Button, Input, Label, Card, CardContent, Alert, Spinner } from '@/components/ui';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ via: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      setResult(await api.auth.forgot(email.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the reset link.');
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
          <h1 className="text-xl font-semibold tracking-tight">Forgot your password?</h1>
          <p className="text-xs text-muted-foreground">Enter the email you signed up with. A one-time reset link will be sent to you.</p>
        </div>
        <Card>
          <CardContent className="space-y-4 pt-4">
            {result ? (
              <Alert variant="default" title="Check your messages">
                {result.message}
              </Alert>
            ) : (
              <form onSubmit={submit} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" />
                </div>
                {error && <Alert variant="error">{error}</Alert>}
                <Button type="submit" className="w-full" disabled={busy || !email}>
                  {busy && <Spinner />} Send reset link
                </Button>
              </form>
            )}
            <p className="text-center text-xs"><Link to="/login" className="text-primary hover:underline">Back to sign in</Link></p>
          </CardContent>
        </Card>
        <p className="text-center text-2xs leading-relaxed text-muted-foreground">
          The link works once and expires in 30 minutes. It goes by email when the server has mail set up, otherwise to your linked Telegram.
        </p>
      </div>
    </div>
  );
}

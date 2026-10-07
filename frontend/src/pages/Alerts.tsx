import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Bell, BellOff } from 'lucide-react';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Button, Input, Label,
  Select, Alert, EmptyState, Tooltip,
} from '@/components/ui';
import { relativeTime } from '@/lib/format';

export function Alerts() {
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();

  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api.alerts.list() });
  const kinds = useQuery({ queryKey: ['alerts', 'kinds'], queryFn: () => api.alerts.kinds() });

  const remove = useMutation({
    mutationFn: (id: string) => api.alerts.remove(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.alerts.update(id, { isActive }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  if (alerts.isLoading) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Alerts</h1>
          <p className="text-2xs text-muted-foreground">
            Evaluated by a background worker against the same data the rest of the platform uses.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating((c) => !c)}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          New alert
        </Button>
      </div>

      {creating && kinds.data && (
        <CreateAlertForm kinds={kinds.data} onDone={() => setCreating(false)} />
      )}

      <Alert variant="info">
        When a price cannot be sourced an alert is skipped and the reason logged — it never assumes
        an unchanged value. Every fired event records the exact numbers that satisfied the rule,
        with their source and timestamp.
      </Alert>

      {(alerts.data ?? []).length === 0 ? (
        <EmptyState
          icon={<Bell className="h-8 w-8" />}
          title="No alerts yet"
          description="Create an alert to be notified when a price, indicator or open-interest condition is met."
        />
      ) : (
        <div className="space-y-2">
          {(alerts.data ?? []).map((a) => (
            <Card key={a.id}>
              <CardContent className="pt-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {a.symbol ? (
                        <Link
                          to={`/stocks/${encodeURIComponent(a.symbol)}`}
                          className="text-sm font-medium hover:text-primary"
                        >
                          {a.symbol.split(':')[1] ?? a.symbol}
                        </Link>
                      ) : (
                        <span className="text-sm font-medium">Market-wide</span>
                      )}
                      <Badge variant={a.isActive ? 'default' : 'muted'}>
                        {a.isActive ? 'Active' : 'Paused'}
                      </Badge>
                      <Badge variant="secondary">{a.kind.replace(/_/g, ' ').toLowerCase()}</Badge>
                      <Badge variant="muted">{a.timeframe}</Badge>
                    </div>
                    <div className="mt-1 text-2xs text-muted-foreground">
                      {Object.entries(a.params).map(([k, v]) => (
                        <span key={k} className="mr-3">
                          {k}: <span className="tabular text-foreground">{String(v)}</span>
                        </span>
                      ))}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-2xs text-muted-foreground">
                      <span>Channels: {a.channels.join(', ')}</span>
                      <span>Repeat: {a.repeatMode.toLowerCase()}</span>
                      <span>Fired {a.fireCount}×</span>
                      {a.lastFiredAt && <span>Last {relativeTime(a.lastFiredAt)}</span>}
                    </div>
                  </div>

                  <div className="flex shrink-0 gap-1">
                    <Tooltip content={a.isActive ? 'Pause this alert' : 'Resume this alert'}>
                      <button
                        onClick={() => toggle.mutate({ id: a.id, isActive: !a.isActive })}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        aria-label={a.isActive ? 'Pause alert' : 'Resume alert'}
                      >
                        {a.isActive ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
                      </button>
                    </Tooltip>
                    <button
                      onClick={() => remove.mutate(a.id)}
                      className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                      aria-label="Delete alert"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What each alert parameter means, so the form can render any kind the
 * server declares.
 *
 * Previously the form hard-coded three parameter names, so a kind needing
 * anything else silently submitted an empty params object and the server
 * rejected it as invalid — with no indication of which field was missing.
 * Driving the inputs from the catalogue means a new kind works here the
 * moment the server advertises it.
 */
const PARAM_META: Record<
  string,
  { label: string; type: 'number' | 'text'; default: string; min?: number; max?: number; step?: string; help?: string }
> = {
  threshold: { label: 'Threshold', type: 'number', default: '', step: 'any' },
  lookback: { label: 'Lookback bars', type: 'number', default: '20', min: 5, max: 250 },
  minStrength: { label: 'Min confirmation', type: 'number', default: '60', min: 0, max: 100 },
  minConfirmation: { label: 'Min confirmation', type: 'number', default: '50', min: 0, max: 100 },
  minGrade: {
    label: 'Min grade (A, B or C)', type: 'text', default: 'B',
    help: 'The decision engine\'s checklist grade. B is the lowest grade the engine acts on itself.',
  },
  underlying: { label: 'Underlying', type: 'text', default: 'NIFTY' },
  capital: {
    label: 'Your capital (₹)', type: 'number', default: '', min: 1,
    help: 'Required — the position cannot be sized without it.',
  },
  riskPercent: { label: 'Risk per trade (%)', type: 'number', default: '1', min: 0.1, max: 10, step: 'any' },
  minRelevance: {
    label: 'Min news relevance', type: 'number', default: '0.7', min: 0, max: 1, step: '0.05',
    help: 'How tightly the article must tie to the underlying, 0 to 1.',
  },
  direction: { label: 'Direction (LONG/SHORT, blank for both)', type: 'text', default: '' },
};

function CreateAlertForm({
  kinds,
  onDone,
}: {
  kinds: Array<{ kind: string; label: string; params: string[]; needsSymbol: boolean }>;
  onDone: () => void;
}) {
  const [kind, setKind] = useState(kinds[0]?.kind ?? 'PRICE_ABOVE');
  const [symbol, setSymbol] = useState('');
  const [timeframe, setTimeframe] = useState('1d');
  const [values, setValues] = useState<Record<string, string>>({});
  const qc = useQueryClient();

  const selected = kinds.find((k) => k.kind === kind);
  const paramNames = selected?.params ?? [];

  const valueFor = (name: string) => values[name] ?? PARAM_META[name]?.default ?? '';

  const create = useMutation({
    mutationFn: () => {
      const params: Record<string, number | string> = {};
      for (const name of paramNames) {
        const raw = valueFor(name).trim();
        // Send nothing for a blank optional field and let the server's own
        // default apply, rather than submitting 0 or an empty string.
        if (raw === '') continue;
        params[name] = PARAM_META[name]?.type === 'text' ? raw.toUpperCase() : Number(raw);
      }
      return api.alerts.create({
        kind,
        ...(symbol ? { symbol: symbol.toUpperCase() } : {}),
        params,
        timeframe,
        channels: ['browser'],
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      onDone();
    },
  });

  // Anything the server marks required must be present before submitting.
  const missing = paramNames.filter(
    (n) => PARAM_META[n]?.help?.startsWith('Required') && valueFor(n).trim() === '',
  );

  return (
    <Card>
      <CardHeader><CardTitle>New alert</CardTitle></CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
          className="grid gap-3 sm:grid-cols-4"
        >
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="a-kind">Condition</Label>
            <Select
              id="a-kind"
              value={kind}
              onChange={(e) => { setKind(e.target.value); setValues({}); }}
            >
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>{k.label}</option>
              ))}
            </Select>
          </div>

          {selected?.needsSymbol && (
            <div className="space-y-1">
              <Label htmlFor="a-symbol">Symbol</Label>
              <Input
                id="a-symbol" value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="RELIANCE" required
              />
            </div>
          )}

          {paramNames.map((name) => {
            const meta = PARAM_META[name];
            if (!meta) return null;
            return (
              <div key={name} className="space-y-1">
                <Label htmlFor={`a-${name}`}>{meta.label}</Label>
                <Input
                  id={`a-${name}`}
                  type={meta.type}
                  {...(meta.min !== undefined ? { min: meta.min } : {})}
                  {...(meta.max !== undefined ? { max: meta.max } : {})}
                  {...(meta.step ? { step: meta.step } : {})}
                  value={valueFor(name)}
                  onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                />
                {meta.help && (
                  <p className="text-2xs leading-relaxed text-muted-foreground">{meta.help}</p>
                )}
              </div>
            );
          })}

          <div className="space-y-1">
            <Label htmlFor="a-tf">Timeframe</Label>
            <Select id="a-tf" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
              {['5m', '15m', '1h', '1d'].map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </div>

          <div className="flex items-end gap-2 sm:col-span-4">
            <Button type="submit" disabled={create.isPending || missing.length > 0}>
              {create.isPending ? 'Creating…' : 'Create alert'}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
            {missing.length > 0 && (
              <span className="text-sm text-muted-foreground">
                Fill in {missing.map((m) => PARAM_META[m]?.label ?? m).join(', ')}.
              </span>
            )}
          </div>
        </form>
        {create.isError && (
          <Alert variant="error" className="mt-2">{(create.error as Error).message}</Alert>
        )}
      </CardContent>
    </Card>
  );
}

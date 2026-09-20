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

function CreateAlertForm({
  kinds,
  onDone,
}: {
  kinds: Array<{ kind: string; label: string; params: string[]; needsSymbol: boolean }>;
  onDone: () => void;
}) {
  const [kind, setKind] = useState(kinds[0]?.kind ?? 'PRICE_ABOVE');
  const [symbol, setSymbol] = useState('');
  const [threshold, setThreshold] = useState('');
  const [lookback, setLookback] = useState('20');
  const [timeframe, setTimeframe] = useState('1d');
  const qc = useQueryClient();

  const selected = kinds.find((k) => k.kind === kind);

  const create = useMutation({
    mutationFn: () => {
      const params: Record<string, number> = {};
      if (selected?.params.includes('threshold')) params['threshold'] = Number(threshold);
      if (selected?.params.includes('lookback')) params['lookback'] = Number(lookback);
      if (selected?.params.includes('minStrength')) params['minStrength'] = Number(threshold || 60);
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

  return (
    <Card>
      <CardHeader><CardTitle>New alert</CardTitle></CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
          className="grid gap-3 sm:grid-cols-5"
        >
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="a-kind">Condition</Label>
            <Select id="a-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
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

          {(selected?.params.includes('threshold') || selected?.params.includes('minStrength')) && (
            <div className="space-y-1">
              <Label htmlFor="a-threshold">
                {selected.params.includes('minStrength') ? 'Min confirmation' : 'Threshold'}
              </Label>
              <Input
                id="a-threshold" type="number" step="any"
                value={threshold} onChange={(e) => setThreshold(e.target.value)} required
              />
            </div>
          )}

          {selected?.params.includes('lookback') && (
            <div className="space-y-1">
              <Label htmlFor="a-lookback">Lookback bars</Label>
              <Input
                id="a-lookback" type="number" min={5} max={250}
                value={lookback} onChange={(e) => setLookback(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="a-tf">Timeframe</Label>
            <Select id="a-tf" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
              {['5m', '15m', '1h', '1d'].map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </div>

          <div className="flex items-end gap-2 sm:col-span-5">
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create alert'}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
          </div>
        </form>
        {create.isError && (
          <Alert variant="error" className="mt-2">{(create.error as Error).message}</Alert>
        )}
      </CardContent>
    </Card>
  );
}

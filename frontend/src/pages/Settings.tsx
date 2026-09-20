import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, ShieldCheck, Trash2, Loader2 } from 'lucide-react';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent, Skeleton, Badge, Button,
  Input, Label, Alert, Tabs, EmptyState,
} from '@/components/ui';
import { Metric } from '@/components/market/DataValue';
import { inr, relativeTime } from '@/lib/format';
import type { ProviderCatalogueDto } from '@/types/api';

export function Settings() {
  const [tab, setTab] = useState('providers');

  return (
    <div className="space-y-4">
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'providers', label: 'Market data providers' },
          { id: 'risk', label: 'Risk' },
          { id: 'quality', label: 'Data quality' },
        ]}
      />
      {tab === 'providers' && <ProvidersTab />}
      {tab === 'risk' && <RiskTab />}
      {tab === 'quality' && <DataQualityTab />}
    </div>
  );
}

function ProvidersTab() {
  const [editing, setEditing] = useState<string | null>(null);
  const qc = useQueryClient();

  const catalogue = useQuery({
    queryKey: ['settings', 'providers', 'catalogue'],
    queryFn: () => api.settings.providerCatalogue(),
  });

  const configured = useQuery({
    queryKey: ['settings', 'providers'],
    queryFn: () => api.settings.providers(),
  });

  const test = useMutation({
    mutationFn: (provider: string) => api.settings.testProvider(provider),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings', 'providers'] }),
  });

  const remove = useMutation({
    mutationFn: (provider: string) => api.settings.deleteProvider(provider),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings', 'providers'] }),
  });

  if (catalogue.isLoading) return <Skeleton className="h-96" />;

  const configuredMap = new Map(
    (configured.data?.data ?? []).map((c) => [c.provider, c]),
  );

  return (
    <div className="space-y-4">
      <Alert variant="info" title="How credentials are handled">
        Secrets are encrypted with AES-256-GCM before they touch the database, are never returned
        by any endpoint, and are never sent to the browser — this page only shows which fields are
        populated. Each user connects their own broker account; the platform does not redistribute
        a shared market-data feed.
      </Alert>

      <div className="grid gap-4 lg:grid-cols-2">
        {(catalogue.data ?? []).map((p) => {
          const current = configuredMap.get(p.id);
          return (
            <Card key={p.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {p.displayName}
                      {current && (
                        <Badge
                          variant={
                            current.health.status === 'healthy' ? 'up'
                            : current.health.status === 'down' ? 'down' : 'muted'
                          }
                        >
                          {current.health.status}
                        </Badge>
                      )}
                      {p.requiresOptIn && <Badge variant="warning">Opt-in required</Badge>}
                    </CardTitle>
                    <CardDescription className="mt-1">
                      Auth: {p.authModel.replace(/_/g, ' ')} · {p.capabilities.length} capabilities
                    </CardDescription>
                  </div>
                  <a
                    href={p.docsUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex shrink-0 items-center gap-1 text-2xs text-primary hover:underline"
                  >
                    Docs <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                {p.notes && (
                  <p className="text-2xs leading-relaxed text-muted-foreground">{p.notes}</p>
                )}

                <div className="flex flex-wrap gap-1">
                  {p.capabilities.map((c) => (
                    <Badge key={c} variant="muted">{c}</Badge>
                  ))}
                </div>

                {current && (
                  <div className="space-y-1 rounded-md bg-muted/40 p-2">
                    {Object.entries(current.configuredFields).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between text-2xs">
                        <span className="text-muted-foreground">{k}</span>
                        <span className="inline-flex items-center gap-1">
                          {v === true ? (
                            <>
                              <ShieldCheck className="h-3 w-3 text-up" aria-hidden />
                              <span className="text-up">stored</span>
                            </>
                          ) : v === false || v === null ? (
                            <span className="text-muted-foreground">not set</span>
                          ) : (
                            <span className="font-mono">{String(v)}</span>
                          )}
                        </span>
                      </div>
                    ))}
                    {current.health.lastError && (
                      <div className="pt-1 text-2xs text-destructive">
                        {current.health.lastError}
                      </div>
                    )}
                    {current.health.lastOkAt && (
                      <div className="pt-1 text-2xs text-muted-foreground">
                        Last successful call {relativeTime(current.health.lastOkAt)}
                      </div>
                    )}
                    {current.decryptError && (
                      <Alert variant="error">{current.decryptError}</Alert>
                    )}
                  </div>
                )}

                {editing === p.id ? (
                  <ProviderForm provider={p} onDone={() => setEditing(null)} />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(p.id)}>
                      {current ? 'Update credentials' : 'Configure'}
                    </Button>
                    {current && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => test.mutate(p.id)}
                          disabled={test.isPending}
                        >
                          {test.isPending && test.variables === p.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : null}
                          Test connection
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => remove.mutate(p.id)}
                          className="text-destructive"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden />
                          Remove
                        </Button>
                      </>
                    )}
                  </div>
                )}

                {test.isSuccess && test.variables === p.id && (
                  <Alert variant={test.data.ok ? 'info' : 'error'}>
                    {test.data.ok
                      ? `Connected in ${test.data.latencyMs} ms.`
                      : `Failed: ${test.data.detail}`}
                  </Alert>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {configured.data && (
        <p className="text-2xs text-muted-foreground">
          Environment fallback — primary:{' '}
          {String((configured.data.meta['envFallback'] as Record<string, unknown>)?.['primary'] ?? '—')}.
          When no per-user credentials are stored the server uses credentials supplied via
          environment variables.
        </p>
      )}
    </div>
  );
}

function ProviderForm({
  provider,
  onDone,
}: {
  provider: ProviderCatalogueDto;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: () =>
      api.settings.saveProvider({
        provider: provider.id,
        credentials: values,
        isEnabled: true,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings', 'providers'] });
      onDone();
    },
  });

  if (provider.credentialFields.length === 0) {
    return (
      <div className="space-y-2">
        <Alert variant="warning">
          This source needs no credentials, but it is disabled by default and must be enabled with
          the NSE_PUBLIC_ENABLED environment variable. Read the notes above before doing so.
        </Alert>
        <Button size="sm" variant="ghost" onClick={onDone}>Close</Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
      className="space-y-2 rounded-md border border-border p-3"
    >
      {provider.credentialFields.map((f) => (
        <div key={f.key} className="space-y-1">
          <Label htmlFor={`${provider.id}-${f.key}`}>
            {f.label}
            {f.required && <span className="text-destructive"> *</span>}
          </Label>
          <Input
            id={`${provider.id}-${f.key}`}
            type={f.secret ? 'password' : 'text'}
            autoComplete="off"
            value={values[f.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
          {f.help && <p className="text-2xs text-muted-foreground">{f.help}</p>}
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
      {save.isError && <Alert variant="error">{(save.error as Error).message}</Alert>}
      <p className="text-2xs text-muted-foreground">
        Leave a field blank to keep the value already stored.
      </p>
    </form>
  );
}

function RiskTab() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.settings.get() });
  const [draft, setDraft] = useState<Record<string, number> | null>(null);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.settings.patch(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      setDraft(null);
    },
  });

  if (settings.isLoading) return <Skeleton className="h-64" />;
  if (!settings.data) return null;

  const r = settings.data.risk;
  const current = draft ?? {
    capital: r.capital,
    maxRiskPerTradePct: r.maxRiskPerTradePct,
    maxDailyLossPct: r.maxDailyLossPct,
    maxOpenPositions: r.maxOpenPositions,
  };

  const riskAmount = (current['capital']! * current['maxRiskPerTradePct']!) / 100;
  const dailyAmount = (current['capital']! * current['maxDailyLossPct']!) / 100;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Risk configuration</CardTitle>
          <CardDescription>
            These values drive position sizing on every trade idea the scanner produces.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="capital">Trading capital (₹)</Label>
            <Input
              id="capital" type="number" min={1} step="any"
              value={current['capital']}
              onChange={(e) => setDraft({ ...current, capital: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="riskpct">Maximum risk per trade (%)</Label>
            <Input
              id="riskpct" type="number" min={0.1} max={100} step="0.1"
              value={current['maxRiskPerTradePct']}
              onChange={(e) => setDraft({ ...current, maxRiskPerTradePct: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dailypct">Maximum daily loss (%)</Label>
            <Input
              id="dailypct" type="number" min={0.1} max={100} step="0.1"
              value={current['maxDailyLossPct']}
              onChange={(e) => setDraft({ ...current, maxDailyLossPct: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="maxpos">Maximum open positions</Label>
            <Input
              id="maxpos" type="number" min={1} max={200} step="1"
              value={current['maxOpenPositions']}
              onChange={(e) => setDraft({ ...current, maxOpenPositions: Number(e.target.value) })}
            />
          </div>

          <Button
            onClick={() => save.mutate(current)}
            disabled={!draft || save.isPending}
            className="w-full"
          >
            {save.isPending ? 'Saving…' : 'Save risk settings'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What these settings mean</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Metric
            label="Maximum risk on a single trade"
            value={inr(riskAmount)}
            sub={`${current['maxRiskPerTradePct']}% of ${inr(current['capital'])}`}
            valueClassName="text-lg"
          />
          <Metric
            label="Daily loss limit"
            value={inr(dailyAmount)}
            sub={`${current['maxDailyLossPct']}% of capital`}
            valueClassName="text-lg"
          />
          <div className="rounded-md bg-muted/40 p-3 text-2xs leading-relaxed text-muted-foreground">
            <p className="mb-1.5 font-medium text-foreground">Worked example</p>
            <p>
              On an idea with entry ₹100 and invalidation ₹95, risk per share is ₹5. The risk budget
              of {inr(riskAmount)} divided by ₹5 gives{' '}
              {Math.floor(riskAmount / 5).toLocaleString('en-IN')} shares, a position worth{' '}
              {inr(Math.floor(riskAmount / 5) * 100)}. That would be capped if it exceeded 25% of
              capital.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DataQualityTab() {
  const events = useQuery({
    queryKey: ['settings', 'data-quality'],
    queryFn: () => api.settings.dataQuality(),
    refetchInterval: 60_000,
  });

  if (events.isLoading) return <Skeleton className="h-64" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Data-quality ledger</CardTitle>
        <CardDescription>
          Every stale read, provider failure and rejected tick is recorded here, so feed problems
          are visible rather than silent.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {(events.data ?? []).length === 0 ? (
          <EmptyState title="No data-quality events recorded" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Kind</th>
                  <th>Provider</th>
                  <th>Capability</th>
                  <th>Symbol</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {(events.data ?? []).map((e, i) => (
                  <tr key={i}>
                    <td className="text-2xs text-muted-foreground">{relativeTime(e.occurredAt)}</td>
                    <td>
                      <Badge
                        variant={
                          e.kind === 'provider_error' || e.kind === 'sanity_reject' ? 'down' : 'warning'
                        }
                      >
                        {e.kind.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="text-2xs">{e.provider ?? '—'}</td>
                    <td className="text-2xs">{e.capability ?? '—'}</td>
                    <td className="text-2xs">{e.symbol ?? '—'}</td>
                    <td className="max-w-md truncate text-2xs text-muted-foreground">
                      {JSON.stringify(e.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

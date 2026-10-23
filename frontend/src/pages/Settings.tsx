import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, ShieldCheck, Trash2, Loader2, Send, MessageCircle } from 'lucide-react';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent, Skeleton, Badge, Button,
  Input, Label, Alert, Tabs, EmptyState, Select,
} from '@/components/ui';
import { Metric } from '@/components/market/DataValue';
import { inr, relativeTime } from '@/lib/format';
import type { ProviderCatalogueDto, ChannelPrefsDto, ChannelStatusDto, NotificationKind } from '@/types/api';

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
          { id: 'phone', label: 'Phone alerts' },
          { id: 'quality', label: 'Data quality' },
        ]}
      />
      {tab === 'providers' && <ProvidersTab />}
      {tab === 'risk' && <RiskTab />}
      {tab === 'phone' && <PhoneAlertsTab />}
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

// ── phone alerts ────────────────────────────────────────────────────────────

const KIND_OPTIONS: Array<{ kind: NotificationKind; label: string }> = [
  { kind: 'paper', label: 'Paper trades opened and closed' },
  { kind: 'live', label: 'Live orders, fills and exits' },
  { kind: 'fno_entry', label: 'F&O engine says Enter' },
  { kind: 'fno_exit', label: 'F&O signal resolved (stop, target, timed out)' },
  { kind: 'alert', label: 'Your alerts firing' },
  { kind: 'paper_advice', label: 'Advice on open paper positions' },
  { kind: 'system', label: 'System messages and briefings' },
];

function PhoneAlertsTab() {
  const qc = useQueryClient();
  const channels = useQuery({
    queryKey: ['notifications', 'channels'],
    queryFn: api.notifications.channels,
    // Poll quickly while a Telegram link code is outstanding, so the page flips to "linked" by itself.
    refetchInterval: (q) => (q.state.data?.prefs.telegram.pendingCode ? 4_000 : false),
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['notifications', 'channels'] });

  if (channels.isLoading) return <Skeleton className="h-64" />;
  if (!channels.data) return <Alert variant="error">Could not load your phone alert settings.</Alert>;
  return <PhoneAlertsForm status={channels.data.status} prefs={channels.data.prefs} onChanged={invalidate} />;
}

function PhoneAlertsForm({ status, prefs, onChanged }: {
  status: ChannelStatusDto;
  prefs: ChannelPrefsDto;
  onChanged: () => void;
}) {
  const [phone, setPhone] = useState(prefs.phone ?? '');
  const [telegramOn, setTelegramOn] = useState(prefs.telegram.enabled);
  const [whatsappOn, setWhatsappOn] = useState(prefs.whatsapp.enabled);
  const [smsOn, setSmsOn] = useState(prefs.sms.enabled);
  const [callmebotOn, setCallmebotOn] = useState(prefs.callmebot.enabled);
  const [callmebotKey, setCallmebotKey] = useState('');
  const [kinds, setKinds] = useState<NotificationKind[]>(prefs.kinds);
  const [minSeverity, setMinSeverity] = useState(prefs.minSeverity);
  const [testResult, setTestResult] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.notifications.saveChannels({
      telegramEnabled: telegramOn, whatsappEnabled: whatsappOn, smsEnabled: smsOn,
      phone: phone.trim() ? phone.trim() : null, kinds, minSeverity,
      callmebotEnabled: callmebotOn, ...(callmebotKey.trim() ? { callmebotApiKey: callmebotKey.trim() } : {}),
    }),
    onSuccess: onChanged,
  });
  const link = useMutation({ mutationFn: api.notifications.telegramLink, onSuccess: onChanged });
  const unlink = useMutation({ mutationFn: () => api.notifications.saveChannels({ unlinkTelegram: true }), onSuccess: onChanged });
  const test = useMutation({
    mutationFn: (c: 'telegram' | 'whatsapp' | 'sms' | 'callmebot') => api.notifications.testChannel(c),
    onSuccess: (r) => setTestResult(r.detail),
    onError: (e) => setTestResult(e instanceof Error ? e.message : 'send failed'),
  });

  const toggleKind = (k: NotificationKind) =>
    setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  const tg = prefs.telegram;
  const pending = link.data && tg.pendingCode ? link.data : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><MessageCircle className="h-4 w-4" aria-hidden /> Telegram</CardTitle>
          <CardDescription>Free and instant. Every trade pick, fill, exit and alert arrives as a message.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!status.telegram.configured ? (
            <Alert variant="warning" title="Not set up on this server yet">
              Create a bot in Telegram by messaging @BotFather, send it /newbot, copy the token it gives you into
              TELEGRAM_BOT_TOKEN in the server's .env file, and restart. This page then shows a Connect button.
            </Alert>
          ) : tg.linked ? (
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="up">Linked</Badge>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={telegramOn} onChange={(e) => setTelegramOn(e.target.checked)} /> Send alerts to Telegram
              </label>
              <Button variant="outline" className="h-8 text-xs" onClick={() => test.mutate('telegram')} disabled={test.isPending}>
                <Send className="h-3 w-3" aria-hidden /> Send a test
              </Button>
              <Button variant="ghost" className="h-8 text-xs" onClick={() => unlink.mutate()} disabled={unlink.isPending}>Unlink</Button>
            </div>
          ) : tg.pendingCode ? (
            <div className="space-y-2 rounded border border-border bg-muted/30 p-3">
              <p className="text-sm">
                Open Telegram and send this code to <span className="font-mono font-medium">@{status.telegram.botUsername ?? 'the bot'}</span>:
              </p>
              <div className="font-mono text-2xl font-semibold tracking-widest">{tg.pendingCode}</div>
              {(pending?.deepLink ?? (status.telegram.botUsername ? `https://t.me/${status.telegram.botUsername}?start=${tg.pendingCode}` : null)) && (
                <a
                  href={pending?.deepLink ?? `https://t.me/${status.telegram.botUsername}?start=${tg.pendingCode}`}
                  target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  Or tap here on your phone to open the bot with the code filled in <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              )}
              <p className="text-2xs text-muted-foreground">
                This page checks every few seconds and switches to Linked once the bot has received the code. The code expires in 15 minutes.
              </p>
            </div>
          ) : (
            <Button onClick={() => link.mutate()} disabled={link.isPending}>
              {link.isPending ? 'Generating…' : 'Connect Telegram'}
            </Button>
          )}
          {link.isError && <Alert variant="error">{link.error instanceof Error ? link.error.message : 'Could not start the link.'}</Alert>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>WhatsApp and SMS</CardTitle>
          <CardDescription>
            Free WhatsApp through CallMeBot works for your own number with no account. The Twilio options below it are paid, and SMS
            to Indian numbers needs DLT registration of the sender.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="phone">Your mobile number</Label>
              <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+919876543210" inputMode="tel" />
              <p className="text-2xs text-muted-foreground">International form, country code first.</p>
            </div>
            <label className={`flex items-center gap-2 text-sm ${status.whatsapp.configured ? '' : 'text-muted-foreground'}`}>
              <input type="checkbox" checked={whatsappOn} onChange={(e) => setWhatsappOn(e.target.checked)} disabled={!status.whatsapp.configured} />
              WhatsApp {status.whatsapp.configured ? '' : '(not set up on this server)'}
            </label>
            <label className={`flex items-center gap-2 text-sm ${status.sms.configured ? '' : 'text-muted-foreground'}`}>
              <input type="checkbox" checked={smsOn} onChange={(e) => setSmsOn(e.target.checked)} disabled={!status.sms.configured} />
              SMS {status.sms.configured ? '' : '(not set up on this server)'}
            </label>
          </div>
          <div className="space-y-2 rounded border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Free WhatsApp via CallMeBot</span>
              <Badge variant={prefs.callmebot.configured ? 'up' : 'outline'}>{prefs.callmebot.configured ? 'Key saved' : 'Not activated'}</Badge>
            </div>
            <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
              <li>Save your WhatsApp number above in international form.</li>
              <li>In WhatsApp, add <span className="font-mono">{status.callmebot.activationNumber}</span> as a contact and send it the message: <span className="font-mono">I allow callmebot to send me messages</span></li>
              <li>It replies with an API key. Paste it here and save.</li>
            </ol>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="cmb-key">CallMeBot API key</Label>
                <Input id="cmb-key" value={callmebotKey} onChange={(e) => setCallmebotKey(e.target.value)} placeholder={prefs.callmebot.configured ? 'saved — paste to replace' : 'e.g. 1234567'} className="w-48" />
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input type="checkbox" checked={callmebotOn} onChange={(e) => setCallmebotOn(e.target.checked)} /> Send alerts here
              </label>
              <Button variant="outline" className="mb-1 h-8 text-xs" onClick={() => test.mutate('callmebot')} disabled={test.isPending || !prefs.callmebot.configured || !prefs.phone}>Test WhatsApp (free)</Button>
            </div>
            <p className="text-2xs text-muted-foreground">
              CallMeBot is a free third-party relay for personal use, not an official WhatsApp service: delivery is usually within seconds
              but is not guaranteed by anyone, and it can only message the number that activated it. Keep Telegram on as the reliable channel.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {status.whatsapp.configured && <Button variant="outline" className="h-8 text-xs" onClick={() => test.mutate('whatsapp')} disabled={test.isPending || !prefs.phone}>Test WhatsApp</Button>}
            {status.sms.configured && <Button variant="outline" className="h-8 text-xs" onClick={() => test.mutate('sms')} disabled={test.isPending || !prefs.phone}>Test SMS</Button>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What to send</CardTitle>
          <CardDescription>Everything still appears in the bell in the header. This decides which of those also go to your phone.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {KIND_OPTIONS.map((o) => (
              <label key={o.kind} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={kinds.includes(o.kind)} onChange={() => toggleKind(o.kind)} /> {o.label}
              </label>
            ))}
          </div>
          <div className="max-w-xs space-y-1">
            <Label htmlFor="min-sev">Only send when it is at least</Label>
            <Select id="min-sev" value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as 'info' | 'action' | 'warning')}>
              <option value="info">Anything, including information</option>
              <option value="action">Something to act on (trade picks, fills, exits)</option>
              <option value="warning">Warnings only (stops hit, halts, rejections)</option>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>Save phone alerts</Button>
            {save.isSuccess && <span className="text-sm text-muted-foreground">Saved.</span>}
            {save.isError && <span className="text-sm text-destructive">{save.error instanceof Error ? save.error.message : 'Could not save.'}</span>}
            {testResult && <span className="text-sm text-muted-foreground">{testResult}</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

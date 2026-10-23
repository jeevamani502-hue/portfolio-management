/**
 * Admin — every account on this server, what each is doing, and the levers
 * an administrator has: enable or disable, promote, reset a password, sign
 * out everywhere, delete; plus the server-wide switches and the audit trail.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, UserX, KeyRound, LogOut, Trash2, RefreshCw } from 'lucide-react';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Alert, Button, Input, Label, Select, Tabs, EmptyState,
} from '@/components/ui';
import { Metric } from '@/components/market/DataValue';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAuth } from '@/store/auth';
import type { AdminUserDto, AdminUserDetailDto } from '@/types/api';

const inr = (n: number | null | undefined, dp = 0) =>
  n === null || n === undefined ? '—' : `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: dp })}`;
const pnlClass = (n: number) => (n > 0 ? 'text-bull' : n < 0 ? 'text-bear' : '');

export function Admin() {
  const [tab, setTab] = useState('users');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="h-5 w-5" aria-hidden /> Administration</h1>
        <p className="text-sm text-muted-foreground">Every account on this server. Changes here are recorded in the audit trail with your name.</p>
      </div>
      <OverviewStrip />
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'users', label: 'Users' }, { id: 'settings', label: 'Server settings' }, { id: 'audit', label: 'Audit trail' }]} />
      {tab === 'users' && <UsersTab />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

function OverviewStrip() {
  const q = useQuery({ queryKey: ['admin', 'overview'], queryFn: api.admin.overview, refetchInterval: 30_000 });
  if (q.isLoading) return <Skeleton className="h-20" />;
  const o = q.data;
  if (!o) return null;
  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-4 lg:grid-cols-8">
        <Metric label="Accounts" value={o.users.total} sub={`${o.users.active} active · ${o.users.admins} admin`} />
        <Metric label="With a broker" value={o.users.withBroker} />
        <Metric label="Paper trading on" value={o.trading.paperEnabled} sub={`${o.trading.openPaper} open`} />
        <Metric label="Live armed" value={o.trading.liveArmed} sub={`${o.trading.openLive} open`} />
        <Metric label="Paper P&L today" value={inr(o.trading.paperNetToday)} className={pnlClass(o.trading.paperNetToday)} />
        <Metric label="Live P&L today" value={inr(o.trading.liveNetToday)} className={pnlClass(o.trading.liveNetToday)} />
        <Metric label="Sign-up" value={o.registrationOpen ? 'Open' : 'Closed'} sub={`set by ${o.registrationSource === 'admin' ? 'admin' : '.env'}`} />
        <Metric label="Shared feed account" value={o.backgroundJobsUser ? o.backgroundJobsUser.split('@')[0]! : 'auto'} />
      </CardContent>
    </Card>
  );
}

// ── users ───────────────────────────────────────────────────────────────────

function UsersTab() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: api.admin.users, refetchInterval: 30_000 });
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin'] });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { role?: AdminUserDto['role']; isActive?: boolean } }) => api.admin.updateUser(id, body),
    onSuccess: () => { invalidate(); setNotice('Saved.'); },
    onError: (e) => setNotice(e instanceof Error ? e.message : 'Failed.'),
  });
  const logoutAll = useMutation({
    mutationFn: (id: string) => api.admin.logoutAll(id),
    onSuccess: (r) => { invalidate(); setNotice(`${r.revoked} session(s) signed out.`); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.admin.deleteUser(id),
    onSuccess: () => { invalidate(); setSelected(null); setNotice('Account deleted.'); },
    onError: (e) => setNotice(e instanceof Error ? e.message : 'Failed.'),
  });

  if (users.isLoading) return <Skeleton className="h-64" />;
  const rows = users.data ?? [];

  return (
    <div className="space-y-4">
      {notice && <Alert variant="default">{notice}</Alert>}
      <Card>
        <CardContent className="px-0 pt-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">Account</th>
                  <th className="px-4 py-2 text-left font-medium">Role</th>
                  <th className="px-4 py-2 text-left font-medium">Broker</th>
                  <th className="px-4 py-2 text-left font-medium">Paper</th>
                  <th className="px-4 py-2 text-left font-medium">Live</th>
                  <th className="px-4 py-2 text-left font-medium">Reach</th>
                  <th className="px-4 py-2 text-left font-medium">Last sign-in</th>
                  <th className="px-4 py-2 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id} className={cn('border-b border-border/50 last:border-0', !u.isActive && 'opacity-60', selected === u.id && 'bg-muted/40')}>
                    <td className="px-4 py-2">
                      <button type="button" className="text-left hover:underline" onClick={() => setSelected(selected === u.id ? null : u.id)}>
                        <div className="font-medium">{u.email}{u.id === me?.id && <span className="ml-1 text-2xs text-muted-foreground">(you)</span>}</div>
                        <div className="text-2xs text-muted-foreground">{u.fullName ?? '—'} · joined {new Date(u.createdAt).toLocaleDateString('en-IN')}</div>
                      </button>
                    </td>
                    <td className="px-4 py-2"><Badge variant={u.role === 'admin' ? 'warning' : 'outline'}>{u.role}</Badge>{!u.isActive && <Badge variant="muted" className="ml-1">disabled</Badge>}</td>
                    <td className="px-4 py-2 text-xs">{u.providers.length === 0 ? <span className="text-muted-foreground">none</span> : u.providers.map((p) => <div key={p.provider}>{p.provider} <span className={p.health === 'healthy' ? 'text-bull' : 'text-muted-foreground'}>{p.enabled ? p.health ?? '' : 'off'}</span></div>)}</td>
                    <td className="px-4 py-2 text-xs">{u.paper ? <>{u.paper.enabled ? 'on' : 'off'} · {u.paper.openPositions} open · today <span className={pnlClass(u.paper.netToday)}>{inr(u.paper.netToday)}</span></> : <span className="text-muted-foreground">not set up</span>}</td>
                    <td className="px-4 py-2 text-xs">{u.live ? <>{u.live.mode}{u.live.armed ? ' · armed' : ''} · {u.live.openPositions} open · today <span className={pnlClass(u.live.netToday)}>{inr(u.live.netToday)}</span></> : <span className="text-muted-foreground">not set up</span>}</td>
                    <td className="px-4 py-2 text-xs">{u.telegramLinked ? 'Telegram' : ''}{u.telegramLinked && u.phone ? ' · ' : ''}{u.phone ?? ''}{!u.telegramLinked && !u.phone && <span className="text-muted-foreground">email only</span>}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{u.lastLoginAt ? relativeTime(u.lastLoginAt) : 'never'}</td>
                    <td className="px-4 py-2 text-right"><Button variant="ghost" className="h-7 text-xs" onClick={() => setSelected(selected === u.id ? null : u.id)}>{selected === u.id ? 'Close' : 'Manage'}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {selected && (
        <UserPanel
          id={selected}
          isSelf={selected === me?.id}
          onRole={(role) => update.mutate({ id: selected, body: { role } })}
          onActive={(isActive) => update.mutate({ id: selected, body: { isActive } })}
          onLogoutAll={() => logoutAll.mutate(selected)}
          onDelete={() => del.mutate(selected)}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}

function UserPanel({ id, isSelf, onRole, onActive, onLogoutAll, onDelete, onNotice }: {
  id: string; isSelf: boolean;
  onRole: (r: AdminUserDto['role']) => void; onActive: (a: boolean) => void; onLogoutAll: () => void; onDelete: () => void;
  onNotice: (s: string) => void;
}) {
  const d = useQuery({ queryKey: ['admin', 'user', id], queryFn: () => api.admin.user(id) });
  const [newPassword, setNewPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState('');
  const [via, setVia] = useState<'auto' | 'email' | 'telegram' | 'sms'>('auto');
  const setPw = useMutation({
    mutationFn: () => api.admin.setPassword(id, newPassword),
    onSuccess: (r) => { setNewPassword(''); onNotice(r.message); },
    onError: (e) => onNotice(e instanceof Error ? e.message : 'Failed.'),
  });
  const sendReset = useMutation({
    mutationFn: () => api.admin.sendReset(id, via === 'auto' ? undefined : via),
    onSuccess: (r) => onNotice(r.message + (r.link ? ` Link (development only): ${r.link}` : '')),
    onError: (e) => onNotice(e instanceof Error ? e.message : 'Failed.'),
  });

  if (d.isLoading) return <Skeleton className="h-64" />;
  const x: AdminUserDetailDto | undefined = d.data;
  if (!x) return <Alert variant="error">Could not load this account.</Alert>;
  const u = x.user;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{u.email}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric label="Role" value={u.role} />
            <Metric label="Status" value={u.isActive ? 'Active' : 'Disabled'} />
            <Metric label="Active sessions" value={x.sessions} />
            <Metric label="Portfolio holdings" value={x.portfolio.holdings} sub={x.portfolio.marketValue !== null ? `worth ${inr(x.portfolio.marketValue)}` : 'no valuation yet'} />
            <Metric label="Notifications" value={x.notifications.total} sub={`${x.notifications.unread} unread`} />
            <Metric label="Reach" value={[u.telegramLinked ? 'Telegram' : null, u.phone ? 'SMS' : null, 'email'].filter(Boolean).join(', ')} />
          </div>

          <div className="space-y-2 rounded border border-border p-3">
            <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Account</div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="role">Role</Label>
                <Select id="role" value={u.role} onChange={(e) => onRole(e.target.value as AdminUserDto['role'])} disabled={isSelf} className="w-36">
                  <option value="user">user</option><option value="analyst">analyst</option><option value="admin">admin</option>
                </Select>
              </div>
              <Button variant="outline" className="h-8 text-xs" onClick={() => onActive(!u.isActive)} disabled={isSelf}>
                <UserX className="h-3.5 w-3.5" aria-hidden /> {u.isActive ? 'Disable account' : 'Enable account'}
              </Button>
              <Button variant="outline" className="h-8 text-xs" onClick={onLogoutAll}><LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out everywhere</Button>
            </div>
          </div>

          <div className="space-y-2 rounded border border-border p-3">
            <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Password</div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="newpw">Set a new password</Label>
                <Input id="newpw" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="10+ chars, Aa1" className="w-52" autoComplete="new-password" />
              </div>
              <Button className="h-8 text-xs" onClick={() => setPw.mutate()} disabled={newPassword.length < 10 || setPw.isPending}><KeyRound className="h-3.5 w-3.5" aria-hidden /> Set password</Button>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="via">Or send a reset link by</Label>
                <Select id="via" value={via} onChange={(e) => setVia(e.target.value as typeof via)} className="w-40">
                  <option value="auto">best available</option><option value="email">email</option><option value="telegram">Telegram</option><option value="sms">SMS</option>
                </Select>
              </div>
              <Button variant="outline" className="h-8 text-xs" onClick={() => sendReset.mutate()} disabled={sendReset.isPending}>Send reset link</Button>
            </div>
            <p className="text-2xs text-muted-foreground">Either way the user is signed out everywhere. The link works once and expires in 30 minutes.</p>
          </div>

          {!isSelf && (
            <div className="space-y-2 rounded border border-destructive/40 p-3">
              <div className="text-2xs font-medium uppercase tracking-wide text-destructive">Delete account</div>
              <p className="text-2xs text-muted-foreground">Removes the account, its broker credentials, trades, portfolio and alerts. Cannot be undone. Type the email to confirm.</p>
              <div className="flex flex-wrap items-center gap-3">
                <Input value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} placeholder={u.email} className="w-64" />
                <Button variant="destructive" className="h-8 text-xs" onClick={onDelete} disabled={confirmDelete !== u.email}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Trading and activity</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Paper, all time" value={inr(u.paper?.netAll ?? 0)} className={pnlClass(u.paper?.netAll ?? 0)} sub={x.paperPerformance ? `${x.paperPerformance.closedTrades} closed · ${x.paperPerformance.winRate === null ? '—' : x.paperPerformance.winRate.toFixed(0) + '% won'}` : 'not set up'} />
            <Metric label="Paper today" value={inr(u.paper?.netToday ?? 0)} className={pnlClass(u.paper?.netToday ?? 0)} sub={`${u.paper?.tradesToday ?? 0} trade(s)`} />
            <Metric label="Live, all time" value={inr(u.live?.netAll ?? 0)} className={pnlClass(u.live?.netAll ?? 0)} sub={x.livePerformance ? `${x.livePerformance.closed} closed` : 'not set up'} />
            <Metric label="Live today" value={inr(u.live?.netToday ?? 0)} className={pnlClass(u.live?.netToday ?? 0)} />
          </div>
          <TradeList title="Recent paper trades" rows={x.paperTrades.map((t) => ({ id: t.id, symbol: t.tradingsymbol, status: t.status, when: t.exit_at ?? t.entry_at, net: t.net_pnl === null ? null : Number(t.net_pnl), reason: t.exit_reason }))} />
          <TradeList title="Recent live trades" rows={x.liveTrades.map((t) => ({ id: t.id, symbol: t.tradingsymbol, status: t.status, when: t.closed_at ?? t.created_at, net: t.net_pnl === null ? null : Number(t.net_pnl), reason: t.exit_code }))} />
          <div>
            <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Recent audit entries</div>
            {x.audit.length === 0 ? <p className="text-xs text-muted-foreground">Nothing recorded.</p> : (
              <ul className="space-y-0.5 text-xs">
                {x.audit.map((a, i) => <li key={i}><span className="font-mono">{a.action}</span> <span className="text-muted-foreground">{a.resource ?? ''} · {a.ip ?? ''} · {relativeTime(a.at)}</span></li>)}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TradeList({ title, rows }: { title: string; rows: Array<{ id: string; symbol: string; status: string; when: string; net: number | null; reason: string | null }> }) {
  return (
    <div>
      <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">None.</p> : (
        <table className="w-full text-xs">
          <tbody>
            {rows.slice(0, 10).map((r) => (
              <tr key={r.id} className="border-b border-border/40 last:border-0">
                <td className="py-1 font-mono">{r.symbol}</td>
                <td className="py-1">{r.status.toLowerCase()}{r.reason ? ` · ${r.reason.toLowerCase().replace(/_/g, ' ')}` : ''}</td>
                <td className="py-1 text-muted-foreground">{relativeTime(r.when)}</td>
                <td className={cn('py-1 text-right font-mono', r.net === null ? '' : pnlClass(r.net))}>{inr(r.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── settings ────────────────────────────────────────────────────────────────

function SettingsTab() {
  const qc = useQueryClient();
  const o = useQuery({ queryKey: ['admin', 'overview'], queryFn: api.admin.overview });
  const save = useMutation({ mutationFn: (registrationOpen: boolean) => api.admin.saveSettings({ registrationOpen }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin'] }) });
  if (o.isLoading || !o.data) return <Skeleton className="h-40" />;
  const d = o.data;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Sign-up</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">New accounts are currently <strong>{d.registrationOpen ? 'accepted' : 'refused'}</strong>{d.registrationSource === 'env' ? ', from the .env default' : ', set here'}.</p>
          <p className="text-2xs text-muted-foreground">On a public link, close sign-up once the accounts you want exist. You can still create accounts for people by opening it briefly.</p>
          <Button variant={d.registrationOpen ? 'destructive' : 'default'} onClick={() => save.mutate(!d.registrationOpen)} disabled={save.isPending}>
            {d.registrationOpen ? 'Close sign-up' : 'Open sign-up'}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Message channels on this server</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Telegram bot" ok={d.channels.telegram.configured} detail={d.channels.telegram.botUsername ? `@${d.channels.telegram.botUsername}` : 'TELEGRAM_BOT_TOKEN not set'} />
          <Row label="SMS" ok={d.channels.sms.configured} detail={d.channels.sms.configured ? `via ${d.channels.sms.provider ?? 'gateway'}` : 'TEXTBEE_API_KEY (free, your own phone) or Twilio not set'} />
          <Row label="WhatsApp (Twilio)" ok={d.channels.whatsapp.configured} detail={d.channels.whatsapp.configured ? 'ready' : 'not set'} />
          <Row label="WhatsApp (CallMeBot)" ok detail="each user activates their own" />
          <Row label="Shared feed account" ok={!!d.backgroundJobsUser} detail={d.backgroundJobsUser ?? 'automatic (only works with a single credentialled account)'} />
          <p className="text-2xs text-muted-foreground">These are server settings in .env; they are shown here so you can see what password-reset and alert delivery can use.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/40 py-1 last:border-0">
      <span>{label}</span>
      <span className="flex items-center gap-2 text-xs"><Badge variant={ok ? 'up' : 'muted'}>{ok ? 'ready' : 'off'}</Badge><span className="text-muted-foreground">{detail}</span></span>
    </div>
  );
}

// ── audit ───────────────────────────────────────────────────────────────────

function AuditTab() {
  const q = useQuery({ queryKey: ['admin', 'audit'], queryFn: () => api.admin.audit(200), refetchInterval: 30_000 });
  if (q.isLoading) return <Skeleton className="h-64" />;
  const rows = q.data ?? [];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Who did what</CardTitle>
        <Button variant="ghost" className="h-7 text-xs" onClick={() => void q.refetch()}><RefreshCw className="h-3 w-3" aria-hidden /> Refresh</Button>
      </CardHeader>
      <CardContent className="px-0">
        {rows.length === 0 ? <EmptyState title="Nothing recorded yet" description="Money-moving and account-changing actions appear here." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground"><th className="px-4 py-2 text-left font-medium">When</th><th className="px-4 py-2 text-left font-medium">Who</th><th className="px-4 py-2 text-left font-medium">Action</th><th className="px-4 py-2 text-left font-medium">On</th><th className="px-4 py-2 text-left font-medium">From</th></tr></thead>
              <tbody>
                {rows.map((a, i) => (
                  <tr key={i} className="border-b border-border/50 last:border-0">
                    <td className="px-4 py-1.5 text-xs text-muted-foreground">{new Date(a.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                    <td className="px-4 py-1.5 text-xs">{a.email ?? '—'}</td>
                    <td className="px-4 py-1.5 font-mono text-xs">{a.action}</td>
                    <td className="px-4 py-1.5 text-xs text-muted-foreground">{a.resource ?? ''}{a.resourceId ? ` #${a.resourceId}` : ''}</td>
                    <td className="px-4 py-1.5 text-xs text-muted-foreground">{a.ip ?? ''}</td>
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

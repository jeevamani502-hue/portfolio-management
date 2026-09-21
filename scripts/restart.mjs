#!/usr/bin/env node
/**
 * Stop and restart the local dev processes.
 *
 * Exists because `tsx watch` reloads on source changes but not on `.env`:
 * dotenv reads the file once at startup and nothing watches it, so editing a
 * key there looks like it did nothing until the process actually restarts.
 *
 *   node scripts/restart.mjs           # api + worker + web
 *   node scripts/restart.mjs api       # just the API
 *   node scripts/restart.mjs api web   # any combination
 *   node scripts/restart.mjs --stop    # stop everything, start nothing
 *
 * Windows-first, since that is where this project runs; the process lookup
 * falls back to `ps` elsewhere.
 */
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { platform } from 'node:os';

// PostgreSQL here is a standalone cluster started by hand, not a Windows
// service, so it does not come back after a reboot. Treating it as a target
// means one command brings the whole stack up.
const PG_BIN = process.env.PG_BIN ?? 'C:/Program Files/PostgreSQL/17/bin';
const PG_DATA = process.env.PG_DATA ?? `${process.env.TEMP ?? '/tmp'}/bt-pgdata`;
const PG_PORT = Number(process.env.PG_PORT ?? 5433);

const TARGETS = {
  api: { match: 'src/index.ts', label: 'API', args: ['run', 'dev', '-w', 'backend'], port: 4000 },
  worker: { match: 'src/workers', label: 'worker', args: ['run', 'dev:worker', '-w', 'backend'], port: null },
  web: { match: 'vite', label: 'web', args: ['run', 'dev', '-w', 'frontend'], port: 5173 },
};

const argv = process.argv.slice(2);
const stopOnly = argv.includes('--stop');
const named = argv.filter((a) => !a.startsWith('--'));
const selected = named.length > 0 ? named : Object.keys(TARGETS);

for (const name of selected) {
  if (!TARGETS[name]) {
    console.error(`Unknown target "${name}". Choose from: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }
}

const isWindows = platform() === 'win32';

/** Whether something is listening on a TCP port. */
async function portOpen(port) {
  const { createConnection } = await import('node:net');
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(1500);
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

/** Start the database cluster if it is not already accepting connections. */
async function ensurePostgres() {
  if (await portOpen(PG_PORT)) {
    console.log(`database: already up on :${PG_PORT}`);
    return true;
  }
  console.log(`database: not running, starting cluster at ${PG_DATA}`);
  try {
    execFileSync(join(PG_BIN, 'pg_ctl.exe'), [
      'start', '-D', PG_DATA, '-o', `-p ${PG_PORT} -c listen_addresses=127.0.0.1`, '-w', '-t', '30',
    ], { stdio: 'ignore' });
  } catch {
    // pg_ctl exits non-zero on some already-running states; the probe decides.
  }
  for (let i = 0; i < 20; i += 1) {
    if (await portOpen(PG_PORT)) { console.log(`database: ready on :${PG_PORT}`); return true; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`database: FAILED to start on :${PG_PORT} — check ${PG_DATA}`);
  return false;
}
// fileURLToPath, not URL.pathname: the latter keeps %20 for the space in this
// repo's own path, and spawn then fails with ENOENT on a directory that looks
// correct in the error message.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** PIDs whose command line contains `needle`. */
function findPids(needle) {
  try {
    if (isWindows) {
      const ps = [
        '-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*${needle}*' } | ` +
        `ForEach-Object { $_.ProcessId }`,
      ];
      const out = execFileSync('powershell', ps, { encoding: 'utf8' });
      return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
    const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter((l) => l.includes(needle) && !l.includes('restart.mjs'))
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

function kill(pid) {
  try {
    if (isWindows) execFileSync('taskkill', ['/PID', pid, '/F', '/T'], { stdio: 'ignore' });
    else process.kill(Number(pid), 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

// ── stop ────────────────────────────────────────────────────────────────────
for (const name of selected) {
  const { match, label } = TARGETS[name];
  const pids = findPids(match);
  if (pids.length === 0) {
    console.log(`${label}: not running`);
    continue;
  }
  const killed = pids.filter(kill);
  console.log(`${label}: stopped ${killed.length} process(es) [${killed.join(', ')}]`);
}

if (stopOnly) {
  console.log('\nStopped. Nothing restarted (--stop).');
  process.exit(0);
}

// ── start ───────────────────────────────────────────────────────────────────
// The database must be up before the API, or it starts and immediately fails
// its first query.
if (selected.includes('api') || selected.includes('worker')) {
  const ok = await ensurePostgres();
  if (!ok) {
    console.error('');
    console.error('Not starting the API: the database is unavailable.');
    process.exit(1);
  }
}
// Detached so these outlive this script; output goes to the terminal that
// started it, which is what you want when reading startup errors.
console.log('');
for (const name of selected) {
  const { label, args } = TARGETS[name];
  const child = spawn(isWindows ? 'npm.cmd' : 'npm', args, {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    shell: isWindows,
  });
  child.unref();
  console.log(`${label}: starting (pid ${child.pid})`);
}

// Report readiness rather than claiming it.
const withPorts = selected.map((n) => TARGETS[n]).filter((t) => t.port);
if (withPorts.length === 0) process.exit(0);

console.log('\nWaiting for ports…');
const deadline = Date.now() + 60_000;
const pending = new Set(withPorts);

const probe = async (t) => {
  const path = t.port === 4000 ? '/health' : '/';
  try {
    const res = await fetch(`http://localhost:${t.port}${path}`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

while (pending.size > 0 && Date.now() < deadline) {
  for (const t of [...pending]) {
    if (await probe(t)) {
      console.log(`  ${t.label}: ready on :${t.port}`);
      pending.delete(t);
    }
  }
  if (pending.size > 0) await new Promise((r) => setTimeout(r, 1500));
}

for (const t of pending) {
  console.log(`  ${t.label}: NOT responding on :${t.port} after 60s — check the logs`);
}
process.exit(pending.size === 0 ? 0 : 1);

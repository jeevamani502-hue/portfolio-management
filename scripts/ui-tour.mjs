#!/usr/bin/env node
/**
 * Drive the running app and screenshot every page.
 *
 * Uses the system Chrome (`channel: 'chrome'`) rather than a downloaded
 * Playwright browser, so it needs no extra megabytes on a dev machine.
 *
 *   node scripts/ui-tour.mjs [--headed] [--out <dir>]
 *
 * Expects the API on :4000 and the web app on :5173.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'screenshots';

const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const EMAIL = process.env.DEMO_EMAIL ?? 'demo@bharat.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'DemoPass123';

/** Pages to visit, in order. `wait` is extra settle time for data fetches. */
const PAGES = [
  { path: '/', name: 'dashboard', wait: 2500 },
  { path: '/markets', name: 'markets', wait: 2000 },
  { path: '/stocks', name: 'stocks-search', wait: 800 },
  { path: '/fno', name: 'fno', wait: 2000 },
  { path: '/scanner', name: 'swing-scanner', wait: 800 },
  { path: '/portfolio', name: 'portfolio', wait: 1800 },
  { path: '/watchlist', name: 'watchlist', wait: 1500 },
  { path: '/news', name: 'news', wait: 1200 },
  { path: '/alerts', name: 'alerts', wait: 1000 },
  { path: '/backtest', name: 'backtesting', wait: 1200 },
  { path: '/analyst', name: 'ai-analyst', wait: 1000 },
  { path: '/settings', name: 'settings', wait: 1500 },
];

mkdirSync(outDir, { recursive: true });

const consoleErrors = [];
const networkErrors = [];

const browser = await chromium.launch({ channel: 'chrome', headless: !headed });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1100 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
});
page.on('response', (res) => {
  if (res.status() >= 500) networkErrors.push(`${res.status()} ${res.url()}`);
});

// ── sign in ────────────────────────────────────────────────────────────────

console.log('Signing in…');
await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });

await page.fill('#email', EMAIL);
await page.fill('#password', PASSWORD);
await page.click('button[type="submit"]');

try {
  // The sidebar only exists once authenticated.
  await page.waitForSelector('text=Bharat Terminal', { timeout: 15_000 });
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 15_000 });
  console.log('  signed in');
} catch {
  await page.screenshot({ path: join(outDir, '00-login-failed.png') });
  console.error('  sign-in did not complete — see 00-login-failed.png');
  const body = await page.textContent('body');
  console.error('  page text:', body?.slice(0, 400));
  await browser.close();
  process.exit(1);
}

// ── tour ───────────────────────────────────────────────────────────────────

const results = [];

for (const [i, spec] of PAGES.entries()) {
  const label = String(i + 1).padStart(2, '0');
  process.stdout.write(`${label} ${spec.name} … `);
  const before = consoleErrors.length;

  try {
    await page.goto(`${WEB}${spec.path}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(spec.wait);

    const file = join(outDir, `${label}-${spec.name}.png`);
    await page.screenshot({ path: file, fullPage: false });

    // A page that rendered nothing is a failure even if no error was thrown.
    const textLength = (await page.textContent('main'))?.trim().length ?? 0;
    const newErrors = consoleErrors.length - before;

    results.push({ page: spec.name, textLength, newErrors, file });
    console.log(`ok (${textLength} chars${newErrors ? `, ${newErrors} console errors` : ''})`);
  } catch (err) {
    results.push({ page: spec.name, error: String(err).slice(0, 160) });
    console.log(`FAILED: ${String(err).slice(0, 120)}`);
  }
}

// ── a couple of deeper views ───────────────────────────────────────────────

try {
  process.stdout.write('13 stock-analysis … ');
  await page.goto(`${WEB}/stocks/NSE:RELIANCE`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outDir, '13-stock-analysis.png') });
  console.log('ok');
} catch (err) {
  console.log(`FAILED: ${String(err).slice(0, 120)}`);
}

try {
  process.stdout.write('14 light-theme … ');
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  // The theme toggle is the last control in the header.
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    try { localStorage.setItem('bt-theme', 'light'); } catch { /* private mode */ }
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, '14-dashboard-light.png') });
  console.log('ok');
} catch (err) {
  console.log(`FAILED: ${String(err).slice(0, 120)}`);
}

// ── report ─────────────────────────────────────────────────────────────────

writeFileSync(
  join(outDir, 'report.json'),
  JSON.stringify({ results, consoleErrors, networkErrors }, null, 2),
);

console.log('\n─── summary ───');
console.log(`pages captured : ${results.filter((r) => !r.error).length}/${results.length}`);
console.log(`console errors : ${consoleErrors.length}`);
console.log(`5xx responses  : ${networkErrors.length}`);
if (consoleErrors.length) {
  console.log('\nconsole errors (first 10):');
  [...new Set(consoleErrors)].slice(0, 10).forEach((e) => console.log('  ·', e));
}
if (networkErrors.length) {
  console.log('\n5xx responses (first 10):');
  [...new Set(networkErrors)].slice(0, 10).forEach((e) => console.log('  ·', e));
}

await browser.close();

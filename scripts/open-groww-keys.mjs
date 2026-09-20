/**
 * Opens the Groww API-keys page in a real browser window for you to use.
 *
 * Deliberately does NOT log in or read anything off the page: that would mean
 * handling brokerage account credentials and scraping an authenticated
 * session, neither of which this project should do. You sign in yourself; the
 * window stays open until you close it.
 */
import { chromium } from 'playwright';

const ctx = await chromium.launchPersistentContext(
  process.env.TEMP + '/bt-groww-profile',
  { channel: 'chrome', headless: false, viewport: null, args: ['--start-maximized'] },
);
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://groww.in/trade-api/api-keys', { waitUntil: 'domcontentloaded' });
console.log('Browser opened at the Groww API keys page. Sign in there if prompted.');
console.log('Close the window when done — this script exits with it.');
await ctx.waitForEvent('close', { timeout: 0 }).catch(() => {});

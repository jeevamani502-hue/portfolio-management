/**
 * Opens Oracle Cloud Free Tier Account Signup in a visible Chromium browser.
 *
 * Keeps the browser open and active so you can safely enter your
 * details, verify your email, and complete card verification.
 */

import { chromium } from 'playwright';
import * as path from 'path';

console.log('==================================================================');
console.log('  Oracle Cloud Free Tier Account Creation (Visible Browser)');
console.log('==================================================================');

const PROFILE_DIR = path.join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'oracle-cloud-signup-profile');

let browserContext;
try {
  browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });
} catch (err) {
  // Fallback to standard launch if channel chrome fails
  console.log('Launching default Chromium...');
  browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
}

const page = browserContext.pages()[0] ?? (await browserContext.newPage());

const TARGET_URL = 'https://signup.cloud.oracle.com/';

console.log(`\n🌐 Opening Oracle Free Tier Signup:\n${TARGET_URL}\n`);
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

console.log('------------------------------------------------------------------');
console.log('📋 STEP-BY-STEP SIGNUP GUIDE:');
console.log('1. Select Country/Territory (e.g. India) and enter Name & Email.');
console.log('2. Click "Verify my email" and click the link in your inbox.');
console.log('3. Fill in Account Details:');
console.log('   - Password: Create a strong password.');
console.log('   - Cloud Account Name: Give your tenancy a unique name.');
console.log('   - Home Region: Choose India West (Mumbai) [ap-mumbai-1] or India South (Hyderabad).');
console.log('     * IMPORTANT: Home Region cannot be changed after creation!');
console.log('4. Address Information: Enter your address and phone number.');
console.log('5. Payment Method Verification:');
console.log('   - Enter card for identity verification ($0 charge / small temporary test hold).');
console.log('6. Accept terms and submit.');
console.log('------------------------------------------------------------------');
console.log('💡 The browser window will stay open for you to complete signup.');
console.log('   Close the browser window when you are done.\n');

await browserContext.waitForEvent('close', { timeout: 0 }).catch(() => {});

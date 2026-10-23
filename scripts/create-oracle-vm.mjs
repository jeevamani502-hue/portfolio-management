/**
 * Automated Oracle Cloud VM Assistant using Playwright
 *
 * Launches a visible browser to:
 * 1. Navigate to Oracle Cloud Compute Instance creation in your home region.
 * 2. Automatically capture and save SSH keys to your project folder.
 * 3. Assist in configuring Ubuntu + Always Free shape and networking.
 */

import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

const TARGET_URL = 'https://cloud.oracle.com/compute/instances/create';
const PROFILE_DIR = path.join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'oracle-cloud-playwright-profile');
const DOWNLOADS_DIR = process.cwd();

console.log('==================================================================');
console.log('  Oracle Cloud VM Creator Assistant (Playwright)');
console.log('==================================================================');
console.log(`Using Chrome Profile: ${PROFILE_DIR}`);

let context;
try {
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    acceptDownloads: true,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });
} catch (e) {
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    acceptDownloads: true,
    args: ['--start-maximized'],
  });
}

const page = context.pages()[0] ?? (await context.newPage());

// Handle automatic download of SSH keys
page.on('download', async (download) => {
  const suggestedFilename = download.suggestedFilename();
  const targetPath = path.join(DOWNLOADS_DIR, suggestedFilename);
  console.log(`\n📥 Downloading key file: ${suggestedFilename} -> ${targetPath}`);
  await download.saveAs(targetPath);
  console.log(`✅ Saved SSH Key to: ${targetPath}`);
});

console.log(`\n🌐 Opening Oracle Cloud Console:\n${TARGET_URL}\n`);
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

console.log('------------------------------------------------------------------');
console.log('👉 ACTION REQUIRED:');
console.log('1. If prompted, enter your Cloud Account Name (Tenancy) and sign in.');
console.log('2. Once logged in, the VM creation form will load on your screen.');
console.log('------------------------------------------------------------------');

// Wait until user reaches the compute instance creation page
try {
  await page.waitForURL((url) => url.pathname.includes('/compute/instances/create'), {
    timeout: 300000, // 5 minutes
  });
  console.log('\n✅ Successfully landed on Create Instance page!');
} catch (e) {
  console.log('ℹ️ Waiting on current page navigation...');
}

// Helper to safely click
async function safeClick(selector, name) {
  try {
    const el = page.locator(selector).first();
    if (await el.isVisible({ timeout: 3000 })) {
      await el.click();
      console.log(`✔️ Clicked: ${name}`);
      return true;
    }
  } catch {}
  return false;
}

// Monitor and assist form filling
async function assistForm() {
  try {
    // 1. Fill Name if available
    const nameInput = page.locator('input[id*="name" i], input[placeholder*="instance" i], input[aria-label*="name" i]').first();
    if (await nameInput.isVisible({ timeout: 2000 })) {
      const currentVal = await nameInput.inputValue().catch(() => '');
      if (!currentVal || currentVal.startsWith('instance-')) {
        await nameInput.fill('bharat-terminal');
        console.log('✔️ Set Instance Name to: bharat-terminal');
      }
    }
  } catch {}

  console.log('\n==================================================================');
  console.log('📋 VM CONFIGURATION CHECKLIST (In the open browser):');
  console.log('------------------------------------------------------------------');
  console.log('1. Name: bharat-terminal');
  console.log('2. Image: Canonical Ubuntu (22.04 or 24.04)');
  console.log('3. Shape: Ampere VM.Standard.A1.Flex (2 OCPUs, 12 GB RAM) - Always Free');
  console.log('   (or AMD VM.Standard.E2.1.Micro if ARM is out of capacity)');
  console.log('4. Networking: Ensure "Assign a public IPv4 address" is checked');
  console.log('5. SSH Keys: Click "Save private key" (auto-saved to your project folder)');
  console.log('6. Click "Create" button at the bottom!');
  console.log('==================================================================\n');
}

await page.waitForTimeout(4000);
await assistForm();

// Auto trigger private key save if visible
try {
  const saveKeyBtn = page.getByRole('button', { name: /Save private key/i });
  if (await saveKeyBtn.isVisible({ timeout: 2000 })) {
    await saveKeyBtn.click();
  }
} catch {}

console.log('💡 Keep the browser open until you click "Create" and the instance starts provisioning.');
console.log('   Press Ctrl+C here or close the browser window when finished.\n');

await context.waitForEvent('close', { timeout: 0 }).catch(() => {});

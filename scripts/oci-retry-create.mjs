/**
 * Keep asking Oracle Cloud for an Always Free ARM instance until one is granted.
 *
 * "Out of host capacity" means no free Ampere host exists in your region at
 * that moment. Capacity is released as other people delete instances, often
 * at odd hours, so a script that retries every few minutes gets a machine
 * where a person clicking Create does not.
 *
 *   node scripts/oci-retry-create.mjs            # retry every 3 minutes
 *   node scripts/oci-retry-create.mjs --every 2  # every 2 minutes
 *   node scripts/oci-retry-create.mjs --ocpus 1 --memory 6 --name advisha
 *
 * Needs only an API key from the console (Profile → My profile → API keys →
 * Add API key), saved the way Oracle's own snippet describes:
 *   ~/.oci/config           the [DEFAULT] profile with user, fingerprint, tenancy, region, key_file
 *   ~/.oci/oci_api_key.pem  the downloaded private key
 * and a public SSH key, by default ~/.ssh/advisha_oracle.pub.
 *
 * Everything else (availability domain, Ubuntu 24.04 ARM image, a public
 * subnet) is discovered through the API. If the tenancy has no VCN yet, run the
 * console's "Start VCN Wizard → VCN with Internet Connectivity" once first.
 * No OCI CLI is required; requests are signed here with Node's crypto.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash, createSign } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── arguments ───────────────────────────────────────────────────────────────
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const EVERY_MIN = Number(arg('every', '3'));
const OCPUS = Number(arg('ocpus', '1'));
const MEMORY_GB = Number(arg('memory', '6'));
const NAME = arg('name', 'advisha');
const BOOT_GB = Number(arg('boot', '50'));
const SSH_PUB = arg('ssh', join(homedir(), '.ssh', 'advisha_oracle.pub'));
const PROFILE = arg('profile', 'DEFAULT');
const SHAPE = 'VM.Standard.A1.Flex';

// ── config ──────────────────────────────────────────────────────────────────
function loadConfig() {
  const path = join(homedir(), '.oci', 'config');
  if (!existsSync(path)) fail(`No OCI config at ${path}. Add an API key in the console and save its config snippet there.`);
  const text = readFileSync(path, 'utf8');
  const section = text.split(/^\[(.+)\]\s*$/m);
  const idx = section.findIndex((s) => s.trim() === PROFILE);
  if (idx < 0) fail(`Profile [${PROFILE}] not found in ${path}.`);
  const cfg = {};
  for (const line of section[idx + 1].split(/\r?\n/)) {
    const m = line.match(/^\s*([a-z_]+)\s*=\s*(.+?)\s*$/i);
    if (m) cfg[m[1]] = m[2];
  }
  for (const k of ['user', 'fingerprint', 'tenancy', 'region', 'key_file']) {
    if (!cfg[k]) fail(`Missing "${k}" in the [${PROFILE}] profile of ${path}.`);
  }
  const keyPath = cfg.key_file.replace(/^~(?=[\\/])/, homedir());
  if (!existsSync(keyPath)) fail(`Private key not found at ${keyPath} (key_file in ${path}).`);
  return { ...cfg, privateKey: readFileSync(keyPath, 'utf8') };
}

function fail(msg) { console.error(`\n${msg}\n`); process.exit(1); }

// ── request signing (OCI "Signature version 1") ─────────────────────────────
function signedHeaders(cfg, method, url, body) {
  const u = new URL(url);
  const date = new Date().toUTCString();
  const target = `${method.toLowerCase()} ${u.pathname}${u.search}`;
  const headers = { date, host: u.host, '(request-target)': target };
  const names = ['date', '(request-target)', 'host'];
  if (body !== undefined) {
    const sha = createHash('sha256').update(body).digest('base64');
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body));
    headers['x-content-sha256'] = sha;
    names.push('content-length', 'content-type', 'x-content-sha256');
  }
  const signingString = names.map((n) => `${n}: ${headers[n]}`).join('\n');
  const signature = createSign('RSA-SHA256').update(signingString).sign(cfg.privateKey, 'base64');
  const keyId = `${cfg.tenancy}/${cfg.user}/${cfg.fingerprint}`;
  const out = { date, authorization: `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${signature}"` };
  if (body !== undefined) {
    out['content-type'] = 'application/json';
    out['content-length'] = headers['content-length'];
    out['x-content-sha256'] = headers['x-content-sha256'];
  }
  return out;
}

async function oci(cfg, method, url, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers: signedHeaders(cfg, method, url, payload), body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  return { status: res.status, json, text };
}

// ── discovery ───────────────────────────────────────────────────────────────
async function discover(cfg) {
  const core = `https://iaas.${cfg.region}.oraclecloud.com/20160918`;
  const identity = `https://identity.${cfg.region}.oraclecloud.com/20160918`;
  const comp = cfg.tenancy;

  const ads = await oci(cfg, 'GET', `${identity}/availabilityDomains/?compartmentId=${comp}`);
  if (ads.status !== 200) fail(`Could not list availability domains (HTTP ${ads.status}): ${ads.text.slice(0, 300)}\nCheck the API key, fingerprint and region in ~/.oci/config.`);
  const adNames = ads.json.map((a) => a.name);

  const imgs = await oci(cfg, 'GET', `${core}/images?compartmentId=${comp}&operatingSystem=${encodeURIComponent('Canonical Ubuntu')}&shape=${SHAPE}&sortBy=TIMECREATED&sortOrder=DESC&limit=50`);
  if (imgs.status !== 200) fail(`Could not list images (HTTP ${imgs.status}): ${imgs.text.slice(0, 300)}`);
  const image = imgs.json.find((i) => /24\.04/.test(i.operatingSystemVersion ?? '') && /aarch64/i.test(i.displayName))
    ?? imgs.json.find((i) => /aarch64/i.test(i.displayName));
  if (!image) fail('No Ubuntu ARM image found for VM.Standard.A1.Flex in this region.');

  const subnets = await oci(cfg, 'GET', `${core}/subnets?compartmentId=${comp}&limit=50`);
  if (subnets.status !== 200) fail(`Could not list subnets (HTTP ${subnets.status}): ${subnets.text.slice(0, 300)}`);
  const subnet = subnets.json.find((s) => s.lifecycleState === 'AVAILABLE' && s.prohibitPublicIpOnVnic === false)
    ?? subnets.json.find((s) => s.lifecycleState === 'AVAILABLE');
  if (!subnet) fail('No subnet found. In the console run Networking → Virtual cloud networks → Start VCN Wizard → "VCN with Internet Connectivity", then rerun this script.');

  return { core, adNames, image, subnet };
}

// ── the loop ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString('en-IN', { hour12: false });

(async () => {
  const cfg = loadConfig();
  if (!existsSync(SSH_PUB)) fail(`SSH public key not found at ${SSH_PUB}. Pass --ssh <path>.`);
  const sshKey = readFileSync(SSH_PUB, 'utf8').trim();

  console.log(`Region ${cfg.region}, shape ${SHAPE} ${OCPUS} OCPU / ${MEMORY_GB} GB, name "${NAME}", retry every ${EVERY_MIN} min.`);
  const { core, adNames, image, subnet } = await discover(cfg);
  console.log(`Availability domains: ${adNames.join(', ')}`);
  console.log(`Image: ${image.displayName}`);
  console.log(`Subnet: ${subnet.displayName} (${subnet.cidrBlock})`);
  console.log('Leave this window open. Press Ctrl+C to stop.\n');

  let attempt = 0;
  for (;;) {
    for (const ad of adNames) {
      attempt += 1;
      const body = {
        availabilityDomain: ad,
        compartmentId: cfg.tenancy,
        displayName: NAME,
        shape: SHAPE,
        shapeConfig: { ocpus: OCPUS, memoryInGBs: MEMORY_GB },
        sourceDetails: { sourceType: 'image', imageId: image.id, bootVolumeSizeInGBs: BOOT_GB },
        createVnicDetails: { subnetId: subnet.id, assignPublicIp: true },
        metadata: { ssh_authorized_keys: sshKey },
      };
      const r = await oci(cfg, 'POST', `${core}/instances`, body);
      if (r.status === 200) {
        console.log(`\n${stamp()} Instance granted in ${ad}. Waiting for it to start…`);
        await report(cfg, core, r.json.id);
        return;
      }
      const msg = (r.json && r.json.message) || r.text.slice(0, 200);
      if (/out of (host )?capacity/i.test(msg)) {
        console.log(`${stamp()} attempt ${attempt} ${ad}: out of capacity`);
      } else if (r.status === 429) {
        console.log(`${stamp()} attempt ${attempt}: rate limited; waiting longer`);
        await sleep(EVERY_MIN * 60_000);
      } else if (/LimitExceeded/i.test(r.json?.code ?? '') || /limit/i.test(msg)) {
        fail(`${stamp()} Oracle refused on a service limit, not capacity: ${msg}\nAn instance may already exist, or the account is still being provisioned.`);
      } else {
        fail(`${stamp()} Unexpected reply (HTTP ${r.status}): ${msg}`);
      }
    }
    await sleep(EVERY_MIN * 60_000);
  }
})().catch((err) => fail(err instanceof Error ? err.message : String(err)));

async function report(cfg, core, instanceId) {
  for (let i = 0; i < 60; i++) {
    const r = await oci(cfg, 'GET', `${core}/instances/${instanceId}`);
    const state = r.json?.lifecycleState;
    if (state === 'RUNNING') break;
    if (state === 'TERMINATED' || state === 'TERMINATING') fail('The instance was terminated while starting.');
    await sleep(10_000);
  }
  const att = await oci(cfg, 'GET', `${core}/vnicAttachments?compartmentId=${cfg.tenancy}&instanceId=${instanceId}`);
  const vnicId = att.json?.find((a) => a.lifecycleState === 'ATTACHED')?.vnicId ?? att.json?.[0]?.vnicId;
  const vnic = vnicId ? await oci(cfg, 'GET', `${core}/vnics/${vnicId}`) : null;
  const ip = vnic?.json?.publicIp ?? '(not assigned yet — check the console)';
  console.log(`\nInstance ${instanceId} is RUNNING.`);
  console.log(`Public IP: ${ip}`);
  console.log(`\nNext: open ports 80 and 443 in the subnet's security list, point your DuckDNS name at ${ip},`);
  console.log(`then: ssh -i ~/.ssh/advisha_oracle ubuntu@${ip}`);
}

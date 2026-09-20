/**
 * AES-256-GCM envelope encryption for broker/data-provider credentials.
 *
 * Ciphertext layout (base64 of the concatenation):
 *   [ 12-byte IV ][ 16-byte auth tag ][ ciphertext ]
 *
 * The key comes from CREDENTIAL_ENC_KEY and is validated at boot to be exactly
 * 32 bytes. Plaintext credentials exist only inside the provider process and
 * are never serialized into an API response.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) cachedKey = Buffer.from(env.CREDENTIAL_ENC_KEY, 'base64');
  return cachedKey;
}

export function encryptJson(payload: unknown): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptJson<T = Record<string, string>>(encoded: string): T {
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Credential ciphertext is malformed or truncated');
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

/** SHA-256 hex. Used for refresh-token storage and news URL dedupe. */
export const sha256 = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export const randomToken = (bytes = 48): string => randomBytes(bytes).toString('base64url');

/**
 * Mask a secret for display, e.g. "abcd...wxyz". Never reveals enough to be
 * useful; used only in the Settings UI to confirm *that* a key is stored.
 */
export function maskSecret(secret: string | undefined | null): string | null {
  if (!secret) return null;
  if (secret.length <= 8) return '••••••••';
  return `${secret.slice(0, 3)}${'•'.repeat(6)}${secret.slice(-3)}`;
}

/**
 * Cache scoping.
 *
 * This exists because of a real leak found by driving the UI: a freshly
 * created account with no broker credentials at all was served a live NIFTY
 * option chain, sourced `angelone+assembled`, from another user's session.
 * The cache key was global, so the first user's licensed feed answered the
 * second user's request. That is redistribution, and the setting meant to
 * prevent it was never consulted.
 */
import { describe, it, expect } from 'vitest';
import { scopedKey, K } from '../keys.js';

describe('scopedKey', () => {
  const A = 'user-aaa';
  const B = 'user-bbb';

  it('separates two users asking for the same instrument', () => {
    const a = scopedKey(K.quote(123), A, false);
    const b = scopedKey(K.quote(123), B, false);
    expect(a).not.toBe(b);
  });

  it('separates two users asking for the same option chain', () => {
    const a = scopedKey(K.optionChain('NIFTY', '2026-09-22'), A, false);
    const b = scopedKey(K.optionChain('NIFTY', '2026-09-22'), B, false);
    expect(a).not.toBe(b);
  });

  it('is stable for one user, so the cache still works', () => {
    expect(scopedKey(K.quote(123), A, false)).toBe(scopedKey(K.quote(123), A, false));
  });

  it('keeps the underlying key recognisable for debugging', () => {
    expect(scopedKey(K.quote(123), A, false)).toContain(K.quote(123));
  });

  it('shares one key across users when a shared-feed licence is declared', () => {
    // The operator has taken on the licensing obligation, so sharing is the
    // intended behaviour and the cache should actually be shared.
    const a = scopedKey(K.quote(123), A, true);
    const b = scopedKey(K.quote(123), B, true);
    expect(a).toBe(b);
    expect(a).toBe(K.quote(123));
  });

  it('does not scope the environment-credential registry', () => {
    // Background jobs have no user and write shared reference data.
    expect(scopedKey(K.quote(123), null, false)).toBe(K.quote(123));
  });

  it('never lets an unscoped key collide with a scoped one', () => {
    const worker = scopedKey(K.quote(123), null, false);
    const user = scopedKey(K.quote(123), A, false);
    expect(worker).not.toBe(user);
  });

  it('distinguishes different instruments for the same user', () => {
    expect(scopedKey(K.quote(1), A, false)).not.toBe(scopedKey(K.quote(2), A, false));
  });

  it('distinguishes expiries for the same user and underlying', () => {
    const near = scopedKey(K.optionChain('NIFTY', '2026-09-22'), A, false);
    const far = scopedKey(K.optionChain('NIFTY', '2026-09-29'), A, false);
    expect(near).not.toBe(far);
  });
});

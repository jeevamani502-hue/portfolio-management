/**
 * Regression tests for header merging.
 *
 * These exist because of a real failure: the token exchange sent both
 * `content-type` (added by HttpProvider when a body is present) and
 * `Content-Type` (written by the provider), the client put the header on the
 * wire twice, and Groww answered `415 Unsupported Media Type`.
 */
import { describe, it, expect } from 'vitest';
import { mergeHeaders } from '../base/HttpProvider.js';

describe('mergeHeaders', () => {
  it('collapses differently-cased duplicates into one header', () => {
    const merged = mergeHeaders(
      { 'content-type': 'application/json' },
      { 'Content-Type': 'application/json' },
    );
    expect(Object.keys(merged)).toEqual(['content-type']);
  });

  it('lets the later source win', () => {
    const merged = mergeHeaders(
      { 'content-type': 'application/json' },
      { 'Content-Type': 'text/csv' },
    );
    expect(merged['content-type']).toBe('text/csv');
  });

  it('normalises every key to lower case', () => {
    const merged = mergeHeaders({
      Authorization: 'Bearer x',
      'X-API-VERSION': '1.0',
      Accept: 'application/json',
    });
    expect(Object.keys(merged).sort()).toEqual(['accept', 'authorization', 'x-api-version']);
  });

  it('reproduces the exact shape that caused the 415', () => {
    // Defaults HttpProvider adds for a JSON body, then the provider's own
    // headers — the combination that used to emit Content-Type twice.
    const merged = mergeHeaders(
      { accept: 'application/json', 'content-type': 'application/json' },
      {
        Authorization: 'Bearer api-key',
        'Content-Type': 'application/json',
        'X-API-VERSION': '1.0',
      },
    );
    const contentTypeKeys = Object.keys(merged).filter(
      (k) => k.toLowerCase() === 'content-type',
    );
    expect(contentTypeKeys).toHaveLength(1);
    expect(merged['authorization']).toBe('Bearer api-key');
    expect(merged['x-api-version']).toBe('1.0');
  });

  it('skips undefined sources and empty values', () => {
    const merged = mergeHeaders(undefined, { a: '1' }, undefined);
    expect(merged).toEqual({ a: '1' });
  });
});

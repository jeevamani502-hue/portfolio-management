import { logger } from '../../utils/logger.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { recordDataQualityEvent } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';

const log = logger.child({ job: 'instruments-sync' });

/**
 * Pull the instrument master from every configured provider that offers one.
 *
 * Running all of them rather than stopping at the first is deliberate: each
 * provider contributes its own token for the same instrument, and the repo
 * merges `provider_tokens` instead of overwriting. That is what lets the
 * registry fail over between brokers mid-session — the fallback provider
 * already knows how to address the instrument.
 */
export async function syncInstruments(registry: ProviderRegistry): Promise<void> {
  const capable = registry
    .all()
    .filter((p) => p.isConfigured() && p.manifest.capabilities.includes('instruments'));

  if (capable.length === 0) {
    log.warn('No configured provider can supply an instrument master; skipping sync');
    await recordDataQualityEvent({
      kind: 'missing_capability',
      capability: 'instruments',
      detail: { note: 'instrument sync skipped — no configured provider' },
    });
    return;
  }

  for (const provider of capable) {
    const id = provider.manifest.id;
    try {
      const instruments = await provider.getInstruments!();
      if (instruments.length === 0) {
        log.warn({ provider: id }, 'Provider returned an empty instrument list');
        continue;
      }
      const result = await instrumentsRepo.upsertInstruments(instruments, id);
      log.info({ provider: id, count: result.inserted }, 'Instrument master synced');
    } catch (err) {
      log.error({ err, provider: id }, 'Instrument sync failed for this provider');
      await recordDataQualityEvent({
        kind: 'provider_error',
        provider: id,
        capability: 'instruments',
        detail: { message: err instanceof Error ? err.message.slice(0, 300) : 'unknown' },
      });
    }
  }
}

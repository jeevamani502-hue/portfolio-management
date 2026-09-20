import { logger } from '../../utils/logger.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { isAvailable } from '../../utils/sourced.js';
import { getExpiries, getOptionChain } from '../../modules/options/options.service.js';

const log = logger.child({ job: 'option-chain-poller' });

/** Index underlyings worth snapshotting continuously. */
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'] as const;

/**
 * Capture the nearest-expiry chain for each index underlying.
 *
 * Persisting snapshots is what makes IV percentile and OI-shift history
 * possible at all — both need a stored series, and neither can be
 * back-filled from a provider after the fact.
 */
export async function pollOptionChains(registry: ProviderRegistry): Promise<void> {
  for (const underlying of UNDERLYINGS) {
    try {
      const expiries = await getExpiries(registry, underlying);
      if (!isAvailable(expiries) || expiries.value.length === 0) {
        log.debug({ underlying }, 'No expiries listed; skipping');
        continue;
      }

      const expiry = expiries.value[0]!;
      // getOptionChain persists the snapshot as a side effect.
      const chain = await getOptionChain(registry, underlying, expiry);

      if (!isAvailable(chain)) {
        log.debug({ underlying, expiry, reason: chain.reason }, 'Chain unavailable');
        continue;
      }

      log.info(
        { underlying, expiry, strikes: chain.value.strikes.length, source: chain.source },
        'Option chain snapshotted',
      );
    } catch (err) {
      log.warn({ err, underlying }, 'Option chain poll failed');
    }
  }
}

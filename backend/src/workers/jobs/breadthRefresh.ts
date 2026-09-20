import { logger } from '../../utils/logger.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { isAvailable } from '../../utils/sourced.js';
import { getBreadth, getSectorPerformance, getRegime } from '../../modules/market/market.service.js';

const log = logger.child({ job: 'breadth-refresh' });

/**
 * Warms the breadth, sector and regime caches on a schedule.
 *
 * Each of these costs a batched quote call across the whole universe. Doing it
 * once here means a dashboard load is a Redis read rather than 50 provider
 * requests per user — the fan-out principle from the architecture doc applied
 * to derived aggregates as well as to ticks.
 */
export async function refreshBreadth(registry: ProviderRegistry): Promise<void> {
  const [breadth, sectors, regime] = await Promise.all([
    getBreadth(registry, 'NIFTY50'),
    getSectorPerformance(registry, 'NIFTY50'),
    getRegime(registry),
  ]);

  log.info(
    {
      breadth: isAvailable(breadth) ? breadth.value.totalScanned : 'unavailable',
      sectors: isAvailable(sectors) ? sectors.value.length : 'unavailable',
      regime: isAvailable(regime) ? regime.value.regime : 'unavailable',
    },
    'Market aggregates refreshed',
  );
}

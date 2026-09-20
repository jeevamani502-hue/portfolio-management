import { logger } from '../../utils/logger.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { isAvailable } from '../../utils/sourced.js';
import { runScan, persistIdeas } from '../../modules/scanner/scanner.service.js';

const log = logger.child({ job: 'scanner-sweep' });

/**
 * Periodic scan of the index universe, persisting whatever setups qualify so
 * the dashboard and alert engine can reference them without each user paying
 * the cost of a fresh sweep.
 */
export async function sweepScanner(registry: ProviderRegistry): Promise<void> {
  const result = await runScan(registry, {
    timeframe: '1d',
    universe: 'NIFTY50',
    minStrength: 55,
    limit: 40,
    maxSymbols: 200,
  });

  if (!isAvailable(result)) {
    log.warn({ reason: result.reason }, 'Scanner sweep produced no usable data');
    return;
  }

  const saved = await persistIdeas(result.value.ideas);
  log.info(
    { analyzed: result.value.analyzed, found: result.value.ideas.length, saved },
    'Scanner sweep complete',
  );
}

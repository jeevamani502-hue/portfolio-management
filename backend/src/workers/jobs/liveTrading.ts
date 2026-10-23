/**
 * Live trading jobs — thin wrappers; the decisions live in live.service.ts
 * and the pure rules in analysis/options/liveGuards.ts, where they are tested.
 *
 *   live-orders  reconcile pending entries/exits with the broker, then apply
 *                the plan to every open position.
 *   live-auto    for users armed in AUTO mode, run the checklist on each
 *                underlying and place what qualifies, then the Hero Zero
 *                expiry-day read for users who switched it on.
 */
import { sweepLiveOrders, sweepLiveAuto } from '../../modules/live/live.service.js';
import { sweepHeroZeroAuto } from '../../modules/live/heroZero.service.js';

export async function runLiveOrders(): Promise<void> {
  await sweepLiveOrders();
}

export async function runLiveAuto(): Promise<void> {
  await sweepLiveAuto();
  await sweepHeroZeroAuto();
}

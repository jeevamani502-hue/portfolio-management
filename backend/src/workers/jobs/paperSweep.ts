import { logger } from '../../utils/logger.js';
import { queryRows } from '../../db/pool.js';
import { runEntrySweep, runExitSweep } from '../../modules/paper/paper.service.js';
import { adviseOnOpenPositions, isActionable } from '../../modules/paper/advisor.js';
import { pushToUser } from '../../websocket/server.js';

/**
 * Advice already sent, so the same recommendation is not repeated every
 * three minutes for as long as it remains true. Keyed by trade and action:
 * an escalation from CONSIDER_CLOSING to CLOSE does notify again, which is
 * the one repeat worth making.
 */
const notified = new Set<string>();

const log = logger.child({ job: 'paper-sweep' });

/**
 * Drive every enabled paper-trading account.
 *
 * Exits run for all of them, including accounts that are halted or disabled:
 * an open position must always be closable, and halting entry is not a
 * reason to abandon a trade that is already on.
 */
export async function sweepPaperTrading(): Promise<void> {
  const users = await queryRows<{ user_id: string; is_enabled: boolean }>(
    `SELECT user_id, is_enabled FROM paper_trade_config
      WHERE is_enabled = TRUE
         OR EXISTS (
              SELECT 1 FROM paper_trades t
               WHERE t.user_id = paper_trade_config.user_id AND t.status = 'OPEN'
            )`,
  );
  if (users.length === 0) return;

  for (const u of users) {
    try {
      const exits = await runExitSweep(u.user_id);
      const entries = u.is_enabled
        ? await runEntrySweep(u.user_id)
        : { considered: 0, opened: 0, skipped: ['disabled'] };

      if (exits.closed > 0 || entries.opened > 0) {
        log.info(
          { userId: u.user_id, opened: entries.opened, closed: exits.closed },
          'Paper sweep applied changes',
        );
      }

      // Tell the user about positions that want a decision. Only CLOSE and
      // CONSIDER_CLOSING qualify: waking someone to say "hold" trains them
      // to ignore the next one.
      for (const advice of await adviseOnOpenPositions(u.user_id)) {
        if (!isActionable(advice)) continue;
        const key = `${advice.tradeId}:${advice.action}`;
        if (notified.has(key)) continue;
        notified.add(key);

        pushToUser(u.user_id, {
          type: 'paper_advice',
          tradeId: advice.tradeId,
          action: advice.action,
          symbol: advice.tradingsymbol,
          message: advice.headline,
          reasons: advice.reasons,
          unrealizedNet: advice.unrealizedNet,
        });
        log.info(
          { userId: u.user_id, symbol: advice.tradingsymbol, action: advice.action },
          'Position advice sent',
        );
      }
    } catch (err) {
      log.error({ err, userId: u.user_id }, 'Paper sweep failed for this user');
    }
  }
}

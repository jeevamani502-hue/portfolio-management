/**
 * The agent's daily briefings: a plan around 09:20 IST and a report around
 * 15:35 IST, on trading days, once each. The job runs every minute and does
 * nothing outside those windows; the services themselves refuse to issue a
 * second brief on the same day.
 */
import { logger } from '../../utils/logger.js';
import { toIst } from '../../utils/time.js';
import { marketStatus } from '../../modules/market/marketData.service.js';
import { agentUsers, morningPlan, closeReport } from '../../modules/agent/agent.service.js';

const log = logger.child({ job: 'agent-briefing' });

const MORNING = { from: 9 * 60 + 20, to: 9 * 60 + 35 };
const CLOSE = { from: 15 * 60 + 35, to: 15 * 60 + 55 };

export async function runAgentBriefing(): Promise<void> {
  const ist = toIst();
  const m = ist.minutesOfDay;
  const morning = m >= MORNING.from && m <= MORNING.to;
  const close = m >= CLOSE.from && m <= CLOSE.to;
  if (!morning && !close) return;

  const status = await marketStatus();
  if (status.phase === 'WEEKEND' || status.phase === 'HOLIDAY') return;

  for (const userId of await agentUsers()) {
    try {
      if (morning) await morningPlan(userId);
      if (close) await closeReport(userId);
    } catch (err) {
      log.warn({ err, userId }, 'Briefing failed for this user');
    }
  }
}

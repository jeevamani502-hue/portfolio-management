/**
 * Signal tracker — the "when to sell" half of the F&O engine.
 *
 * Every active journal entry is priced once a minute during the session and
 * resolved against its own plan: stop, invalidation, targets, expiry, time
 * stop. Each resolution is a notification, because a target reached that
 * nobody was told about is a plan nobody could follow. Two warnings fire
 * before resolution — the premium approaching the stop, and expiry within
 * a day — each exactly once per signal.
 *
 * Quotes are fetched with the signal owner's own provider credentials; a
 * signal whose contract cannot be priced is left as it is and logged, never
 * resolved on a guess.
 */
import { logger } from '../../utils/logger.js';
import { registryForUser } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getQuote } from '../../modules/market/marketData.service.js';
import { underlyingInstrumentFor } from '../../modules/options/options.service.js';
import { isAvailable } from '../../utils/sourced.js';
import {
  activeSignals, updateSignalObservation, relinkSignalContract, type SignalView,
} from '../../modules/fno/fno.service.js';
import { notify } from '../../modules/notifications/notifications.service.js';
import { resolveSignalOutcome, type SignalStatus } from '../../analysis/options/signalOutcome.js';
import { calendarDaysToExpiry } from '../../analysis/options/decisionEngine.js';

const log = logger.child({ job: 'signal-tracker' });

/** Warn once the premium has covered this much of the distance to the stop. */
const STOP_PROXIMITY_WARN = 0.7;

const contractLabel = (s: SignalView): string => `${s.underlying} ${s.strike} ${s.optionType}`;

const fmtR = (r: number | null): string =>
  r === null ? '' : ` (${r >= 0 ? '+' : ''}${r.toFixed(2)}R)`;

function resolutionMessage(s: SignalView, status: SignalStatus, premium: number, r: number | null, note: string): { title: string; message: string; severity: 'action' | 'warning' } {
  const c = contractLabel(s);
  switch (status) {
    case 'TARGET1_HIT':
      return {
        severity: 'action',
        title: `${c}: target 1 reached${fmtR(r)}`,
        message: `${note} Plan: book half here and move the stop on the rest to your entry of ₹${s.entryPremium.toFixed(2)}. Target 2 is ₹${s.target2Premium?.toFixed(2) ?? '—'}.`,
      };
    case 'TARGET2_HIT':
      return {
        severity: 'action',
        title: `${c}: target 2 reached${fmtR(r)}`,
        message: `${note} Plan: close the remainder, or trail it behind the intraday Supertrend if the move is still extending.`,
      };
    case 'STOPPED':
      return {
        severity: 'warning',
        title: `${c}: stop hit${fmtR(r)}`,
        message: `${note} Plan: exit the whole position. The loss is the risk that was defined at entry; adding to it or waiting for a recovery is not part of the plan.`,
      };
    case 'INVALIDATED':
      return {
        severity: 'warning',
        title: `${c}: thesis invalidated${fmtR(r)}`,
        message: `${note} Plan: exit even though the premium (₹${premium.toFixed(2)}) has not reached its nominal stop — the reason for the trade is gone.`,
      };
    case 'EXPIRED':
      return {
        severity: 'warning',
        title: `${c}: expired${fmtR(r)}`,
        message: note,
      };
    case 'TIMED_OUT':
      return {
        severity: 'action',
        title: `${c}: time stop${fmtR(r)}`,
        message: `${note} Plan: exit. Theta has been paying for a view that did not play out in the time allowed.`,
      };
    default:
      return { severity: 'action', title: c, message: note };
  }
}

export async function trackSignals(): Promise<void> {
  const signals = await activeSignals();
  if (signals.length === 0) return;

  const now = new Date();
  let resolved = 0;
  let skipped = 0;
  const registries = new Map<string, Awaited<ReturnType<typeof registryForUser>>>();
  const spots = new Map<string, number | null>();

  for (const s of signals) {
    try {
      let registry = registries.get(s.userId);
      if (!registry) {
        registry = await registryForUser(s.userId);
        registries.set(s.userId, registry);
      }

      // The row linked at issue is not always the one this user's brokers can
      // price: the same contract exists under each provider's spelling, and a
      // configured-but-dead provider makes "has a token" a poor test. So the
      // test is behavioural — quote the linked row; if that fails, quote the
      // other spelling, and relink the journal to whichever actually priced.
      let contract = s.instrumentId !== null ? await instrumentsRepo.getById(s.instrumentId) : null;
      let quote = contract ? await getQuote(registry, contract) : null;
      if (!contract || !quote || !isAvailable(quote)) {
        const prefer = registry.candidates('quote').map((p) => p.manifest.id);
        const alt = await instrumentsRepo.findOptionContract(s.underlying, s.expiry, s.strike, s.optionType, prefer);
        if (alt && alt.id !== contract?.id) {
          const altQuote = await getQuote(registry, alt);
          if (isAvailable(altQuote)) {
            await relinkSignalContract(s.id, alt);
            log.info(
              { signalId: s.id, from: contract?.tradingsymbol ?? null, to: alt.tradingsymbol },
              'Signal relinked to the contract row that quotes',
            );
            contract = alt;
            quote = altQuote;
          }
        }
      }
      if (!contract || !quote || !isAvailable(quote)) {
        skipped += 1;
        log.debug({ signalId: s.id, contract: contract?.tradingsymbol ?? null }, 'Signal could not be priced this sweep');
        continue;
      }
      const premium = quote.value.ltp;

      // One spot lookup per user+underlying per sweep.
      const spotKey = `${s.userId}:${s.underlying}`;
      if (!spots.has(spotKey)) {
        const row = await instrumentsRepo.resolveSymbol(underlyingInstrumentFor(s.underlying));
        const sq = row ? await getQuote(registry, row) : null;
        spots.set(spotKey, sq && isAvailable(sq) ? sq.value.ltp : null);
      }
      const spot = spots.get(spotKey) ?? null;

      const outcome = resolveSignalOutcome(
        {
          action: s.action,
          expiry: s.expiry,
          generatedAt: s.generatedAt,
          entryPremium: s.entryPremium,
          stopPremium: s.stopPremium,
          target1Premium: s.target1Premium,
          target2Premium: s.target2Premium,
          underlyingStop: s.underlyingStop,
          maxFavourablePremium: s.maxFavourablePremium,
          maxAdversePremium: s.maxAdversePremium,
        },
        { premium, spot, now },
      );

      const daysToExpiry = calendarDaysToExpiry(s.expiry, now);
      const warnStop = outcome.status === 'ACTIVE' && !s.stopWarned && outcome.stopProximity >= STOP_PROXIMITY_WARN;
      const warnExpiry = outcome.status === 'ACTIVE' && !s.expiryWarned && daysToExpiry <= 1;

      await updateSignalObservation(s.id, {
        lastPremium: premium,
        maxFavourablePremium: outcome.maxFavourablePremium,
        maxAdversePremium: outcome.maxAdversePremium,
        status: outcome.status,
        rMultiple: outcome.rMultiple,
        note: outcome.note,
        ...(warnStop ? { stopWarned: true } : {}),
        ...(warnExpiry ? { expiryWarned: true } : {}),
      });

      const payload = {
        signalId: s.id, contract: contractLabel(s), premium, spot,
        entryPremium: s.entryPremium, stopPremium: s.stopPremium,
        target1Premium: s.target1Premium, target2Premium: s.target2Premium,
        rMultiple: outcome.rMultiple, source: quote.source, asOf: quote.asOf,
      };

      if (outcome.status !== 'ACTIVE') {
        resolved += 1;
        const { title, message, severity } = resolutionMessage(s, outcome.status, premium, outcome.rMultiple, outcome.note);
        await notify(s.userId, {
          kind: 'fno_exit', severity, title,
          message: `${message} Outcomes are resolved from quotes; a live fill can differ.`,
          payload: { ...payload, status: outcome.status }, link: '/fno',
        });
        continue;
      }

      if (warnStop) {
        await notify(s.userId, {
          kind: 'fno_exit', severity: 'warning',
          title: `${contractLabel(s)}: ${(outcome.stopProximity * 100).toFixed(0)}% of the way to the stop`,
          message:
            `Premium ₹${premium.toFixed(2)} against entry ₹${s.entryPremium.toFixed(2)} and stop ₹${s.stopPremium.toFixed(2)}. ` +
            'Still inside the plan. The stop is the plan; moving it wider is how a defined loss becomes an undefined one.',
          payload, link: '/fno',
        });
      }

      if (warnExpiry) {
        await notify(s.userId, {
          kind: 'fno_exit', severity: 'warning',
          title: `${contractLabel(s)}: ${daysToExpiry === 0 ? 'expires today' : 'expires tomorrow'}`,
          message:
            `Premium ₹${premium.toFixed(2)}. With ${daysToExpiry === 0 ? 'hours' : 'a day'} left, time decay dominates direction. ` +
            'Plan: close the position, or roll it to the next expiry if the thesis still holds — do not hold to expiry hoping.',
          payload, link: '/fno',
        });
      }
    } catch (err) {
      skipped += 1;
      log.warn({ err, signalId: s.id }, 'Signal check failed');
    }
  }

  log.info({ active: signals.length, resolved, skipped }, 'Signal tracking sweep complete');
}

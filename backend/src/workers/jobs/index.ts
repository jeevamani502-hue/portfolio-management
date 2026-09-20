/**
 * Scheduled job implementations.
 *
 * Each job is a plain async function so it can be unit-tested and invoked
 * ad hoc from a script, independent of the scheduler that normally runs it.
 * Every one degrades honestly: if no provider can serve the data, the job
 * logs and records a data-quality event rather than writing placeholder rows.
 */
export { syncInstruments } from './instrumentsSync.js';
export { sweepScanner } from './scannerSweep.js';
export { pollNews } from './newsPoller.js';
export { pollOptionChains } from './optionChainPoller.js';
export { evaluateAlerts } from './alertEvaluator.js';
export { snapshotPortfolios } from './portfolioValuation.js';
export { refreshBreadth } from './breadthRefresh.js';

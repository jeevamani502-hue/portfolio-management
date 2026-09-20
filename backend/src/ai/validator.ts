/**
 * Numeric-citation validator — the enforcement behind "the model cannot invent
 * a number".
 *
 * A prompt instruction is a request. This is a check: every numeric token in
 * the model's answer must correspond to a value in the evidence bundle, or to
 * something derivable from it by an operation we explicitly permit (a
 * difference, a percentage, a ratio between two facts). Anything else fails
 * and the answer is regenerated once, then replaced by a deterministic
 * template.
 *
 * The tolerance exists because a model will legitimately write 2,650.4 as
 * "2650" or "₹2,650.40". It is not there to let unsupported figures through:
 * matching is proportional and tight.
 */
import type { EvidenceBundle } from './evidence.js';

export interface ValidationIssue {
  token: string;
  value: number;
  context: string;
  reason: 'not_in_evidence';
}

export interface ValidationResult {
  passed: boolean;
  issues: ValidationIssue[];
  checked: number;
  allowed: number;
  /** Numbers accepted because they are derivable from two facts. */
  derived: number;
}

/**
 * Numbers that appear in ordinary prose and carry no data claim.
 * Small integers are how models write "3 of the 5 rules fired", list indices,
 * and RSI thresholds quoted from the rule names themselves.
 */
const FREE_NUMBERS = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 20, 21, 26, 30, 50, 52, 70, 100,
  200, 9, 100.0,
]);

/** Common indicator periods the model will name while describing a method. */
const PERIOD_NUMBERS = new Set([9, 12, 14, 20, 26, 50, 100, 200, 250]);

function relClose(a: number, b: number, tolerance = 0.005): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return Math.abs(a - b) < 1e-9;
  return Math.abs(a - b) / scale <= tolerance;
}

/** Extract every numeric literal from the answer, with surrounding context. */
export function extractNumbers(text: string): Array<{ token: string; value: number; index: number }> {
  const out: Array<{ token: string; value: number; index: number }> = [];
  // Matches 1234, 1,234.56, 12.3% — with optional Indian digit grouping.
  //
  // The lookbehind stops a hyphen between digits from being read as a minus
  // sign: in "2024-03-15" the parts are 2024, 3 and 15, not 2024, −3, −15.
  // Without it, every ISO date in an answer produced phantom negative numbers
  // that no evidence could match.
  const re = /(?<![\w.])-?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[0];
    const value = Number(token.replace(/,/g, ''));
    if (Number.isFinite(value)) out.push({ token, value, index: m.index });
  }
  return out;
}

export function validateAnswer(answer: string, bundle: EvidenceBundle): ValidationResult {
  const factNumbers: number[] = [];
  for (const f of bundle.facts) {
    if (typeof f.value === 'number') factNumbers.push(f.value);
  }

  // Values derivable from the bundle: absolute differences, percentage changes
  // and ratios between any two numeric facts. These are arithmetic the model
  // is allowed to perform out loud.
  const derivable = new Set<number>();
  for (let i = 0; i < factNumbers.length; i += 1) {
    const a = factNumbers[i]!;
    derivable.add(Math.abs(a));
    for (let j = 0; j < factNumbers.length; j += 1) {
      if (i === j) continue;
      const b = factNumbers[j]!;
      derivable.add(Math.abs(a - b));
      if (b !== 0) {
        derivable.add(((a - b) / Math.abs(b)) * 100);
        derivable.add((a / b) * 100);
        derivable.add(a / b);
      }
    }
  }

  // Dates and times from timestamps are legitimate, as are ids in the text.
  const timeNumbers = new Set<number>();
  for (const f of bundle.facts) {
    const d = new Date(f.asOf);
    if (!Number.isNaN(d.getTime())) {
      timeNumbers.add(d.getUTCFullYear());
      timeNumbers.add(d.getUTCMonth() + 1);
      timeNumbers.add(d.getUTCDate());
      // IST clock components.
      const ist = new Date(d.getTime() + 330 * 60_000);
      timeNumbers.add(ist.getUTCHours());
      timeNumbers.add(ist.getUTCMinutes());
      timeNumbers.add(ist.getUTCSeconds());
    }
  }

  // Numbers quoted inside the context blocks are already evidence.
  const contextNumbers = new Set<number>();
  for (const c of bundle.context) {
    for (const n of extractNumbers(c.text)) contextNumbers.add(n.value);
  }
  for (const f of bundle.facts) {
    if (typeof f.value === 'string') {
      for (const n of extractNumbers(f.value)) contextNumbers.add(n.value);
    }
    if (f.note) for (const n of extractNumbers(f.note)) contextNumbers.add(n.value);
  }

  const issues: ValidationIssue[] = [];
  let allowed = 0;
  let derived = 0;

  const found = extractNumbers(answer);
  for (const n of found) {
    const v = n.value;

    if (FREE_NUMBERS.has(v) || PERIOD_NUMBERS.has(v)) { allowed += 1; continue; }
    if (timeNumbers.has(v)) { allowed += 1; continue; }
    if (contextNumbers.has(v) || [...contextNumbers].some((c) => relClose(c, v))) {
      allowed += 1;
      continue;
    }
    if (factNumbers.some((f) => relClose(f, v))) { allowed += 1; continue; }
    if ([...derivable].some((d) => relClose(d, v, 0.01))) { derived += 1; continue; }

    issues.push({
      token: n.token,
      value: v,
      context: answer.slice(Math.max(0, n.index - 60), n.index + n.token.length + 60).replace(/\s+/g, ' '),
      reason: 'not_in_evidence',
    });
  }

  return {
    passed: issues.length === 0,
    issues,
    checked: found.length,
    allowed,
    derived,
  };
}

/**
 * Phrases that claim certainty. Even with correct numbers, an answer promising
 * an outcome is unacceptable in a research tool.
 */
const CERTAINTY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bwill\s+(definitely|certainly|surely)\b/i, label: 'certainty claim' },
  { re: /\bguarantee[sd]?\b/i, label: 'guarantee' },
  { re: /\bassured\s+(return|profit|gain)/i, label: 'assured return' },
  { re: /\b100\s*%\s*(sure|certain|accurate)/i, label: 'absolute confidence' },
  { re: /\bcan'?t\s+lose\b/i, label: 'no-loss claim' },
  { re: /\brisk[\s-]?free\b/i, label: 'risk-free claim' },
  { re: /\byou\s+should\s+(buy|sell|short|invest)/i, label: 'direct investment advice' },
  { re: /\b(strong\s+)?(buy|sell)\s+recommendation\b/i, label: 'recommendation framing' },
];

export interface SafetyResult {
  passed: boolean;
  violations: Array<{ label: string; match: string }>;
}

export function validateSafety(answer: string): SafetyResult {
  const violations: Array<{ label: string; match: string }> = [];
  for (const { re, label } of CERTAINTY_PATTERNS) {
    const m = re.exec(answer);
    if (m) violations.push({ label, match: m[0] });
  }
  return { passed: violations.length === 0, violations };
}

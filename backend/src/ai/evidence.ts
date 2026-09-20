/**
 * The evidence bundle.
 *
 * This is the contract that makes the AI analyst safe: the model is handed a
 * flat list of facts, each with an id, a value, a source and a timestamp, and
 * is told it may not state any number that is not in the list. A deterministic
 * validator then checks the output against the bundle.
 *
 * If a fact the question requires is missing, we say so and never call the
 * model at all — an answer assembled from absent data is worse than no answer.
 */

export interface Fact {
  /** Stable id the model cites, e.g. "reliance.ltp". */
  id: string;
  /** Human-readable label. */
  label: string;
  /** The value. Numbers are what the validator checks against. */
  value: number | string | boolean | null;
  unit?: string;
  source: string;
  asOf: string;
  /** Where this sits on the market-data → AI-interpretation ladder. */
  kind: 'market_data' | 'calculated' | 'rule_signal' | 'user_input';
  /** Optional note the model may quote, e.g. a calculation method. */
  note?: string;
}

export interface EvidenceBundle {
  intent: string;
  subject: string;
  facts: Fact[];
  /** Narrative blocks the model may quote verbatim (rule details, methods). */
  context: Array<{ id: string; label: string; text: string }>;
  /** Facts that were required but could not be obtained. */
  missing: Array<{ id: string; label: string; reason: string }>;
  /** Distinct sources contributing to this bundle. */
  sources: string[];
  /** Oldest timestamp across all facts — the bundle's true "as of". */
  asOf: string | null;
  marketPhase: string;
}

export class EvidenceBuilder {
  private facts: Fact[] = [];
  private context: Array<{ id: string; label: string; text: string }> = [];
  private missing: Array<{ id: string; label: string; reason: string }> = [];

  constructor(
    private intent: string,
    private subject: string,
    private marketPhase: string,
  ) {}

  add(fact: Fact): this {
    if (fact.value !== null && fact.value !== undefined) this.facts.push(fact);
    return this;
  }

  /** Add a numeric fact, skipping it silently when the value is absent. */
  addNumber(
    id: string,
    label: string,
    value: number | null | undefined,
    opts: { unit?: string; source: string; asOf: string; kind?: Fact['kind']; note?: string },
  ): this {
    if (value === null || value === undefined || !Number.isFinite(value)) return this;
    this.facts.push({
      id,
      label,
      value: Number(value.toFixed(4)),
      ...(opts.unit !== undefined ? { unit: opts.unit } : {}),
      source: opts.source,
      asOf: opts.asOf,
      kind: opts.kind ?? 'market_data',
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    });
    return this;
  }

  addText(
    id: string,
    label: string,
    value: string | null | undefined,
    opts: { source: string; asOf: string; kind?: Fact['kind'] },
  ): this {
    if (!value) return this;
    this.facts.push({
      id, label, value, source: opts.source, asOf: opts.asOf,
      kind: opts.kind ?? 'market_data',
    });
    return this;
  }

  addContext(id: string, label: string, text: string): this {
    if (text) this.context.push({ id, label, text });
    return this;
  }

  markMissing(id: string, label: string, reason: string): this {
    this.missing.push({ id, label, reason });
    return this;
  }

  build(): EvidenceBundle {
    const times = this.facts
      .map((f) => new Date(f.asOf).getTime())
      .filter((t) => Number.isFinite(t));

    return {
      intent: this.intent,
      subject: this.subject,
      facts: this.facts,
      context: this.context,
      missing: this.missing,
      sources: [...new Set(this.facts.map((f) => f.source))].sort(),
      asOf: times.length ? new Date(Math.min(...times)).toISOString() : null,
      marketPhase: this.marketPhase,
    };
  }
}

/** Render the bundle as the text block handed to the model. */
export function renderBundle(bundle: EvidenceBundle): string {
  const lines: string[] = [];

  lines.push(`INTENT: ${bundle.intent}`);
  lines.push(`SUBJECT: ${bundle.subject}`);
  lines.push(`MARKET PHASE: ${bundle.marketPhase}`);
  lines.push(`BUNDLE AS OF: ${bundle.asOf ?? 'unknown'}`);
  lines.push('');
  lines.push('=== FACTS (the complete set of values you may state) ===');

  for (const f of bundle.facts) {
    const unit = f.unit ? ` ${f.unit}` : '';
    const note = f.note ? `  // ${f.note}` : '';
    lines.push(
      `[${f.id}] ${f.label}: ${String(f.value)}${unit}  (source: ${f.source}, as of ${f.asOf}, type: ${f.kind})${note}`,
    );
  }

  if (bundle.context.length > 0) {
    lines.push('');
    lines.push('=== CONTEXT (narrative you may quote or paraphrase) ===');
    for (const c of bundle.context) {
      lines.push(`[${c.id}] ${c.label}:`);
      lines.push(c.text);
      lines.push('');
    }
  }

  if (bundle.missing.length > 0) {
    lines.push('');
    lines.push('=== UNAVAILABLE (you MUST state these are unavailable if relevant) ===');
    for (const m of bundle.missing) {
      lines.push(`[${m.id}] ${m.label}: unavailable — ${m.reason}`);
    }
  }

  return lines.join('\n');
}

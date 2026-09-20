/**
 * The Market Analyst.
 *
 * Pipeline: intent → retrieval plan → evidence bundle → gap check → Claude →
 * numeric validation → (regenerate once) → deterministic fallback.
 *
 * The model's only job is narration. Every number it is permitted to write
 * already exists in the bundle, and the validator proves it afterwards. If
 * the bundle lacks a fact the question requires, we answer that we cannot
 * answer — and never call the model at all.
 */
import Anthropic from '@anthropic-ai/sdk';
import { env, aiAvailable } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';
import { query } from '../db/pool.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { detectIntent, planRetrieval, type Intent } from './intent.js';
import { gatherEvidence } from './retrieval.js';
import { renderBundle, type EvidenceBundle } from './evidence.js';
import { validateAnswer, validateSafety, type ValidationResult } from './validator.js';
import { SYSTEM_PROMPT, buildUserPrompt, CONCEPT_EXPLANATIONS } from './prompts.js';
import { formatIstDateTime, type Timeframe } from '../utils/time.js';
import { renderDeterministicAnswer } from './fallback.js';

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new AppError('AI_DISABLED', 'ANTHROPIC_API_KEY is not configured', 503);
    }
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface AnalystRequest {
  question: string;
  userId: string;
  registry: ProviderRegistry;
  timeframe?: Timeframe;
  conversationId?: string;
}

export interface AnalystResponse {
  answer: string;
  intent: Intent;
  subject: string;
  symbols: string[];
  /** Every fact the model was given, for the evidence panel. */
  evidence: EvidenceBundle;
  sources: string[];
  dataAsOf: string | null;
  generatedAt: string;
  istTime: string;
  model: string | null;
  validation: {
    passed: boolean;
    numbersChecked: number;
    issues: ValidationResult['issues'];
    regenerated: boolean;
    degradedToTemplate: boolean;
    safetyViolations: Array<{ label: string; match: string }>;
  };
  /** True when we answered without the model because evidence was missing. */
  refused: boolean;
  disclaimer: string;
  latencyMs: number;
}

const DISCLAIMER =
  'This response is generated from the market data listed in the evidence panel and nothing else. ' +
  'It is research and analysis, not investment advice, and it makes no prediction about future prices. ' +
  'Every figure quoted is traceable to a source and timestamp shown alongside it.';

export async function ask(req: AnalystRequest): Promise<AnalystResponse> {
  const started = Date.now();
  const generatedAt = new Date().toISOString();

  const detected = await detectIntent(req.question);
  const timeframe = (req.timeframe ?? detected.timeframe ?? '1d') as Timeframe;
  const plan = planRetrieval(detected.intent, detected.symbols.length);

  // Conceptual questions need no market data; answer from the local glossary
  // so we neither call the model nor risk it inventing a definition.
  if (detected.intent === 'explain_concept') {
    const explanation = matchConcept(req.question);
    if (explanation) {
      return {
        answer: explanation,
        intent: detected.intent,
        subject: 'concept',
        symbols: [],
        evidence: {
          intent: detected.intent, subject: 'concept', facts: [], context: [],
          missing: [], sources: ['built-in glossary'], asOf: null, marketPhase: 'n/a',
        },
        sources: ['built-in glossary'],
        dataAsOf: null,
        generatedAt,
        istTime: formatIstDateTime(),
        model: null,
        validation: {
          passed: true, numbersChecked: 0, issues: [], regenerated: false,
          degradedToTemplate: false, safetyViolations: [],
        },
        refused: false,
        disclaimer:
          'This is a definition of a technical concept from the platform glossary. It describes how the platform computes the metric, not a view on any instrument.',
        latencyMs: Date.now() - started,
      };
    }
  }

  if (detected.intent === 'unsupported') {
    return refusal(
      req.question,
      detected.intent,
      "I could not tell what this question is asking about. I can analyse a stock or index, read an option chain, review your portfolio, scan for setups, summarise market breadth and regime, or explain how a metric is computed. Naming an instrument (for example \"analyse RELIANCE\" or \"what is Bank Nifty's option chain saying\") will get a more useful answer.",
      generatedAt,
      started,
    );
  }

  // ── gather evidence ──
  const evidence = await gatherEvidence({
    registry: req.registry,
    userId: req.userId,
    intent: detected.intent,
    symbols: detected.symbols,
    timeframe,
    plan,
    question: req.question,
  });

  // ── gap check: refuse rather than guess ──
  const factIds = new Set(evidence.facts.map((f) => f.id));
  const missingRequired = plan.requiredFactIds.filter((required) => {
    // A required id may be prefixed per-symbol when several were requested.
    if (factIds.has(required)) return false;
    return ![...factIds].some((id) => id.endsWith(`.${required}`) || id.endsWith(required));
  });

  if (missingRequired.length > 0 || evidence.facts.length === 0) {
    const reasons = evidence.missing
      .map((m) => `• ${m.label}: ${m.reason}`)
      .join('\n');

    return refusal(
      req.question,
      detected.intent,
      'Live market data unavailable — I cannot answer this question without inventing values.\n\n' +
        (reasons
          ? `What is missing:\n${reasons}\n\n`
          : 'No market data could be retrieved for this question.\n\n') +
        'Check Settings → Market Data Provider to confirm your broker credentials are configured and the instrument sync has run.',
      generatedAt,
      started,
      evidence,
    );
  }

  if (!aiAvailable()) {
    // The data is there; only the model is not. A deterministic summary is a
    // genuinely useful answer, and it is honest about what it is.
    const templated = renderDeterministicAnswer(detected.intent, evidence);
    return {
      answer: templated,
      intent: detected.intent,
      subject: evidence.subject,
      symbols: detected.symbols,
      evidence,
      sources: evidence.sources,
      dataAsOf: evidence.asOf,
      generatedAt,
      istTime: formatIstDateTime(),
      model: null,
      validation: {
        passed: true, numbersChecked: 0, issues: [], regenerated: false,
        degradedToTemplate: true, safetyViolations: [],
      },
      refused: false,
      disclaimer:
        'The AI analyst is not configured (no ANTHROPIC_API_KEY), so this is a deterministic summary generated directly from the retrieved data. ' +
        DISCLAIMER,
      latencyMs: Date.now() - started,
    };
  }

  // ── call the model ──
  const rendered = renderBundle(evidence);
  const userPrompt = buildUserPrompt(req.question, detected.intent, rendered);

  let answer = '';
  let validation = validateAnswer('', evidence);
  let safety = validateSafety('');
  let regenerated = false;
  let degraded = false;

  try {
    answer = await callModel(userPrompt);
    validation = validateAnswer(answer, evidence);
    safety = validateSafety(answer);

    if (!validation.passed || !safety.passed) {
      logger.warn(
        {
          intent: detected.intent,
          issues: validation.issues.slice(0, 5),
          safety: safety.violations,
        },
        'AI answer failed validation — regenerating once',
      );

      const correction = buildCorrectionPrompt(userPrompt, validation, safety);
      answer = await callModel(correction);
      validation = validateAnswer(answer, evidence);
      safety = validateSafety(answer);
      regenerated = true;

      if (!validation.passed || !safety.passed) {
        logger.error(
          { intent: detected.intent, issues: validation.issues.slice(0, 5) },
          'AI answer failed validation twice — falling back to deterministic template',
        );
        answer = renderDeterministicAnswer(detected.intent, evidence);
        degraded = true;
      }
    }
  } catch (err) {
    logger.error({ err }, 'AI call failed — falling back to deterministic template');
    answer = renderDeterministicAnswer(detected.intent, evidence);
    degraded = true;
  }

  const response: AnalystResponse = {
    answer,
    intent: detected.intent,
    subject: evidence.subject,
    symbols: detected.symbols,
    evidence,
    sources: evidence.sources,
    dataAsOf: evidence.asOf,
    generatedAt,
    istTime: formatIstDateTime(),
    model: degraded ? null : env.AI_MODEL,
    validation: {
      passed: validation.passed && safety.passed,
      numbersChecked: validation.checked,
      issues: validation.issues,
      regenerated,
      degradedToTemplate: degraded,
      safetyViolations: safety.violations,
    },
    refused: false,
    disclaimer: degraded
      ? 'The generated answer did not pass numeric verification against the retrieved data, so it was replaced by a deterministic summary. ' + DISCLAIMER
      : DISCLAIMER,
    latencyMs: Date.now() - started,
  };

  void logAnalysis(req, detected.intent, evidence, response);
  return response;
}

async function callModel(prompt: string): Promise<string> {
  const message = await anthropic().messages.create({
    model: env.AI_MODEL,
    max_tokens: env.AI_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    // Adaptive thinking: the analyst has to weigh several conflicting signals,
    // which is exactly the case it helps with.
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: prompt }],
  });

  if (message.stop_reason === 'refusal') {
    throw new AppError('AI_INSUFFICIENT_EVIDENCE', 'The model declined to answer this request', 502);
  }

  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function buildCorrectionPrompt(
  original: string,
  validation: ValidationResult,
  safety: ReturnType<typeof validateSafety>,
): string {
  const parts: string[] = [original, '', '--- CORRECTION REQUIRED ---'];

  if (validation.issues.length > 0) {
    parts.push(
      'Your previous answer contained numbers that do not appear in the evidence and cannot be derived from it:',
      ...validation.issues.slice(0, 10).map((i) => `  • "${i.token}" in: ...${i.context}...`),
      '',
      'Rewrite the answer using ONLY values present in the FACTS section. If a figure you wanted is not there, say it is unavailable instead of estimating it.',
    );
  }

  if (safety.violations.length > 0) {
    parts.push(
      'Your previous answer used language that claims certainty or gives direct advice:',
      ...safety.violations.map((v) => `  • ${v.label}: "${v.match}"`),
      '',
      'Rewrite without any claim of certainty and without telling the user what to do.',
    );
  }

  return parts.join('\n');
}

function matchConcept(question: string): string | null {
  const lower = question.toLowerCase();
  for (const [key, text] of Object.entries(CONCEPT_EXPLANATIONS)) {
    if (lower.includes(key)) return text;
  }
  return null;
}

function refusal(
  _question: string,
  intent: Intent,
  message: string,
  generatedAt: string,
  started: number,
  evidence?: EvidenceBundle,
): AnalystResponse {
  return {
    answer: message,
    intent,
    subject: evidence?.subject ?? 'unknown',
    symbols: [],
    evidence: evidence ?? {
      intent, subject: 'unknown', facts: [], context: [], missing: [],
      sources: [], asOf: null, marketPhase: 'unknown',
    },
    sources: evidence?.sources ?? [],
    dataAsOf: evidence?.asOf ?? null,
    generatedAt,
    istTime: formatIstDateTime(),
    model: null,
    validation: {
      passed: true, numbersChecked: 0, issues: [], regenerated: false,
      degradedToTemplate: false, safetyViolations: [],
    },
    refused: true,
    disclaimer:
      'No answer was generated because the data required to answer honestly was not available. No values have been estimated or substituted.',
    latencyMs: Date.now() - started,
  };
}

async function logAnalysis(
  req: AnalystRequest,
  intent: Intent,
  evidence: EvidenceBundle,
  response: AnalystResponse,
): Promise<void> {
  try {
    await query(
      `INSERT INTO analysis_logs
         (user_id, question, intent, evidence, missing_facts, validator_passed,
          validator_detail, regenerated, degraded_to_template, latency_ms)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10)`,
      [
        req.userId,
        req.question.slice(0, 2000),
        intent,
        JSON.stringify({ facts: evidence.facts, sources: evidence.sources, asOf: evidence.asOf }),
        evidence.missing.map((m) => m.id),
        response.validation.passed,
        JSON.stringify({
          issues: response.validation.issues,
          safety: response.validation.safetyViolations,
          numbersChecked: response.validation.numbersChecked,
        }),
        response.validation.regenerated,
        response.validation.degradedToTemplate,
        response.latencyMs,
      ],
    );
  } catch (err) {
    logger.debug({ err }, 'analysis_logs insert failed');
  }
}

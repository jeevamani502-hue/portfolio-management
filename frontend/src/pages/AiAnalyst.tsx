/**
 * The Market Analyst.
 *
 * The evidence panel is not a nicety — it is the product. Every answer ships
 * with the exact facts the model was given, what was missing, and the result
 * of the numeric validator, so a user can audit any statement rather than
 * trusting it.
 */
import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Send, Bot, User, ShieldCheck, ShieldAlert, Database, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '@/services/api';
import {
  Card, CardContent, Badge, Button, Input, Alert, Spinner, Tooltip, EmptyState,
} from '@/components/ui';
import { ProvenanceChip } from '@/components/market/DataValue';
import { istTime, relativeTime, humanise } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AnalystResponseDto } from '@/types/api';

const SUGGESTIONS = [
  'Why is NIFTY moving today?',
  'Analyse RELIANCE',
  'What are the major market risks right now?',
  'Analyse my portfolio',
  'Find swing setups',
  "Explain Bank Nifty's option chain",
  'Compare TCS and INFY',
  'What is RSI?',
];

interface Turn {
  id: string;
  question: string;
  response: AnalystResponseDto | null;
  error: string | null;
}

export function AiAnalyst() {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const status = useQuery({ queryKey: ['ai', 'status'], queryFn: () => api.ai.status() });

  const ask = useMutation({
    mutationFn: (q: string) => api.ai.analyze(q),
    onMutate: (q) => {
      const id = crypto.randomUUID();
      setTurns((t) => [...t, { id, question: q, response: null, error: null }]);
      return { id };
    },
    onSuccess: (data, _q, ctx) => {
      setTurns((t) => t.map((x) => (x.id === ctx?.id ? { ...x, response: data } : x)));
    },
    onError: (err, _q, ctx) => {
      setTurns((t) =>
        t.map((x) => (x.id === ctx?.id ? { ...x, error: (err as Error).message } : x)),
      );
    },
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  const submit = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || ask.isPending) return;
    setQuestion('');
    ask.mutate(trimmed);
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-5xl flex-col gap-3">
      {status.data && !status.data.enabled && (
        <Alert variant="warning" title="The language model is not configured">
          {status.data.reason}. {status.data.note}
        </Alert>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {turns.length === 0 && (
          <EmptyState
            icon={<Bot className="h-8 w-8" />}
            title="Market Analyst"
            description={
              <>
                Ask about a stock, an index, your portfolio, an option chain, or the market as a
                whole. Answers are built only from data the platform actually retrieved — every
                number is checked against that evidence before you see it, and if the data is
                missing the analyst says so rather than guessing.
              </>
            }
          />
        )}

        {turns.map((turn) => (
          <div key={turn.id} className="space-y-3">
            <div className="flex justify-end">
              <div className="flex max-w-[80%] items-start gap-2 rounded-lg bg-primary px-3 py-2 text-primary-foreground">
                <span className="text-sm">{turn.question}</span>
                <User className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
              </div>
            </div>

            {turn.error && <Alert variant="error">{turn.error}</Alert>}

            {!turn.response && !turn.error && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner />
                Retrieving market data and composing an answer…
              </div>
            )}

            {turn.response && <AnswerBlock response={turn.response} />}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {turns.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => submit(s)}
              className="rounded-full border border-border px-2.5 py-1 text-2xs text-muted-foreground
                         transition-colors hover:bg-accent hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); submit(question); }}
        className="flex gap-2"
      >
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about a stock, the market, or your portfolio…"
          disabled={ask.isPending}
        />
        <Button type="submit" disabled={ask.isPending || !question.trim()}>
          {ask.isPending ? <Spinner /> : <Send className="h-3.5 w-3.5" aria-hidden />}
          Ask
        </Button>
      </form>
    </div>
  );
}

function AnswerBlock({ response }: { response: AnalystResponseDto }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const v = response.validation;

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Bot className="h-4 w-4 text-primary" aria-hidden />
          <ProvenanceChip kind={response.refused || v.degradedToTemplate ? 'calculated' : 'ai_interpretation'} />
          <Badge variant="muted">{humanise(response.intent)}</Badge>

          {v.degradedToTemplate ? (
            <Tooltip content="The generated answer did not pass numeric verification, so a deterministic summary built directly from the retrieved data was shown instead.">
              <Badge variant="warning">Deterministic summary</Badge>
            </Tooltip>
          ) : response.refused ? (
            <Badge variant="warning">No answer — data missing</Badge>
          ) : (
            <Tooltip
              content={
                v.passed
                  ? `All ${v.numbersChecked} numeric values in this answer were matched against the evidence bundle.`
                  : 'Some values could not be matched against the evidence.'
              }
            >
              <Badge variant={v.passed ? 'up' : 'down'}>
                {v.passed ? (
                  <><ShieldCheck className="mr-1 h-3 w-3" aria-hidden />{v.numbersChecked} figures verified</>
                ) : (
                  <><ShieldAlert className="mr-1 h-3 w-3" aria-hidden />Verification failed</>
                )}
              </Badge>
            </Tooltip>
          )}

          {v.regenerated && (
            <Tooltip content="The first draft failed verification and was regenerated before being shown.">
              <Badge variant="muted">Regenerated</Badge>
            </Tooltip>
          )}

          <span className="ml-auto text-2xs text-muted-foreground">
            {response.istTime} · {response.latencyMs} ms
            {response.model && ` · ${response.model}`}
          </span>
        </div>

        <div className="prose-sm max-w-none space-y-2 text-sm leading-relaxed">
          {renderMarkdownish(response.answer)}
        </div>

        {!v.passed && v.issues.length > 0 && (
          <Alert variant="error" title="Unverified figures were detected">
            <ul className="mt-1 space-y-0.5">
              {v.issues.slice(0, 5).map((i, idx) => (
                <li key={idx}>
                  <span className="font-mono">{i.token}</span> could not be matched to any retrieved
                  value.
                </li>
              ))}
            </ul>
          </Alert>
        )}

        <div className="border-t border-border pt-2">
          <button
            onClick={() => setShowEvidence((s) => !s)}
            className="flex items-center gap-1 text-2xs font-medium text-primary hover:underline"
          >
            {showEvidence ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Database className="h-3 w-3" aria-hidden />
            {showEvidence ? 'Hide' : 'Show'} the {response.evidence.facts.length} facts this answer
            was built from
          </button>

          {showEvidence && (
            <div className="mt-2 space-y-3">
              <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Fact</th>
                      <th className="text-right">Value</th>
                      <th>Type</th>
                      <th>Source</th>
                      <th>As of</th>
                    </tr>
                  </thead>
                  <tbody>
                    {response.evidence.facts.map((f) => (
                      <tr key={f.id}>
                        <td>
                          <div className="text-2xs font-medium">{f.label}</div>
                          <div className="font-mono text-2xs text-muted-foreground">{f.id}</div>
                        </td>
                        <td className="num text-2xs">
                          {String(f.value)}
                          {f.unit ? ` ${f.unit}` : ''}
                        </td>
                        <td>
                          <ProvenanceChip kind={f.kind} />
                        </td>
                        <td className="text-2xs text-muted-foreground">{f.source}</td>
                        <td className="text-2xs text-muted-foreground">
                          <Tooltip content={f.asOf}>
                            <span>{relativeTime(f.asOf)}</span>
                          </Tooltip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {response.evidence.missing.length > 0 && (
                <Alert variant="warning" title="Data that could not be retrieved">
                  <ul className="mt-1 space-y-0.5">
                    {response.evidence.missing.map((m) => (
                      <li key={m.id}>
                        <span className="font-medium">{m.label}</span> — {m.reason}
                      </li>
                    ))}
                  </ul>
                </Alert>
              )}

              <div className="text-2xs text-muted-foreground">
                Sources: {response.sources.join(', ') || 'none'}
                {response.dataAsOf && ` · oldest data point ${istTime(response.dataAsOf)} IST`}
              </div>
            </div>
          )}
        </div>

        <p className="text-2xs leading-relaxed text-muted-foreground">{response.disclaimer}</p>
      </CardContent>
    </Card>
  );
}

/**
 * A deliberately small markdown renderer.
 *
 * The analyst emits headings, bullets, bold and paragraphs — nothing else — so
 * pulling in a full markdown library (and its XSS surface) is not warranted.
 * Text is rendered as text; no HTML from the model is ever interpreted.
 */
function renderMarkdownish(text: string): React.ReactNode {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  let listBuffer: string[] = [];

  const flushList = (key: string) => {
    if (listBuffer.length === 0) return;
    out.push(
      <ul key={key} className="ml-4 list-disc space-y-0.5">
        {listBuffer.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    listBuffer = [];
  };

  lines.forEach((line, i) => {
    const trimmed = line.trim();

    if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
      listBuffer.push(trimmed.slice(2));
      return;
    }
    flushList(`list-${i}`);

    if (trimmed.startsWith('### ')) {
      out.push(<h4 key={i} className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{trimmed.slice(4)}</h4>);
    } else if (trimmed.startsWith('## ')) {
      out.push(<h3 key={i} className="mt-3 text-sm font-semibold">{trimmed.slice(3)}</h3>);
    } else if (trimmed.startsWith('# ')) {
      out.push(<h2 key={i} className="mt-3 text-base font-semibold">{trimmed.slice(2)}</h2>);
    } else if (trimmed === '---') {
      out.push(<hr key={i} className="my-2 border-border" />);
    } else if (trimmed.length > 0) {
      out.push(<p key={i}>{renderInline(trimmed)}</p>);
    }
  });

  flushList('list-final');
  return out;
}

/** Handles **bold** and `code` only. */
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-2xs">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i} className={cn(/\d/.test(part) && 'tabular')}>{part}</span>;
  });
}

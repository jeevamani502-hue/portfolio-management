import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api } from '@/services/api';
import {
  Card, CardContent, Skeleton, Badge, Select, Input, Alert, EmptyState, Tooltip,
} from '@/components/ui';
import { DataValue } from '@/components/market/DataValue';
import { istDateTime, relativeTime, humanise, pct } from '@/lib/format';

export function News() {
  const [symbol, setSymbol] = useState('');
  const [sentiment, setSentiment] = useState('');
  const [sinceHours, setSinceHours] = useState(72);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const news = useQuery({
    queryKey: ['news', symbol, sentiment, sinceHours],
    queryFn: () =>
      api.news.list({
        ...(symbol ? { symbol: symbol.toUpperCase() } : {}),
        ...(sentiment ? { sentiment } : {}),
        sinceHours,
        limit: 50,
      }),
    refetchInterval: 300_000,
  });

  const impact = useQuery({
    queryKey: ['news', 'impact', expandedId],
    queryFn: () => api.news.impact(expandedId!),
    enabled: Boolean(expandedId),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40 space-y-1">
          <label className="text-2xs uppercase tracking-wide text-muted-foreground">Symbol</label>
          <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="Any" />
        </div>
        <div className="w-36 space-y-1">
          <label className="text-2xs uppercase tracking-wide text-muted-foreground">Sentiment</label>
          <Select value={sentiment} onChange={(e) => setSentiment(e.target.value)}>
            <option value="">Any</option>
            <option value="POSITIVE">Positive</option>
            <option value="NEUTRAL">Neutral</option>
            <option value="NEGATIVE">Negative</option>
          </Select>
        </div>
        <div className="w-36 space-y-1">
          <label className="text-2xs uppercase tracking-wide text-muted-foreground">Window</label>
          <Select value={String(sinceHours)} onChange={(e) => setSinceHours(Number(e.target.value))}>
            <option value="6">Last 6 hours</option>
            <option value="24">Last 24 hours</option>
            <option value="72">Last 3 days</option>
            <option value="168">Last week</option>
          </Select>
        </div>
      </div>

      <Alert>
        Sentiment labels come from a transparent keyword-and-rules classifier, not from reading the
        article. They are frequently wrong on irony, conditionals and mistaken entity attribution.
        Treat them as a filter, never as a fact about the news.
      </Alert>

      {news.isLoading ? (
        <Skeleton className="h-96" />
      ) : (
        <DataValue data={news.data}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState title="No articles match this filter" />
            ) : (
              <div className="w-full space-y-2">
                {items.map((n) => (
                  <Card key={n.id}>
                    <CardContent className="pt-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <a
                          href={n.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-start gap-1.5 text-sm font-medium leading-snug hover:text-primary"
                        >
                          {n.headline}
                          <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 opacity-50" aria-hidden />
                        </a>
                        {n.sentiment.label && (
                          <Tooltip
                            content={
                              <div className="space-y-1">
                                <div>Method: {n.sentiment.method}</div>
                                <div>Score: {n.sentiment.score}</div>
                                <div>Confidence: {pct((n.sentiment.confidence ?? 0) * 100, 0)}</div>
                                <div className="opacity-80">{n.sentiment.caveat}</div>
                              </div>
                            }
                          >
                            <Badge
                              variant={
                                n.sentiment.label === 'POSITIVE' ? 'up'
                                : n.sentiment.label === 'NEGATIVE' ? 'down' : 'muted'
                              }
                            >
                              {humanise(n.sentiment.label)}
                              {n.sentiment.confidence !== null &&
                                ` · ${(n.sentiment.confidence * 100).toFixed(0)}%`}
                            </Badge>
                          </Tooltip>
                        )}
                      </div>

                      {n.summary && (
                        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {n.summary}
                        </p>
                      )}

                      <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                        <span className="font-medium text-foreground">{n.publisher}</span>
                        <Tooltip content={istDateTime(n.publishedAt)}>
                          <span>{relativeTime(n.publishedAt)}</span>
                        </Tooltip>
                        {n.category && <Badge variant="muted">{n.category}</Badge>}
                        {n.relatedInstruments.map((e) => (
                          <Tooltip
                            key={e.id}
                            content={`Matched on ${e.matchReason.replace(/_/g, ' ')} · relevance ${e.relevance.toFixed(2)}`}
                          >
                            <Link
                              to={`/stocks/${encodeURIComponent(e.symbol)}`}
                              className="text-primary hover:underline"
                            >
                              {e.symbol}
                            </Link>
                          </Tooltip>
                        ))}
                        {n.relatedInstruments.length > 0 && (
                          <button
                            onClick={() => setExpandedId(expandedId === n.id ? null : n.id)}
                            className="ml-auto text-primary hover:underline"
                          >
                            {expandedId === n.id ? 'Hide' : 'Show'} potential impact
                          </button>
                        )}
                      </div>

                      {expandedId === n.id && (
                        <div className="mt-3 border-t border-border pt-3">
                          {impact.isLoading ? (
                            <Skeleton className="h-20" />
                          ) : impact.data ? (
                            <div className="space-y-2">
                              {impact.data.impacts.map((i) => (
                                <div key={i.symbol} className="rounded-md bg-muted/40 p-2.5">
                                  <div className="flex items-center gap-2">
                                    <Link
                                      to={`/stocks/NSE:${i.symbol}`}
                                      className="text-xs font-medium hover:text-primary"
                                    >
                                      {i.symbol}
                                    </Link>
                                    <Badge
                                      variant={
                                        i.relevanceLabel === 'High' ? 'default'
                                        : i.relevanceLabel === 'Medium' ? 'secondary' : 'muted'
                                      }
                                    >
                                      {i.relevanceLabel} relevance
                                    </Badge>
                                  </div>
                                  <p className="mt-1 text-2xs text-muted-foreground">{i.reason}</p>
                                  <p className="mt-1 text-2xs text-muted-foreground">
                                    {i.potentialImpact}
                                  </p>
                                </div>
                              ))}
                              <p className="text-2xs text-muted-foreground">
                                {impact.data.disclaimer}
                              </p>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )
          }
        </DataValue>
      )}
    </div>
  );
}

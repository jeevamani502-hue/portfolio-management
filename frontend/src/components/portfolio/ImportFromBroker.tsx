/**
 * Pull holdings from a connected broker into a portfolio.
 *
 * The import reconciles rather than appends: quantities and average prices
 * are updated in place, so running it twice does not double your position.
 * Symbols the instrument master cannot resolve are reported back rather than
 * silently dropped — a partial import that looks complete is worse than one
 * that tells you what it missed.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import { Card, CardHeader, CardTitle, CardContent, Button, Alert, Badge } from '@/components/ui';
import type { ImportResultDto } from '@/types/api';

export function ImportFromBroker({ portfolioId }: { portfolioId: string }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<ImportResultDto | null>(null);

  const sources = useQuery({
    queryKey: ['portfolio', 'import', 'sources'],
    queryFn: api.portfolio.importSources,
  });

  const run = useMutation({
    mutationFn: (provider: string) => api.portfolio.importFrom(portfolioId, provider),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import holdings from a broker</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {sources.isLoading ? (
          <p className="text-sm text-muted-foreground">Checking which brokers can supply holdings…</p>
        ) : (sources.data ?? []).length === 0 ? (
          <Alert variant="default" title="No broker can supply holdings yet">
            Connect a broker in Settings → Market data providers. Not every provider exposes
            holdings, so only the ones that do will appear here.
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {sources.data!.map((s) => (
                <Button
                  key={s.id}
                  variant="outline"
                  onClick={() => run.mutate(s.id)}
                  disabled={run.isPending}
                >
                  {run.isPending && run.variables === s.id
                    ? `Importing from ${s.displayName}…`
                    : `Import from ${s.displayName}`}
                </Button>
              ))}
            </div>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Safe to run repeatedly — it reconciles against what your broker reports rather than
              adding a second copy. Holdings you entered by hand are left alone.
            </p>
          </>
        )}

        {run.isError && (
          <Alert variant="warning" title="Import failed">
            {run.error instanceof Error ? run.error.message : 'Unknown error.'}
          </Alert>
        )}

        {result && <ImportSummary result={result} />}
      </CardContent>
    </Card>
  );
}

function ImportSummary({ result: r }: { result: ImportResultDto }) {
  const nothing = r.fetched === 0;
  return (
    <Alert
      variant={nothing || r.skipped.length > 0 ? 'default' : 'info'}
      title={
        nothing
          ? `${r.provider} reported no holdings`
          : `${r.fetched} holding(s) from ${r.provider}: ${r.imported} added, ${r.updated} updated`
      }
    >
      {nothing ? (
        <p className="text-sm leading-relaxed">
          The broker returned an empty list, so there is nothing to import. That is what an account
          with no demat holdings looks like — it is not an error. If you hold stock at a different
          broker, connect that one instead.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{r.imported} added</Badge>
            <Badge variant="outline">{r.updated} updated</Badge>
            {r.removed > 0 && <Badge variant="outline">{r.removed} removed</Badge>}
            {r.skipped.length > 0 && <Badge variant="warning">{r.skipped.length} skipped</Badge>}
          </div>

          {r.skipped.length > 0 && (
            <div>
              <p className="text-sm">These could not be matched to an instrument:</p>
              <ul className="mt-1 space-y-1">
                {r.skipped.map((s) => (
                  <li key={s.tradingsymbol} className="text-2xs text-muted-foreground">
                    <span className="font-mono">{s.tradingsymbol}</span> — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-2xs leading-relaxed text-muted-foreground">{r.note}</p>
        </div>
      )}
    </Alert>
  );
}

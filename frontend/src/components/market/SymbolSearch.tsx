/** Command-palette style instrument search. */
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Loader2 } from 'lucide-react';
import { api } from '@/services/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui';

export function SymbolSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounce so a fast typist does not fire a request per keystroke.
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 180);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.market.search(debounced, 12),
    enabled: debounced.trim().length >= 1,
    staleTime: 60_000,
  });

  const items = results ?? [];

  useEffect(() => {
    setHighlighted(0);
  }, [debounced]);

  const open = (symbol: string) => {
    navigate(`/stocks/${encodeURIComponent(symbol)}`);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[highlighted];
      if (item) open(item.symbol);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Search instruments"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="RELIANCE, TCS, NIFTY 50…"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>

        <div className="max-h-80 overflow-y-auto">
          {debounced.trim().length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              Type a symbol or company name to search the instrument master.
            </div>
          )}

          {debounced.trim().length > 0 && !isFetching && items.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No instrument matches “{debounced}”. If you expected a result, the instrument master
              may not be synced yet — run the sync from Settings.
            </div>
          )}

          {items.map((item, i) => (
            <button
              key={item.id}
              onClick={() => open(item.symbol)}
              onMouseEnter={() => setHighlighted(i)}
              className={cn(
                'flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors',
                i === highlighted && 'bg-accent',
              )}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{item.tradingsymbol}</div>
                {item.name && (
                  <div className="truncate text-2xs text-muted-foreground">{item.name}</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {item.sector && (
                  <span className="hidden text-2xs text-muted-foreground sm:inline">
                    {item.sector}
                  </span>
                )}
                <Badge variant="muted">{item.exchange}</Badge>
              </div>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-2xs text-muted-foreground">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

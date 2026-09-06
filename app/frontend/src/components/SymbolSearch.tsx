import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { fetchSymbols, type Exchange } from "@/api";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export default function SymbolSearch({
  exchange,
  value,
  onSelect,
  placeholder,
  className,
}: {
  exchange: Exchange;
  value: string;
  onSelect: (symbol: string, ticker: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const lastAutoSelectionRef = useRef<string | null>(null);

  // Stay in sync when the parent resets the value out from under us
  // (e.g. a "Clear filter" button, or switching exchange elsewhere in the app).
  useEffect(() => {
    if (!focused && value !== text) setText(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

  const { data } = useQuery({
    queryKey: ["symbols", exchange, text],
    queryFn: () => fetchSymbols(exchange, text),
    enabled: text.length >= 1,
    staleTime: 60_000,
  });

  const bestMatch = useMemo(() => {
    if (!data || data.length === 0) return null;
    const normalizedText = text.trim().toUpperCase();
    return (
      data.find((row) => (row.ticker ?? row.symbol).toUpperCase() === normalizedText) ?? data[0]
    );
  }, [data, text]);

  useEffect(() => {
    if (!focused || !bestMatch || text.trim().length < 1) return;

    const ticker = bestMatch.ticker ?? bestMatch.symbol;
    const selectionKey = `${exchange}:${text}:${bestMatch.symbol}:${ticker}`;
    if (lastAutoSelectionRef.current === selectionKey) return;

    lastAutoSelectionRef.current = selectionKey;
    onSelect(bestMatch.symbol, ticker);
  }, [bestMatch, exchange, focused, onSelect, text]);

  return (
    <div className={cn("relative w-56", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={text}
        placeholder={placeholder ?? "Search symbol..."}
        className="pl-8"
        onChange={(e) => {
          setText(e.target.value.toUpperCase());
          setOpen(true);
        }}
        onFocus={() => {
          setFocused(true);
          setOpen(true);
        }}
        onBlur={() => {
          setFocused(false);
          setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && data && data.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-lg">
          {data.map((row) => (
            <li
              key={row.symbol}
              onMouseDown={() => {
                const ticker = row.ticker ?? row.symbol;
                setText(ticker);
                onSelect(row.symbol, ticker);
                setOpen(false);
              }}
              className="cursor-pointer px-3 py-1.5 text-sm hover:bg-accent"
            >
              <span className="font-medium">{row.ticker ?? row.symbol}</span>
              {row.name && <span className="text-muted-foreground"> — {row.name}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

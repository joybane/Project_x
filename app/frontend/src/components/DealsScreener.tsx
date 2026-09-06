import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchAllDeals, type DealType, type Exchange } from "@/api";
import DealsTable from "./DealsTable";
import { summarizeDeals, sessionNets } from "@/lib/deals";
import { fmtPrice, fmtQty } from "@/lib/format";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function DealsScreener({ exchange, from, to }: { exchange: Exchange; from: string; to: string }) {
  const [type, setType] = useState<DealType | "all">("all");
  const [search, setSearch] = useState("");
  const [side, setSide] = useState("all");
  const [minimum, setMinimum] = useState("");
  const effectiveType = exchange === "bse" ? "block_deals" : type;
  const valid = !!from && !!to && from <= to;
  const query = useQuery({
    queryKey: ["screener-all", exchange, effectiveType, from, to],
    enabled: valid,
    staleTime: 60_000,
    queryFn: async () => {
      const types: DealType[] = effectiveType === "all" ? ["bulk_deals", "block_deals"] : [effectiveType];
      const pages = await Promise.all(types.map(async (dealType) =>
        (await fetchAllDeals(exchange, dealType, from, to)).map((row) => ({ ...row, deal_type: dealType }))));
      return pages.flat();
    },
  });
  const rows = useMemo(() => (query.data ?? []).filter((row) => {
    const text = `${row.symbol} ${row.security_name ?? ""} ${row.client_name ?? ""}`.toLowerCase();
    return text.includes(search.trim().toLowerCase()) &&
      (effectiveType === "short_selling" || side === "all" || row.buy_sell === side) && (row.quantity ?? 0) >= Number(minimum || 0);
  }), [query.data, search, side, minimum, effectiveType]);
  const summary = useMemo(() => summarizeDeals(rows), [rows]);
  // Session net belongs to the complete session, not only the matched participant.
  const nets = useMemo(() => sessionNets(query.data ?? []), [query.data]);
  return <section className="deals-screener">
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm">
      <Select
        aria-label="Screener deal type"
        value={effectiveType}
        onChange={(e) => setType(e.target.value as DealType | "all")}
        className="w-[190px]"
      >
        {exchange === "nse" && <><option value="all">Bulk + block deals</option><option value="bulk_deals">Bulk deals</option></>}
        <option value="block_deals">Block deals</option>{exchange === "nse" && <option value="short_selling">Short selling</option>}
      </Select>
      <Select
        aria-label="Deal side"
        value={side}
        disabled={effectiveType === "short_selling"}
        onChange={(e) => setSide(e.target.value)}
        className="w-[130px]"
      >
        <option value="all">All sides</option><option value="BUY">Buy</option><option value="SELL">Sell</option>
      </Select>
      <label className="flex items-center gap-2 text-muted-foreground">
        Min quantity
        <Input
          aria-label="Minimum deal quantity"
          type="number"
          min={0}
          value={minimum}
          onChange={(e) => setMinimum(e.target.value)}
          className="w-28"
        />
      </label>
      <Input
        className="min-w-[220px] flex-1"
        aria-label="Search deals"
        placeholder="Search symbol, company or client"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Button
        variant="outline"
        size="icon"
        title="Refresh deals"
        aria-label="Refresh deals"
        disabled={query.isFetching || !valid}
        onClick={() => query.refetch()}
      >
        <RefreshCw className={cn("h-4 w-4", query.isFetching && "animate-spin")} />
      </Button>
    </div>
    {!valid ? <p role="alert" className="text-sm text-danger">Choose a valid date range.</p> :
      query.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading all deals in this range...</p> :
      query.isError ? <p role="alert" className="text-sm text-danger">{query.error.message}</p> : <>
      <div className="mb-4 flex flex-wrap gap-x-8 gap-y-2 rounded-lg border border-border bg-card p-3 text-sm" aria-label="Filtered range totals">
        <span className="text-muted-foreground">Trades <b className="ml-1 font-semibold text-foreground tabular-nums">{fmtQty.format(rows.length)}</b></span>
        <span className="text-muted-foreground">Quantity <b className="ml-1 font-semibold text-foreground tabular-nums">{fmtQty.format(summary.quantity)}</b></span>
        {effectiveType !== "short_selling" && <>
          <span className="text-muted-foreground">Buy <b className="ml-1 font-semibold text-success tabular-nums">{fmtQty.format(summary.buy)}</b></span>
          <span className="text-muted-foreground">Sell <b className="ml-1 font-semibold text-danger tabular-nums">{fmtQty.format(summary.sell)}</b></span>
          <span className="text-muted-foreground">Filtered net <b className={cn("ml-1 font-semibold tabular-nums", summary.net >= 0 ? "text-success" : "text-danger")}>{fmtQty.format(summary.net)}</b></span>
          <span className="text-muted-foreground">Weighted price <b className="ml-1 font-semibold text-foreground tabular-nums">{summary.vwap == null ? "--" : fmtPrice.format(summary.vwap)}</b></span>
        </>}
        <span className="text-muted-foreground">Symbol-days <b className="ml-1 font-semibold text-foreground tabular-nums">{fmtQty.format(summary.sessions)}</b></span>
      </div>
      <DealsTable deals={rows} nets={effectiveType === "short_selling" ? undefined : nets} />
    </>}
  </section>;
}

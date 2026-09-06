import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layers, ListFilter } from "lucide-react";
import Sidebar, { type Tab } from "@/components/Sidebar";
import SymbolSearch from "@/components/SymbolSearch";
import PriceChart, { type ChartMarker } from "@/components/PriceChart";
import ChartErrorBoundary from "@/components/ChartErrorBoundary";
import DealsScreener from "@/components/DealsScreener";
import DealsDrawer from "@/components/DealsDrawer";
import IndicatorManager from "@/components/IndicatorManager";
import UpdateMarketButton from "@/components/UpdateMarketButton";
import { loadIndicators, type IndicatorConfig } from "@/lib/indicators";
import "@/hawkeye.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  fetchPrice,
  fetchPriceBefore,
  fetchAllDeals,
  fetchDeliveryFor,
  resolveSymbol,
  type Exchange,
  type DeliverySource,
  type PricePoint,
  type DeliveryPoint,
} from "@/api";

function todayISO(offsetYears = 0) {
  const d = new Date();
  d.setFullYear(d.getFullYear() + offsetYears);
  return d.toISOString().slice(0, 10);
}

export default function App() {
  const [indicators, setIndicators] = useState<IndicatorConfig[]>(loadIndicators);
  const updateIndicators = (value: IndicatorConfig[]) => {
    setIndicators(value);
    try { localStorage.setItem("project-x-indicators-v1", JSON.stringify(value)); } catch { /* Storage can be unavailable. */ }
  };
  const [tab, setTab] = useState<Tab>("stock");
  const [exchange, setExchange] = useState<Exchange>("nse");
  // The human ticker independent of exchange - NSE's query id IS this ticker,
  // but BSE's is a numeric scrip code, so this is what survives an exchange
  // switch and gets re-resolved into whatever id each exchange needs.
  const [symbolLabel, setSymbolLabel] = useState("RELIANCE");
  // Both exchanges' ids for the current ticker are kept resolved at once
  // (rather than just the active exchange's) so the delivery pane can pull
  // from either - or both - independently of which one the candles show.
  const [nseSymbol, setNseSymbol] = useState<string | null>("RELIANCE");
  const [bseSymbol, setBseSymbol] = useState<string | null>(null);
  const [deliverySource, setDeliverySource] = useState<DeliverySource>("nse");
  const [from, setFrom] = useState(todayISO(-1));
  const [to, setTo] = useState(todayISO(0));

  const symbol = exchange === "nse" ? nseSymbol : bseSymbol;

  // Resolve the current ticker on BOTH exchanges whenever it changes, so
  // switching the price chart's exchange never has to wait on a lookup, and
  // the delivery pane can request "both" at any time without extra plumbing.
  useEffect(() => {
    let cancelled = false;
    Promise.all([resolveSymbol("nse", symbolLabel), resolveSymbol("bse", symbolLabel)]).then(
      ([n, b]) => {
        if (cancelled) return;
        setNseSymbol(n);
        setBseSymbol(b);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [symbolLabel]);

  const deliveryQuery = useQuery({
    queryKey: ["delivery", deliverySource, nseSymbol, bseSymbol, from, to],
    queryFn: () => fetchDeliveryFor(deliverySource, nseSymbol, bseSymbol, from, to),
    enabled:
      tab === "stock" &&
      (deliverySource === "both" ? !!(nseSymbol || bseSymbol) : !!symbol),
    placeholderData: (previous) => previous,
  });

  const priceQuery = useQuery({
    queryKey: ["price", exchange, symbol, from, to],
    queryFn: () => fetchPrice(exchange, symbol!, from, to),
    enabled: tab === "stock" && !!symbol,
    // Without this, `data` goes back to `undefined` the instant `from`
    // changes (e.g. the chart's own lazy-load-on-scroll widening it) - since
    // PriceChart is only rendered while `priceQuery.data` is truthy, that
    // briefly unmounts the whole chart and remounts a fresh one once the
    // fetch resolves, which is what was actually causing the vanish/flicker,
    // not anything inside the chart component itself. Keeping the previous
    // page's data visible during the refetch keeps it mounted throughout.
    placeholderData: (previous) => previous,
  });

  // Earlier-history batches prepended by scroll-back, kept separate from
  // priceQuery/deliveryQuery so lazy-loading never re-fetches (or drops) the
  // [from, to] window those own - only appends exactly one fixed-size batch
  // at a time in front of it. Reset whenever the user actually changes what's
  // being viewed (symbol/exchange/date range), as opposed to just scrolling.
  const [earlierPrice, setEarlierPrice] = useState<PricePoint[]>([]);
  const [earlierDelivery, setEarlierDelivery] = useState<DeliveryPoint[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  useEffect(() => {
    setEarlierPrice([]);
    setEarlierDelivery([]);
  }, [exchange, symbol, from, to]);

  // A wide header date range (e.g. "from 2020") can hand back 1000+ rows in
  // one response. Feeding that much straight into the chart's setData() in
  // one shot reliably hits a "Value is null" crash deep in lightweight-charts'
  // own autoscale caching once the total gets into the high hundreds of bars
  // - a real bug in the library (reproduced with clean, deduped, gapless
  // data and zero markers), not something fixable by timing our own calls
  // around it. So priceQuery's own contribution is always capped to its most
  // recent slice - not just on the very first render after a fresh load, but
  // permanently - and earlier history only ever grows through the
  // already-proven 500-row lazy-load batches on top of that. (An earlier
  // version only capped while earlierPrice was still empty; the very first
  // lazy-load batch - which the chart can trigger on its own, right on
  // mount, if the capped window left it near the left edge - flipped that
  // condition and let the *entire* uncapped priceQuery.data back in on the
  // next render, defeating the cap entirely.)
  const CHART_INITIAL_WINDOW = 250;
  const chartPriceData = useMemo(() => {
    const recentBase =
      (priceQuery.data?.length ?? 0) > CHART_INITIAL_WINDOW
        ? priceQuery.data!.slice(-CHART_INITIAL_WINDOW)
        : (priceQuery.data ?? []);
    return [...earlierPrice, ...recentBase];
  }, [earlierPrice, priceQuery.data]);
  const chartDeliveryData = useMemo(() => {
    const earliestChartDate = chartPriceData[0]?.trade_date;
    const fullDelivery = [...earlierDelivery, ...(deliveryQuery.data ?? [])];
    return earliestChartDate ? fullDelivery.filter((d) => d.trade_date >= earliestChartDate) : fullDelivery;
  }, [earlierDelivery, deliveryQuery.data, chartPriceData]);

  // Chart calls this when the user has panned close to the left edge of
  // loaded history. Fetches exactly one batch of 500 earlier candles (clamped
  // to the earliest date either exchange's data goes back to) and prepends
  // it to the accumulated buffer above, instead of widening `from` and
  // re-fetching the whole range from scratch.
  const EARLIEST_DATA_DATE = "1994-01-01";
  const handleNeedEarlierData = async () => {
    if (loadingEarlier || !symbol) return;
    const earliestLoaded = chartPriceData[0]?.trade_date.slice(0, 10) ?? from;
    if (earliestLoaded <= EARLIEST_DATA_DATE) return;
    setLoadingEarlier(true);
    try {
      const batch = await fetchPriceBefore(exchange, symbol, earliestLoaded, 500);
      if (batch.length === 0) return;
      const newEarliest = batch[0].trade_date.slice(0, 10);
      const delivBatch =
        (deliverySource === "both" ? !!(nseSymbol || bseSymbol) : !!symbol)
          ? await fetchDeliveryFor(deliverySource, nseSymbol, bseSymbol, newEarliest, earliestLoaded)
          : [];
      // Both state updates fire back-to-back with no `await` between them, so
      // React batches them into a single re-render - PriceChart's data effect
      // then runs exactly once per lazy-load with the *full* added-bar count
      // (price and delivery together). Applying them from two separate
      // renders (as a naive `setEarlierPrice` right after the price fetch,
      // then `setEarlierDelivery` later) made the second render look like a
      // no-op price update to PriceChart - its viewport-preservation only
      // triggers when bars were actually added, so that second run fell
      // through to fitContent() and snapped the chart back to fit-all,
      // which is what showed up as the chart flickering/jumping to the
      // front while scrolling back.
      setEarlierPrice((prev) => [...batch, ...prev]);
      setEarlierDelivery((prev) => [
        ...delivBatch.filter((d) => d.trade_date.slice(0, 10) < earliestLoaded),
        ...prev,
      ]);
    } finally {
      setLoadingEarlier(false);
    }
  };

  // Bulk/block deals for the symbol currently on the chart, scoped to the
  // visible date range - drives both the chart markers and the drawer's
  // contents when a marker is clicked. BSE has no bulk_deals table at all.
  const stockBulkQuery = useQuery({
    queryKey: ["chart-bulk-all", exchange, symbol, from, to],
    queryFn: () => fetchAllDeals(exchange, "bulk_deals", from, to, symbol!),
    enabled: tab === "stock" && !!symbol && exchange === "nse",
    placeholderData: (previous) => previous,
  });
  const stockBlockQuery = useQuery({
    queryKey: ["chart-block-all", exchange, symbol, from, to],
    queryFn: () => fetchAllDeals(exchange, "block_deals", from, to, symbol!),
    enabled: tab === "stock" && !!symbol,
    placeholderData: (previous) => previous,
  });
  // Short selling is NSE-only and only used by its own indicator (not chart
  // markers, unlike bulk/block), so it's only fetched once that indicator is
  // actually turned on rather than unconditionally alongside the others.
  const shortSellingEnabled = indicators.some((config) => config.key === "short_selling_qty");
  const stockShortQuery = useQuery({
    queryKey: ["chart-short-all", exchange, symbol, from, to],
    queryFn: () => fetchAllDeals(exchange, "short_selling", from, to, symbol!),
    enabled: tab === "stock" && !!symbol && exchange === "nse" && shortSellingEnabled,
    placeholderData: (previous) => previous,
  });
  const bulkDeals = stockBulkQuery.data ?? [];
  const blockDeals = stockBlockQuery.data ?? [];

  // One marker per date+type, even when several individual deals landed on
  // the same day (e.g. two block deals same date/symbol) - duplicate marker
  // times crash the lightweight-charts markers plugin, and the chart only
  // needs to say "there was a deal here", not one dot per row.
  const chartMarkers: ChartMarker[] = useMemo(() => {
    const seen = new Set<string>();
    const out: ChartMarker[] = [];
    for (const [data, type] of [
      [stockBulkQuery.data, "bulk"],
      [stockBlockQuery.data, "block"],
    ] as const) {
      for (const d of data ?? []) {
        const dateStr = d.trade_date.slice(0, 10);
        const key = `${type}:${dateStr}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ dateStr, type });
      }
    }
    return out;
  }, [stockBulkQuery.data, stockBlockQuery.data]);

  const [drawerDate, setDrawerDate] = useState<string | null>(null);


  return (
    <div className="hawkeye-app flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar tab={tab} onChange={setTab} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="workspace-header flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-5">
          <h1 className="text-sm font-semibold tracking-tight">
            {tab === "stock" ? "Stock" : "Deals Screener"}
          </h1>
          <div className="ml-auto flex items-center gap-2">
            <Select value={exchange} onChange={(e) => setExchange(e.target.value as Exchange)}>
              <option value="nse">NSE</option>
              <option value="bse">BSE</option>
            </Select>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-[150px]"
            />
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-[150px]"
            />
            <div className="h-6 w-px bg-border" />
            <UpdateMarketButton />
          </div>
        </header>

        <main className="flex-1 overflow-auto bg-surface p-5">
          {tab === "stock" && (
            <div>
              {/* A folder-tab attached to the box below: same border/fill,
                  rounded top corners, sized to its content rather than
                  spanning full width, overlapping the box's top border by
                  1px so the two read as one continuous shape. */}
              <div className="inline-flex max-w-full flex-wrap items-center gap-3 rounded-t-lg border border-b-0 border-border bg-card p-2">
                <SymbolSearch
                  exchange={exchange}
                  value={symbolLabel}
                  onSelect={(sym, ticker) => {
                    setSymbolLabel(ticker);
                    if (exchange === "nse") setNseSymbol(sym);
                    else setBseSymbol(sym);
                  }}
                />
                <div className="h-6 w-px bg-border" />
                <div className="flex items-center gap-1.5 pr-1 text-sm text-muted-foreground">
                  <Layers className="h-3.5 w-3.5" strokeWidth={2} />
                  <span>Delivery</span>
                  <Select
                    value={deliverySource}
                    onChange={(e) => setDeliverySource(e.target.value as DeliverySource)}
                    className="h-7 text-xs"
                  >
                    <option value="nse">NSE</option>
                    <option value="bse">BSE</option>
                    <option value="both">NSE + BSE</option>
                  </Select>
                </div>
                <Button variant="ghost" size="sm" disabled={!symbol} onClick={() => {
                  const dates = [...bulkDeals, ...blockDeals].map((deal) => deal.trade_date.slice(0, 10)).sort();
                  setDrawerDate(dates.at(-1) ?? to);
                }}><ListFilter className="h-4 w-4" /> Deal activity</Button>
                <IndicatorManager indicators={indicators} onChange={updateIndicators} exchange={exchange} />
              </div>

              <div className="chart-preserved -mt-px rounded-lg rounded-tl-none border border-border bg-card p-3">
                {priceQuery.isLoading && (
                  <p className="p-4 text-sm text-muted-foreground">Loading…</p>
                )}
                {priceQuery.isError && (
                  <p className="p-4 text-sm text-danger">{(priceQuery.error as Error).message}</p>
                )}
                {priceQuery.data && chartPriceData.length === 0 && (
                  <p className="p-4 text-sm text-muted-foreground">
                    No data for {symbolLabel} in this range.
                  </p>
                )}
                {chartPriceData.length > 0 && (
                  <ChartErrorBoundary
                    resetKey={`${exchange}:${symbol}:${from}:${to}`}
                    onReset={() => {
                      // Sheds whatever accumulated scroll-back history was
                      // loaded when the crash happened, back to the safe
                      // capped initial window - the most likely thing to
                      // actually make the retry succeed instead of
                      // immediately crashing again the same way.
                      setEarlierPrice([]);
                      setEarlierDelivery([]);
                    }}
                  >
                    <PriceChart
                      data={chartPriceData}
                      deliveryData={chartDeliveryData}
                      markers={chartMarkers}
                      onDateClick={setDrawerDate}
                      indicators={indicators}
                      bulkDeals={stockBulkQuery.data}
                      blockDeals={stockBlockQuery.data}
                      shortSellingDeals={stockShortQuery.data}
                      bulkSupported={exchange === "nse"}
                      onNeedEarlierData={handleNeedEarlierData}
                    />
                  </ChartErrorBoundary>
                )}
              </div>
            </div>
          )}

          {tab === "deals" && <DealsScreener key={`${exchange}:${from}:${to}`} exchange={exchange} from={from} to={to} />}
        </main>
      </div>

      {drawerDate && symbol && <DealsDrawer
        key={`${exchange}:${symbol}:${drawerDate}`}
        dateStr={drawerDate}
        exchange={exchange}
        symbol={symbol}
        symbolLabel={symbolLabel}
        onClose={() => setDrawerDate(null)}
      />}
    </div>
  );
}

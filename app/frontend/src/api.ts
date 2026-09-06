// Same-origin: the Go server serves this built frontend itself, so no host/port needed.
const BASE = "";

export type Exchange = "nse" | "bse";
export type DealType = "bulk_deals" | "block_deals" | "short_selling";

export interface PricePoint {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DeliveryPoint {
  trade_date: string;
  qty_traded: number;
  deliv_qty: number;
  deliv_pct: number;
}

// "both" merges NSE + BSE delivery for the same underlying stock into one
// combined series (summed volumes, recomputed %) rather than showing two
// separate lines/columns.
export type DeliverySource = "nse" | "bse" | "both";

export interface Deal {
  trade_date: string;
  symbol: string;
  security_name?: string;
  client_name?: string;
  buy_sell?: string;
  quantity?: number;
  price?: number;
}

export interface DealsPage {
  rows: Deal[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

async function getJSON<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") usp.set(k, String(v));
  }
  const res = await fetch(`${BASE}${path}?${usp.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `request failed: ${res.status}`);
  return data as T;
}

export interface SymbolResult {
  symbol: string; // canonical id to query with (NSE: ticker, BSE: numeric scrip code)
  ticker: string | null; // human ticker, when different from `symbol` (BSE)
  name: string | null; // company name, when available (BSE)
}

export function fetchSymbols(exchange: Exchange, q: string): Promise<SymbolResult[]> {
  return getJSON("/api/symbols", { exchange, q });
}

// NSE's canonical id is the ticker itself; BSE's is a numeric scrip code -
// the same human ticker ("RELIANCE") is not a valid query symbol on both
// exchanges. This re-resolves a human ticker into whichever id the target
// exchange actually needs, so switching exchange can carry the "same" stock
// over instead of silently querying a symbol that only existed on the old one.
export async function resolveSymbol(exchange: Exchange, ticker: string): Promise<string | null> {
  if (!ticker) return null;
  const results = await fetchSymbols(exchange, ticker);
  if (results.length === 0) return null;
  const exact = results.find((r) => (r.ticker ?? r.symbol).toUpperCase() === ticker.toUpperCase());
  return (exact ?? results[0]).symbol;
}

export function fetchPrice(exchange: Exchange, symbol: string, from: string, to: string): Promise<PricePoint[]> {
  return getJSON("/api/price", { exchange, symbol, from, to });
}

// Fetches exactly `limit` trading days strictly before `before` (ascending) -
// used for scroll-back lazy loading, one fixed-size batch at a time, instead
// of re-fetching an ever-widening [from, to] range from scratch.
export function fetchPriceBefore(exchange: Exchange, symbol: string, before: string, limit = 500): Promise<PricePoint[]> {
  return getJSON("/api/price", { exchange, symbol, before, limit });
}

function fetchDelivery(exchange: Exchange, symbol: string, from: string, to: string): Promise<DeliveryPoint[]> {
  return getJSON("/api/delivery", { exchange, symbol, from, to });
}

function mergeDelivery(a: DeliveryPoint[], b: DeliveryPoint[]): DeliveryPoint[] {
  const byDate = new Map<string, { qty_traded: number; deliv_qty: number }>();
  for (const row of [...a, ...b]) {
    const prev = byDate.get(row.trade_date) ?? { qty_traded: 0, deliv_qty: 0 };
    byDate.set(row.trade_date, {
      qty_traded: prev.qty_traded + row.qty_traded,
      deliv_qty: prev.deliv_qty + row.deliv_qty,
    });
  }
  return [...byDate.entries()]
    .map(([trade_date, v]) => ({
      trade_date,
      qty_traded: v.qty_traded,
      deliv_qty: v.deliv_qty,
      deliv_pct: v.qty_traded > 0 ? (v.deliv_qty / v.qty_traded) * 100 : 0,
    }))
    .sort((x, y) => x.trade_date.localeCompare(y.trade_date));
}

// nseSymbol/bseSymbol are the two exchange-specific ids already resolved for
// the current ticker (may be null if that exchange doesn't list this stock).
export async function fetchDeliveryFor(
  source: DeliverySource,
  nseSymbol: string | null,
  bseSymbol: string | null,
  from: string,
  to: string
): Promise<DeliveryPoint[]> {
  if (source === "nse") return nseSymbol ? fetchDelivery("nse", nseSymbol, from, to) : [];
  if (source === "bse") return bseSymbol ? fetchDelivery("bse", bseSymbol, from, to) : [];
  const [nse, bse] = await Promise.all([
    nseSymbol ? fetchDelivery("nse", nseSymbol, from, to) : Promise.resolve([]),
    bseSymbol ? fetchDelivery("bse", bseSymbol, from, to) : Promise.resolve([]),
  ]);
  return mergeDelivery(nse, bse);
}

export function fetchDeals(
  exchange: Exchange,
  type: DealType,
  from: string,
  to: string,
  symbol?: string,
  page = 0,
  pageSize?: number
): Promise<DealsPage> {
  return getJSON("/api/deals", { exchange, type, from, to, symbol, page, pageSize });
}

// Fetches every matching row across the whole range (not just one page) for
// screener-style client-side sort/search over the full result set. Requests
// a much larger pageSize than the display-pagination default - a wide date
// range with no symbol filter can match tens of thousands of rows, and at
// 100 rows/page that was several hundred sequential round trips (visibly
// "hanging" for the user). 2000 rows/page cuts that down to a handful.
const SCREENER_PAGE_SIZE = 2000;
export async function fetchAllDeals(exchange: Exchange, type: DealType, from: string, to: string, symbol?: string): Promise<Deal[]> {
  const first = await fetchDeals(exchange, type, from, to, symbol, 0, SCREENER_PAGE_SIZE);
  const rows = [...first.rows];
  // Bound concurrent requests while including every page in range totals.
  for (let page = 1; page < first.totalPages; page += 4) {
    const pages = await Promise.all(Array.from({ length: Math.min(4, first.totalPages - page) }, (_, i) =>
      fetchDeals(exchange, type, from, to, symbol, page + i, SCREENER_PAGE_SIZE)));
    for (const result of pages) rows.push(...result.rows);
  }
  return rows;
}

export interface UpdateStepResult {
  status: "pending" | "running" | "done" | "failed" | "skipped";
  rowsAdded?: number;
  error?: string;
}

export interface UpdateStatus {
  status: "idle" | "running" | "complete" | "failed";
  message: string;
  percent: number;
  startedAt?: string;
  finishedAt?: string;
  steps: Record<string, UpdateStepResult>;
  order: string[];
}

export async function fetchUpdateStatus(): Promise<UpdateStatus> {
  const res = await fetch(`${BASE}/api/update`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `request failed: ${res.status}`);
  return data as UpdateStatus;
}

export async function triggerUpdate(): Promise<UpdateStatus> {
  const res = await fetch(`${BASE}/api/update`, { method: "POST" });
  const data = await res.json();
  if (!res.ok && res.status !== 409) throw new Error(data.error ?? `request failed: ${res.status}`);
  return data as UpdateStatus;
}

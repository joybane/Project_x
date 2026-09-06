import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Search, X } from "lucide-react";
import { fetchAllDeals, type Exchange } from "@/api";
import { fmtPrice, fmtQty } from "@/lib/format";

function earlier(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

// Snaps an arbitrary calendar-picker date to the closest date this symbol
// actually had a deal on - a native <input type="date"> can't restrict which
// individual days are selectable (only a continuous min/max), so instead of
// accepting whatever the picker returns, every change is corrected to the
// nearest real deal date.
function nearestDealDate(target: string, dealDates: string[]): string {
  if (dealDates.length === 0) return target;
  const t = new Date(`${target}T12:00:00Z`).getTime();
  let best = dealDates[0];
  let bestDiff = Infinity;
  for (const candidate of dealDates) {
    const diff = Math.abs(new Date(`${candidate}T12:00:00Z`).getTime() - t);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best;
}

export default function DealsDrawer({ dateStr, exchange, symbol, symbolLabel, onClose }: {
  dateStr: string; exchange: Exchange; symbol: string; symbolLabel: string; onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [from, setFrom] = useState(dateStr);
  const [to, setTo] = useState(dateStr);
  const [view, setView] = useState<"trades" | "net">("trades");
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const valid = !!from && !!to && from <= to;

  // The full set of dates this symbol ever had a deal on, independent of the
  // currently selected from/to window - needed so the date pickers can snap
  // to a real deal date no matter how far the user drags them.
  const dealDatesQuery = useQuery({
    queryKey: ["drawer-deal-dates", exchange, symbol],
    queryFn: async () => {
      const [bulk, block] = await Promise.all([
        exchange === "nse" ? fetchAllDeals(exchange, "bulk_deals", "1990-01-01", "2100-01-01", symbol) : Promise.resolve([]),
        fetchAllDeals(exchange, "block_deals", "1990-01-01", "2100-01-01", symbol),
      ]);
      return [...new Set([...bulk, ...block].map((deal) => deal.trade_date.slice(0, 10)))].sort();
    },
    staleTime: 5 * 60_000,
  });
  const dealDates = dealDatesQuery.data ?? [];
  const snapToDealDate = (picked: string) => (dealDates.length > 0 ? nearestDealDate(picked, dealDates) : picked);

  const query = useQuery({
    queryKey: ["drawer-deals", exchange, symbol, from, to],
    enabled: valid,
    queryFn: async () => {
      const [bulk, block] = await Promise.all([
        exchange === "nse" ? fetchAllDeals(exchange, "bulk_deals", from, to, symbol) : Promise.resolve([]),
        fetchAllDeals(exchange, "block_deals", from, to, symbol),
      ]);
      return [...bulk.map((deal) => ({ ...deal, kind: "Bulk" })),
        ...block.map((deal) => ({ ...deal, kind: "Block" }))]
        .sort((a, b) => b.trade_date.localeCompare(a.trade_date));
    },
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input, select, [tabindex="0"]'
      ) ?? []);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);

  const rows = useMemo(() => (query.data ?? []).filter((deal) =>
    (kind === "all" || deal.kind === kind) &&
    (deal.client_name ?? "Unknown client").toLowerCase().includes(search.trim().toLowerCase())
  ), [query.data, kind, search]);
  const summary = useMemo(() => {
    const clients = new Map<string, { client: string; buy: number; sell: number; count: number }>();
    let buy = 0, sell = 0, unknown = 0;
    for (const deal of rows) {
      const qty = deal.quantity ?? 0;
      const client = deal.client_name?.trim() || "Unknown client";
      const entry = clients.get(client) ?? { client, buy: 0, sell: 0, count: 0 };
      if (deal.buy_sell === "BUY") { buy += qty; entry.buy += qty; }
      else if (deal.buy_sell === "SELL") { sell += qty; entry.sell += qty; }
      else unknown++;
      entry.count++;
      clients.set(client, entry);
    }
    return { buy, sell, unknown, clients: [...clients.values()].sort((a, b) =>
      Math.abs(b.buy - b.sell) - Math.abs(a.buy - a.sell) || a.client.localeCompare(b.client)) };
  }, [rows]);
  const count = view === "trades" ? rows.length : summary.clients.length;
  const pages = Math.max(1, Math.ceil(count / 20));
  const currentPage = Math.min(page, pages - 1);
  const start = currentPage * 20;
  const ready = valid && query.isSuccess;
  const changeRange = (days: number) => { setFrom(earlier(dateStr, days)); setTo(dateStr); setPage(0); };
  const signed = (value: number) => `${value > 0 ? "+" : ""}${fmtQty.format(value)}`;

  return (
    <div className="deals-overlay">
      <div className="deals-backdrop" onClick={onClose} />
      <aside ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="deals-title"
        className={`deals-panel ${expanded ? "deals-panel-expanded" : ""}`}>
        <header className="deals-heading">
          <div className="min-w-0"><div className="deals-eyebrow">{exchange.toUpperCase()} / DEAL ACTIVITY</div><h2 id="deals-title">{symbolLabel}</h2></div>
          <div className="deals-actions">
            <button className="deals-icon" title={expanded ? "Restore side panel" : "Expand to full screen"}
              aria-label={expanded ? "Restore side panel" : "Expand to full screen"} onClick={() => setExpanded(!expanded)}>
              {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
            <button className="deals-icon" title="Close" aria-label="Close deal activity" onClick={onClose}><X size={20} /></button>
          </div>
        </header>
        <div className="deals-controls">
          <div className="deals-range">
            <label>From<input aria-label="Deals from date" type="date" value={from}
              min={dealDates[0]} max={to || dealDates.at(-1)} list="deal-dates-list"
              onChange={(e) => { setFrom(snapToDealDate(e.target.value)); setPage(0); }} /></label>
            <label>Through<input aria-label="Deals through date" type="date" value={to}
              min={from || dealDates[0]} max={dealDates.at(-1)} list="deal-dates-list"
              onChange={(e) => { setTo(snapToDealDate(e.target.value)); setPage(0); }} /></label>
            {/* Hints supporting browsers to mark actual deal dates on the native picker; the
                onChange snap above is what actually enforces it everywhere else. */}
            <datalist id="deal-dates-list">
              {dealDates.map((d) => <option key={d} value={d} />)}
            </datalist>
          </div>
          <div className="deals-presets">
            {[{ label: "Selected day", days: 0 }, { label: "7 days", days: 6 }, { label: "30 days", days: 29 }, { label: "90 days", days: 89 }].map(({ label, days }) =>
              <button key={days} aria-pressed={from === earlier(dateStr, days) && to === dateStr} onClick={() => changeRange(days)}>{label}</button>)}
          </div>
        </div>
        <div className="deals-metrics">
          <div><span>Buy quantity</span><strong className="deals-positive">{ready ? fmtQty.format(summary.buy) : "--"}</strong></div>
          <div><span>Sell quantity</span><strong className="deals-negative">{ready ? fmtQty.format(summary.sell) : "--"}</strong></div>
          <div><span>Net quantity</span><strong className={summary.buy - summary.sell >= 0 ? "deals-positive" : "deals-negative"}>{ready ? signed(summary.buy - summary.sell) : "--"}</strong></div>
        </div>
        <div className="deals-toolbar">
          <div className="deals-tabs" role="group" aria-label="Deal view">
            <button aria-pressed={view === "trades"} onClick={() => { setView("trades"); setPage(0); }}>All trades</button>
            <button aria-pressed={view === "net"} onClick={() => { setView("net"); setPage(0); }}>Net by client</button>
          </div>
          <select aria-label="Deal type" value={kind} onChange={(e) => { setKind(e.target.value); setPage(0); }}>
            <option value="all">All types</option>{exchange === "nse" && <option value="Bulk">Bulk deals</option>}<option value="Block">Block deals</option>
          </select>
          <label className="deals-search"><Search size={15} /><input aria-label="Search clients" placeholder="Search clients" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} /></label>
        </div>
        <div className="deals-grid" aria-busy={valid && query.isPending}>
          {!valid ? <div className="deals-state" role="alert">Choose a valid date range.</div>
            : query.isPending ? <div className="deals-state" role="status">Loading deal activity...</div>
            : query.isError ? <div className="deals-state" role="alert">Could not load deals.<p>{query.error.message}</p><button onClick={() => query.refetch()}>Retry</button></div>
            : count === 0 ? <div className="deals-state">No deals match this range and filters.</div>
            : view === "trades" ? <table>
              <thead><tr><th>Date / type</th><th>Client</th><th>Side</th><th className="numeric">Quantity</th><th className="numeric">Price</th></tr></thead>
              <tbody>{rows.slice(start, start + 20).map((deal, i) => <tr key={start + i}>
                <td className="deals-date">{deal.trade_date.slice(0, 10)}<small>{deal.kind}</small></td>
                <td className="deals-client">{deal.client_name || "Unknown client"}</td>
                <td><span className={deal.buy_sell === "BUY" ? "deals-side deals-buy" : deal.buy_sell === "SELL" ? "deals-side deals-sell" : "deals-side"}>{deal.buy_sell || "--"}</span></td>
                <td className="numeric">{deal.quantity == null ? "--" : fmtQty.format(deal.quantity)}</td>
                <td className="numeric">{deal.price == null ? "--" : fmtPrice.format(deal.price)}</td>
              </tr>)}</tbody>
            </table> : <table>
              <thead><tr><th>Client</th><th className="numeric">Bought</th><th className="numeric">Sold</th><th className="numeric">Net qty</th></tr></thead>
              <tbody>{summary.clients.slice(start, start + 20).map((client) => <tr key={client.client}>
                <td className="deals-client">{client.client}<small>{client.count} trades</small></td>
                <td className="numeric">{fmtQty.format(client.buy)}</td><td className="numeric">{fmtQty.format(client.sell)}</td>
                <td className={`numeric ${client.buy >= client.sell ? "deals-positive" : "deals-negative"}`}>{signed(client.buy - client.sell)}</td>
              </tr>)}</tbody>
            </table>}
        </div>
        <footer className="deals-footer">
          <div><span>{ready && count > 0 ? `${start + 1}-${Math.min(start + 20, count)} of ${fmtQty.format(count)} ${view === "trades" ? "trades" : "clients"}` : "0 results"}</span>
            <small>Net = reported buys - sells{search || kind !== "all" ? " (filtered)" : ""}{ready && summary.unknown > 0 ? `; ${summary.unknown} unclassified trades excluded` : ""}</small></div>
          <div className="deals-actions">
            <button className="deals-icon" title="Previous page" aria-label="Previous page" disabled={!ready || currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={18} /></button>
            <span className="deals-page">{currentPage + 1} / {pages}</span>
            <button className="deals-icon" title="Next page" aria-label="Next page" disabled={!ready || currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}><ChevronRight size={18} /></button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

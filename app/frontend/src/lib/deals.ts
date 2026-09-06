import type { Deal } from "../api";

// Hawkeye's weighted-price calculation counts only rows with a known price.
export function summarizeDeals(rows: Deal[]) {
  let buy = 0, sell = 0, quantity = 0, notional = 0, pricedQuantity = 0;
  const sessions = new Set<string>();
  for (const row of rows) {
    const qty = Number.isFinite(row.quantity) ? row.quantity! : 0;
    quantity += qty;
    if (row.buy_sell === "BUY") buy += qty;
    if (row.buy_sell === "SELL") sell += qty;
    if (row.price != null && Number.isFinite(row.price)) {
      notional += row.price * qty;
      pricedQuantity += qty;
    }
    sessions.add(`${row.symbol}:${row.trade_date.slice(0, 10)}`);
  }
  return { buy, sell, net: buy - sell, quantity, vwap: pricedQuantity > 0 ? notional / pricedQuantity : null, sessions: sessions.size };
}

export function sessionNets(rows: Deal[]) {
  const result = new Map<string, number>();
  for (const row of rows) {
    if (row.buy_sell !== "BUY" && row.buy_sell !== "SELL") continue;
    const key = `${row.symbol}:${row.trade_date.slice(0, 10)}`;
    result.set(key, (result.get(key) ?? 0) + (row.quantity ?? 0) * (row.buy_sell === "BUY" ? 1 : -1));
  }
  return result;
}

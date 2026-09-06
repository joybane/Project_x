import type { Deal } from "../api";

export type AverageMethod = "SMA" | "EMA" | "WMA" | "Median";
export const indicatorOptions = [
  { key: "price_average", label: "Price average", color: "#e8c25c" },
  { key: "volume", label: "Volume average", color: "#6fae8b" },
  { key: "delivery_pct", label: "Delivery percentage average", color: "#b98fd0" },
  { key: "delivery_qty", label: "Delivery quantity average", color: "#16b8e6" },
  { key: "rsi", label: "RSI", color: "#a878cc" },
  { key: "bulk_net_qty", label: "Bulk deals net quantity", color: "#d287b0" },
  { key: "block_net_qty", label: "Block deals net quantity", color: "#9d8ad8" },
  { key: "deal_net_qty", label: "Combined deals net quantity", color: "#62b49a" },
  { key: "short_selling_qty", label: "Short selling quantity", color: "#e5615c" },
] as const;
export type IndicatorKey = typeof indicatorOptions[number]["key"];
export interface IndicatorConfig { id: string; key: IndicatorKey; method: AverageMethod; period: number; color: string; }

// Adapted from Hawkeye/app/market-chart.tsx: preserve its averaging conventions.
export function rolling(values: Array<number | null>, period: number, method: AverageMethod): Array<number | null> {
  if (!Number.isInteger(period) || period < 2) return values.map(() => null);
  const result: Array<number | null> = [];
  let ema: number | null = null;
  const alpha = 2 / (period + 1);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === null || !Number.isFinite(value)) { result.push(null); continue; }
    if (method === "EMA") {
      ema = ema === null ? value : value * alpha + ema * (1 - alpha);
      result.push(index + 1 >= period ? ema : null);
      continue;
    }
    const window = values.slice(Math.max(0, index - period + 1), index + 1)
      .filter((item): item is number => item !== null && Number.isFinite(item));
    if (window.length < period) result.push(null);
    else if (method === "WMA") result.push(window.reduce((sum, item, i) => sum + item * (i + 1), 0) / (period * (period + 1) / 2));
    else if (method === "Median") {
      const sorted = [...window].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
      result.push(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
    } else result.push(window.reduce((sum, item) => sum + item, 0) / period);
  }
  return result;
}

export function rsi(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 2 || values.length <= period) return output;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1]; gain += Math.max(change, 0); loss += Math.max(-change, 0);
  }
  gain /= period; loss /= period;
  const value = () => gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  output[period] = value();
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    output[i] = value();
  }
  return output;
}

export function dailyNet(deals: Deal[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const deal of deals) {
    if (deal.quantity == null || !Number.isFinite(deal.quantity) || !["BUY", "SELL"].includes(deal.buy_sell ?? "")) continue;
    const date = deal.trade_date.slice(0, 10);
    result.set(date, (result.get(date) ?? 0) + deal.quantity * (deal.buy_sell === "BUY" ? 1 : -1));
  }
  return result;
}

// Short selling has no buy/sell side (it's its own one-directional feed), so
// this sums the day's raw quantity instead of netting a direction like
// dailyNet does for bulk/block deals.
export function dailySum(deals: Deal[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const deal of deals) {
    if (deal.quantity == null || !Number.isFinite(deal.quantity)) continue;
    const date = deal.trade_date.slice(0, 10);
    result.set(date, (result.get(date) ?? 0) + deal.quantity);
  }
  return result;
}

export function loadIndicators(): IndicatorConfig[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem("project-x-indicators-v1") ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter((item): item is IndicatorConfig => item && typeof item.id === "string" &&
      indicatorOptions.some((option) => option.key === item.key) && ["SMA", "EMA", "WMA", "Median"].includes(item.method) &&
      Number.isInteger(item.period) && item.period >= 2 && item.period <= 252 && /^#[0-9a-f]{6}$/i.test(item.color));
  } catch { return []; }
}

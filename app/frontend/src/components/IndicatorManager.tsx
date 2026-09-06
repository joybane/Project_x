import { useEffect, useRef, useState } from "react";
import { ChartLine, ChevronDown, X } from "lucide-react";
import { indicatorOptions, type AverageMethod, type IndicatorConfig } from "@/lib/indicators";

export default function IndicatorManager({ indicators, onChange, exchange }: {
  indicators: IndicatorConfig[]; onChange: (value: IndicatorConfig[]) => void; exchange: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); root.current?.querySelector("button")?.focus(); }
    };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="indicator-manager" ref={root}>
    <button className="indicator-trigger" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
      <ChartLine size={15} /> Indicators <span>{indicators.length}</span><ChevronDown size={13} />
    </button>
    {open && <div className="indicator-pop" role="dialog" aria-label="Indicators">
      <header><strong>Indicators</strong><button title="Close indicators" aria-label="Close indicators" onClick={() => setOpen(false)}><X size={16} /></button></header>
      <div className="indicator-options">{indicatorOptions.filter((option) => exchange === "nse" || !["bulk_net_qty", "short_selling_qty"].includes(option.key)).map((option) =>
        <label key={option.key}><input type="checkbox" checked={indicators.some((item) => item.key === option.key)} onChange={(event) => onChange(event.target.checked
          ? [...indicators, { id: crypto.randomUUID(), key: option.key, color: option.color, method: "SMA", period: option.key === "rsi" ? 14 : 20 }]
          : indicators.filter((item) => item.key !== option.key))} />{option.label}</label>)}</div>
      {indicators.length > 0 && <div className="indicator-list">{indicators.map((item) => {
        const label = indicatorOptions.find((option) => option.key === item.key)!.label;
        const update = (patch: Partial<IndicatorConfig>) => onChange(indicators.map((entry) => entry.id === item.id ? { ...entry, ...patch } : entry));
        return <div className="indicator-row" key={item.id}>
          <strong>{label}</strong>
          <input type="color" title={`${label} color`} aria-label={`${label} color`} value={item.color} onChange={(e) => update({ color: e.target.value })} />
          {item.key !== "rsi" && <select aria-label={`${label} method`} value={item.method} onChange={(e) => update({ method: e.target.value as AverageMethod })}>
            {["SMA", "EMA", "WMA", "Median"].map((method) => <option key={method}>{method}</option>)}
          </select>}
          <label>Period <input type="number" aria-label={`${label} period`} min={2} max={252} value={item.period} onChange={(e) => {
            if (e.target.value) update({ period: Math.max(2, Math.min(252, Math.round(Number(e.target.value)))) });
          }} /></label>
          <button title={`Remove ${label}`} aria-label={`Remove ${label}`} onClick={() => onChange(indicators.filter((entry) => entry.id !== item.id))}><X size={15} /></button>
        </div>;
      })}</div>}
    </div>}
  </div>;
}

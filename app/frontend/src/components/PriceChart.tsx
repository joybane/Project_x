import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Deal, DeliveryPoint, PricePoint } from "@/api";
import { dailyNet, dailySum, indicatorOptions, rolling, rsi, type IndicatorConfig } from "@/lib/indicators";
import { fmtPrice, fmtQty } from "@/lib/format";

// Dashed white boxes drawn over sustained low-volume stretches in the volume
// pane, so a quiet patch is easy to spot at a glance rather than just reading
// as "shorter bars" among everything else.
interface LowVolumeRange {
  from: UTCTimestamp;
  to: UTCTimestamp;
  peakVolume: number; // tallest bar within this specific stretch
}

class LowVolumeBoxesPrimitive implements ISeriesPrimitive<Time> {
  ranges: LowVolumeRange[];
  private chart: IChartApi;
  private volumeSeries: ISeriesApi<"Histogram">;
  private getPaneHeight: () => number;

  constructor(
    ranges: LowVolumeRange[],
    chart: IChartApi,
    volumeSeries: ISeriesApi<"Histogram">,
    getPaneHeight: () => number
  ) {
    this.ranges = ranges;
    this.chart = chart;
    this.volumeSeries = volumeSeries;
    this.getPaneHeight = getPaneHeight;
  }

  paneViews(): IPrimitivePaneView[] {
    return [
      {
        renderer: () => ({
          draw: (target: import("fancy-canvas").CanvasRenderingTarget2D) => {
            target.useMediaCoordinateSpace(({ context }) => {
              const ts = this.chart.timeScale();
              const height = this.getPaneHeight();
              context.save();
              context.strokeStyle = "rgba(255, 255, 255, 0.6)";
              context.lineWidth = 1;
              context.setLineDash([4, 3]);
              for (const r of this.ranges) {
                const x1 = ts.timeToCoordinate(r.from);
                const x2 = ts.timeToCoordinate(r.to);
                if (x1 === null || x2 === null) continue;
                const barWidth = ts.options().barSpacing;
                const left = Math.min(x1, x2) - barWidth / 2;
                const width = Math.abs(x2 - x1) + barWidth;
                const peakY = this.volumeSeries.priceToCoordinate(r.peakVolume * 1.25);
                const top = Math.max(peakY ?? 3, 3);
                context.strokeRect(left, top, width, Math.max(height - top - 3, 0));
              }
              context.restore();
            });
          },
        }),
      },
    ];
  }
}

export interface ChartMarker {
  dateStr: string; // "YYYY-MM-DD"
  type: "bulk" | "block";
}

const MARKER_COLOR = "#4f9dde";

// Custom-drawn in place of lightweight-charts' own markers plugin: that
// plugin snapshots each marker's Time as a bar INDEX the first time it's
// positioned, and only recomputes it when its internal `recalculationRequired`
// flag happens to be set - across enough interactive zoom/pan it silently
// goes stale (no error, the marker's index just no longer matches the right
// bar) and the marker stops being found/drawn at all. Computing x/y fresh
// from the time scale on every paint call, like LowVolumeBoxesPrimitive
// above, sidesteps that caching bug entirely - markers always reflect the
// current zoom, never vanish.
class MarkerDotsPrimitive implements ISeriesPrimitive<Time> {
  markers: ChartMarker[];
  private chart: IChartApi;
  private candleSeries: ISeriesApi<"Candlestick">;
  private getHighLow: (dateStr: string) => { high: number; low: number } | undefined;

  constructor(
    markers: ChartMarker[],
    chart: IChartApi,
    candleSeries: ISeriesApi<"Candlestick">,
    getHighLow: (dateStr: string) => { high: number; low: number } | undefined
  ) {
    this.markers = markers;
    this.chart = chart;
    this.candleSeries = candleSeries;
    this.getHighLow = getHighLow;
  }

  paneViews(): IPrimitivePaneView[] {
    return [
      {
        renderer: () => ({
          draw: (target: import("fancy-canvas").CanvasRenderingTarget2D) => {
            target.useMediaCoordinateSpace(({ context }) => {
              const ts = this.chart.timeScale();
              context.save();
              context.font = "600 9px -apple-system, BlinkMacSystemFont, sans-serif";
              context.textAlign = "center";
              for (const marker of this.markers) {
                const x = ts.timeToCoordinate(toTimestamp(marker.dateStr));
                if (x === null) continue;
                const hl = this.getHighLow(marker.dateStr);
                if (!hl) continue;
                const isBlock = marker.type === "block";
                const barY = this.candleSeries.priceToCoordinate(isBlock ? hl.high : hl.low);
                if (barY === null) continue;
                const y = isBlock ? barY - 12 : barY + 12;
                context.beginPath();
                context.arc(x, y, 4, 0, Math.PI * 2);
                context.fillStyle = MARKER_COLOR;
                context.fill();
                context.fillStyle = MARKER_COLOR;
                context.textBaseline = isBlock ? "bottom" : "top";
                context.fillText(isBlock ? "BO" : "BL", x, isBlock ? y - 6 : y + 6);
              }
              context.restore();
            });
          },
        }),
      },
    ];
  }
}

const DELIV_HIGH = "#3ddc97"; // >= 50% delivery - fresh emerald
const DELIV_LOW = "#f5a623"; // < 50% delivery - warm gold

// Dim, desaturated anchor colors (quiet volume) and vivid, punchy anchors
// (loud volume) - bars are interpolated between these by relative volume, so
// a big day actually reads as a bright red/green, not just a less-transparent
// version of the same muted tone.
const VOL_UP_DIM = [31, 74, 66]; // #1f4a42
const VOL_UP_BRIGHT = [0, 230, 118]; // #00e676
const VOL_DOWN_DIM = [74, 36, 34]; // #4a2422
const VOL_DOWN_BRIGHT = [255, 82, 82]; // #ff5252

function lerpColor(a: number[], b: number[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const [r, g, bch] = a.map((c, i) => Math.round(c + (b[i] - c) * clamped));
  return `rgb(${r}, ${g}, ${bch})`;
}

function toTimestamp(dateStr: string): UTCTimestamp {
  // "2024-01-01 00:00:00" -> treat as UTC date-only
  return (Date.parse(dateStr.slice(0, 10) + "T00:00:00Z") / 1000) as UTCTimestamp;
}

// Arms suppressEdgeCheckRef for one programmatic range change, with a safety
// timeout as a backstop: if the requested range happens to already equal the
// current one, the library never fires a change event to consume/clear the
// flag on its own, which would otherwise leave real edge-panning silently
// ignored forever after.
function armSuppressEdgeCheck(ref: { current: boolean }) {
  ref.current = true;
  setTimeout(() => {
    ref.current = false;
  }, 150);
}

function fromTime(time: Time): string {
  return new Date((time as UTCTimestamp) * 1000).toISOString().slice(0, 10);
}

// A small floating readout, styled to match the app's popover/card language,
// pinned inside one pane and following the crosshair's x position.
function makeTooltip(container: HTMLElement): HTMLDivElement {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.zIndex = "5";
  el.style.pointerEvents = "none";
  el.style.display = "none";
  el.style.padding = "6px 9px";
  el.style.borderRadius = "6px";
  el.style.border = "1px solid #303032";
  el.style.background = "rgba(27, 30, 41, 0.92)";
  el.style.color = "#e6e8ee";
  el.style.fontSize = "12px";
  el.style.lineHeight = "1.5";
  el.style.whiteSpace = "nowrap";
  el.style.fontVariantNumeric = "tabular-nums";
  container.appendChild(el);
  return el;
}

interface PriceChartProps {
  data: PricePoint[];
  deliveryData: DeliveryPoint[];
  markers?: ChartMarker[];
  onDateClick?: (dateStr: string) => void;
  indicators: IndicatorConfig[];
  bulkDeals?: Deal[];
  blockDeals?: Deal[];
  shortSellingDeals?: Deal[];
  bulkSupported: boolean;
  // Called when the user has panned/scrolled close to the left edge of the
  // currently loaded history. The caller is expected to widen its `from`
  // date and let new, longer `data` flow back in - this component then
  // preserves the viewport across that change instead of re-fitting, so
  // panning further back doesn't visually jump.
  onNeedEarlierData?: () => void;
}

export default function PriceChart(props: PriceChartProps) {
  const { data, deliveryData, markers = [], indicators, bulkDeals, blockDeals, shortSellingDeals, bulkSupported } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    candles: ISeriesApi<"Candlestick">;
    volume: ISeriesApi<"Histogram">;
    delivery: ISeriesApi<"Histogram">;
    markerDots: MarkerDotsPrimitive;
    lowVolumeBoxes: LowVolumeBoxesPrimitive;
  } | null>(null);

  // Callback props change reference on every parent render even when their
  // behavior hasn't; reading them via a ref inside handlers set up once (on
  // mount) means those handlers always see the current callback without the
  // mount effect needing to depend on - and therefore rerun for - them.
  const onDateClickRef = useRef(props.onDateClick);
  const onNeedEarlierDataRef = useRef(props.onNeedEarlierData);
  const markerDatesRef = useRef<Set<string>>(new Set());
  const deliveryByDateRef = useRef<Map<string, DeliveryPoint>>(new Map());
  const highLowByDateRef = useRef<Map<string, { high: number; low: number }>>(new Map());
  useEffect(() => {
    onDateClickRef.current = props.onDateClick;
    onNeedEarlierDataRef.current = props.onNeedEarlierData;
  });

  // Preserves the viewport across a lazy-load-triggered data change instead
  // of re-fitting to it, so panning back for more history doesn't visually
  // jump. Set right before calling onNeedEarlierData; consumed and cleared
  // the next time the data effect below runs.
  const pendingLazyLoadRef = useRef(false);
  const lastVisibleRangeRef = useRef<{ from: number; to: number } | null>(null);
  const lastDataLengthRef = useRef(0);
  // A programmatic range change we make ourselves (fitContent() showing a
  // small dataset in full, in particular) naturally lands range.from at or
  // near 0 - which looks identical to the user having panned to the left
  // edge. Left unguarded, that auto-triggers a lazy-load the instant the
  // chart mounts (nobody panned anywhere), which was itself what pushed the
  // total bar count back into the range that crashes the library's autoscale
  // (see below). Set right before we change the range ourselves; the next
  // visibleRangeChange event (that change taking effect) consumes and clears
  // it rather than treating it as a real pan.
  const suppressEdgeCheckRef = useRef(false);
  // Holds the pending deferred range-adjustment timer (see below) so a new
  // run of the data-update effect can cancel and replace it instead of
  // letting several stack up and race each other.
  const rangeAdjustTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Chart + base series are created exactly once and never torn down for a
  // data update - only for real unmount. Every previous version of this
  // component recreated the whole chart (and therefore its <canvas>) on every
  // data change, which is what caused the vanish-and-reappear flash while
  // panning triggered lazy-loads: destroying and rebuilding a canvas is
  // inherently a blank-frame operation, however fast. Updates now flow
  // through .setData() on these persistent series instead.
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    container.style.position = "relative";

    const chart = createChart(container, {
      width: container.clientWidth,
      // Matches the indicators effect's base case (no extra indicator panes
      // yet) - that effect runs right after this one on mount and corrects
      // this the moment any indicators are already active.
      height: 780,
      layout: { background: { color: "#212123" }, textColor: "#9c9c9a" },
      grid: {
        vertLines: { color: "#3a3a3d" },
        horzLines: { color: "#3a3a3d" },
      },
      timeScale: { timeVisible: false, borderColor: "#303032" },
      rightPriceScale: { borderColor: "#303032" },
    });
    chartRef.current = chart;

    const candles = chart.addSeries(
      CandlestickSeries,
      {
        upColor: "#26a69a",
        downColor: "#ef5350",
        borderVisible: false,
        wickUpColor: "#26a69a",
        wickDownColor: "#ef5350",
      },
      0
    );
    const volume = chart.addSeries(HistogramSeries, { color: "#8a7245", priceFormat: { type: "volume" } }, 1);
    const delivery = chart.addSeries(HistogramSeries, { color: DELIV_HIGH, priceFormat: { type: "percent" } }, 2);
    const markerDots = new MarkerDotsPrimitive([], chart, candles, (dateStr) => highLowByDateRef.current.get(dateStr));
    candles.attachPrimitive(markerDots);
    const lowVolumeBoxes = new LowVolumeBoxesPrimitive([], chart, volume, () => chart.panes()[1]?.getHeight() ?? 0);
    volume.attachPrimitive(lowVolumeBoxes);

    seriesRef.current = { candles, volume, delivery, markerDots, lowVolumeBoxes };

    const clickHandler = (param: MouseEventParams<Time>) => {
      if (!param.time || !onDateClickRef.current) return;
      const dateStr = fromTime(param.time);
      if (markerDatesRef.current.has(dateStr)) onDateClickRef.current(dateStr);
    };
    chart.subscribeClick(clickHandler);

    // Three small floating readouts, one per pane, all showing the same
    // hovered date but each pinned inside its own pane's vertical band -
    // price info over the price pane, volume over volume, delivery over
    // delivery - rather than one tooltip clumped in a single spot.
    const priceTip = makeTooltip(container);
    const volumeTip = makeTooltip(container);
    const deliveryTip = makeTooltip(container);
    const paneTopOf = (i: number) => {
      let top = 0;
      const panes = chart.panes();
      for (let p = 0; p < i; p++) top += panes[p].getHeight() + 4; // +separator
      return top;
    };
    const positionTip = (el: HTMLDivElement, paneIndex: number, x: number) => {
      const containerWidth = container.clientWidth;
      const tipWidth = el.offsetWidth || 160;
      const left = Math.min(Math.max(x + 12, 4), containerWidth - tipWidth - 4);
      el.style.left = `${left}px`;
      el.style.top = `${paneTopOf(paneIndex) + 8}px`;
    };

    const crosshairHandler = (param: MouseEventParams<Time>) => {
      if (!param.time || !param.point) {
        priceTip.style.display = "none";
        volumeTip.style.display = "none";
        deliveryTip.style.display = "none";
        return;
      }
      const dateStr = fromTime(param.time);
      const candle = param.seriesData.get(candles) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      const vol = param.seriesData.get(volume) as { value: number } | undefined;
      const deliv = deliveryByDateRef.current.get(dateStr);

      if (candle) {
        const up = candle.close >= candle.open;
        priceTip.innerHTML = `<div style="color:#9c9c9a">${dateStr}</div>
          <div>O <b style="color:${up ? "#26a69a" : "#ef5350"}">${fmtPrice.format(candle.open)}</b>
          &nbsp;H <b style="color:${up ? "#26a69a" : "#ef5350"}">${fmtPrice.format(candle.high)}</b>
          &nbsp;L <b style="color:${up ? "#26a69a" : "#ef5350"}">${fmtPrice.format(candle.low)}</b>
          &nbsp;C <b style="color:${up ? "#26a69a" : "#ef5350"}">${fmtPrice.format(candle.close)}</b></div>`;
        priceTip.style.display = "block";
        positionTip(priceTip, 0, param.point.x);
      }
      if (vol) {
        volumeTip.innerHTML = `Volume&nbsp; <b style="color:#c7ab74">${fmtQty.format(vol.value)}</b>`;
        volumeTip.style.display = "block";
        positionTip(volumeTip, 1, param.point.x);
      } else {
        volumeTip.style.display = "none";
      }
      if (deliv) {
        const color = deliv.deliv_pct >= 50 ? DELIV_HIGH : DELIV_LOW;
        deliveryTip.innerHTML = `Delivery&nbsp; <b style="color:${color}">${deliv.deliv_pct.toFixed(2)}%</b>
          &nbsp;<span style="color:#9c9c9a">(${fmtQty.format(deliv.deliv_qty)} / ${fmtQty.format(deliv.qty_traded)})</span>`;
        deliveryTip.style.display = "block";
        positionTip(deliveryTip, 2, param.point.x);
      } else {
        deliveryTip.style.display = "none";
      }
    };
    chart.subscribeCrosshairMove(crosshairHandler);

    const visibleRangeHandler = () => {
      if (suppressEdgeCheckRef.current) {
        suppressEdgeCheckRef.current = false;
        return;
      }
      if (!onNeedEarlierDataRef.current || pendingLazyLoadRef.current) return;
      const range = chart.timeScale().getVisibleLogicalRange();
      // Within ~15 bars of the oldest loaded bar: near enough to the left
      // edge that the user will hit the end of data in a moment or two of
      // continued panning, so fetch more now rather than waiting for that.
      if (range && range.from < 15) {
        pendingLazyLoadRef.current = true;
        onNeedEarlierDataRef.current();
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(visibleRangeHandler);

    // A window resize event only fires for actual browser-window size changes.
    // Collapsing the sidebar resizes this container via flexbox with the
    // window itself untouched, so the chart never saw it and kept rendering
    // at its old (now too-narrow) width, leaving a gap on the right.
    // ResizeObserver reacts to the container's own box size instead.
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.unsubscribeClick(clickHandler);
      chart.unsubscribeCrosshairMove(crosshairHandler);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(visibleRangeHandler);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceTip.remove();
      volumeTip.remove();
      deliveryTip.remove();
    };
    // Mount/unmount only - see the comment above this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pushes new data into the already-existing series whenever it changes,
  // without touching the chart or canvas at all - this is what actually
  // updates the chart on a lazy-load, a symbol switch, or a date range edit.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    const candleData = data.map((d) => ({
      time: toTimestamp(d.trade_date),
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
    }));
    const maxVolume = Math.max(...data.map((d) => d.volume), 1);
    const volumeData = data.map((d) => {
      const intensity = Math.max(0.1, Math.min(1, d.volume / maxVolume));
      const up = d.close >= d.open;
      return {
        time: toTimestamp(d.trade_date),
        value: d.volume,
        color: lerpColor(up ? VOL_UP_DIM : VOL_DOWN_DIM, up ? VOL_UP_BRIGHT : VOL_DOWN_BRIGHT, intensity),
      };
    });

    const lowVolumeThreshold = maxVolume * 0.25;
    const MIN_RUN_DAYS = 4;
    const significantLowRanges: LowVolumeRange[] = [];
    let runStart: UTCTimestamp | null = null;
    let runEnd: UTCTimestamp | null = null;
    let runLength = 0;
    let runPeak = 0;
    const flushRun = () => {
      if (runStart !== null && runEnd !== null && runLength >= MIN_RUN_DAYS) {
        significantLowRanges.push({ from: runStart, to: runEnd, peakVolume: runPeak });
      }
      runStart = null;
      runEnd = null;
      runLength = 0;
      runPeak = 0;
    };
    for (const d of data) {
      const t = toTimestamp(d.trade_date);
      if (d.volume < lowVolumeThreshold) {
        if (runStart === null) runStart = t;
        runEnd = t;
        runLength += 1;
        runPeak = Math.max(runPeak, d.volume);
      } else {
        flushRun();
      }
    }
    flushRun();

    const deliveryColumns = deliveryData.map((d) => ({
      time: toTimestamp(d.trade_date),
      value: d.deliv_pct,
      color: d.deliv_pct >= 50 ? DELIV_HIGH : DELIV_LOW,
    }));
    deliveryByDateRef.current = new Map(deliveryData.map((d) => [d.trade_date.slice(0, 10), d]));
    highLowByDateRef.current = new Map(
      data.map((d) => [d.trade_date.slice(0, 10), { high: d.high, low: d.low }])
    );

    series.candles.setData(candleData);
    series.volume.setData(volumeData);
    series.delivery.setData(deliveryColumns);
    series.lowVolumeBoxes.ranges = significantLowRanges;

    markerDatesRef.current = new Set(markers.map((m) => m.dateStr));
    // One shared marker style (dot, single color) for both deal types - bulk
    // vs. block is distinguished by its "BL"/"BO" text label instead of
    // separate shapes/colors.
    series.markerDots.markers = markers;

    const addedBars = data.length - lastDataLengthRef.current;
    if (rangeAdjustTimerRef.current !== null) {
      clearTimeout(rangeAdjustTimerRef.current);
      rangeAdjustTimerRef.current = null;
    }
    if (pendingLazyLoadRef.current && lastVisibleRangeRef.current && addedBars > 0) {
      armSuppressEdgeCheck(suppressEdgeCheckRef);
      chart.timeScale().setVisibleLogicalRange({
        from: lastVisibleRangeRef.current.from + addedBars,
        to: lastVisibleRangeRef.current.to + addedBars,
      });
    } else {
      // Calling fitContent()/setVisibleLogicalRange() synchronously right
      // after a big setData() (~900+ bars - e.g. jumping the header's date
      // range back several years) reliably hit a "Value is null" crash deep
      // in lightweight-charts' own autoscale caching - a real library bug,
      // reproduced even with zero markers and clean, deduped, gapless candle
      // data. A short debounced setTimeout lets its internal state settle
      // first - debounced (cleared and rescheduled above) rather than just
      // "run once and check a generation counter" because price, deals, and
      // delivery each land from their own query and re-trigger this effect
      // moments apart; a generation check alone meant a fast-enough burst of
      // those re-runs could invalidate every pending timer before any of
      // them fired, leaving the chart stuck on a stale range entirely rather
      // than crashing OR updating. Debouncing guarantees the last run in a
      // burst always gets its turn once things settle.
      // Separately, showing only the most recent ~250 bars by default (vs.
      // fitting every loaded bar into view) is also just the more sensible
      // default here: scroll-back lazy-loading is what pulls in the rest of
      // the history on demand, so there's no need to cram years of candles
      // into view illegibly up front.
      const RECENT_WINDOW = 250;
      rangeAdjustTimerRef.current = setTimeout(() => {
        rangeAdjustTimerRef.current = null;
        if (chartRef.current !== chart) return;
        armSuppressEdgeCheck(suppressEdgeCheckRef);
        if (data.length > RECENT_WINDOW) {
          chart.timeScale().setVisibleLogicalRange({
            from: data.length - RECENT_WINDOW,
            to: data.length - 1,
          });
        } else {
          // A fully-fit small dataset always starts at logical index 0 -
          // exactly what the edge-detector watches for - so the suppression
          // above is what stops that from reading as "user panned to the
          // edge" and immediately firing off another lazy-load on its own.
          chart.timeScale().fitContent();
        }
      }, 80);
    }
    pendingLazyLoadRef.current = false;
    lastDataLengthRef.current = data.length;

    return () => {
      // Captured on cleanup rather than only on unmount: if a lazy-load
      // request is in flight when this runs again for the *next* data
      // change, this is where "where was the viewport right before that"
      // gets recorded.
      lastVisibleRangeRef.current = chart.timeScale().getVisibleLogicalRange();
    };
  }, [data, deliveryData, markers]);

  // Indicator panes are added/removed independently, preserving zoom and the
  // base series untouched.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const added: Array<ISeriesApi<"Line"> | ISeriesApi<"Histogram">> = [];
    const deliveryByDate = new Map(deliveryData.map((row) => [row.trade_date.slice(0, 10), row]));
    const bulk = dailyNet(bulkDeals ?? []), block = dailyNet(blockDeals ?? []);
    const shortSelling = dailySum(shortSellingDeals ?? []);
    let nextPane = 3;
    for (const config of indicators) {
      if (config.key === "bulk_net_qty" && (!bulkSupported || !bulkDeals)) continue;
      if (config.key === "block_net_qty" && !blockDeals) continue;
      if (config.key === "deal_net_qty" && (!blockDeals || (bulkSupported && !bulkDeals))) continue;
      if (config.key === "short_selling_qty" && !shortSellingDeals) continue;
      const raw = data.map((row) => {
        const date = row.trade_date.slice(0, 10);
        switch (config.key) {
          case "price_average": case "rsi": return row.close;
          case "volume": return row.volume;
          case "delivery_pct": return deliveryByDate.get(date)?.deliv_pct ?? null;
          case "delivery_qty": return deliveryByDate.get(date)?.deliv_qty ?? null;
          case "bulk_net_qty": return bulk.get(date) ?? 0;
          case "block_net_qty": return block.get(date) ?? 0;
          case "deal_net_qty": return (bulk.get(date) ?? 0) + (block.get(date) ?? 0);
          case "short_selling_qty": return shortSelling.get(date) ?? 0;
        }
      });
      const isDelivery = config.key === "delivery_pct" || config.key === "delivery_qty";
      const paneIndex = config.key === "price_average" ? 0 : config.key === "volume" ? 1 : isDelivery ? 2 : nextPane++;
      const label = indicatorOptions.find((option) => option.key === config.key)!.label;
      const line = chart.addSeries(LineSeries, {
        color: config.color, lineWidth: 2, priceLineVisible: false,
        title: `${config.key === "delivery_qty" ? "Delivery qty " : ""}${config.key === "rsi" ? "RSI" : config.method} ${config.period}`,
        priceScaleId: config.key === "delivery_qty" ? "left" : "right",
        priceFormat: { type: config.key === "delivery_pct" ? "percent" : config.key === "volume" || config.key.endsWith("qty") ? "volume" : "price" },
      }, paneIndex);
      // Quantity and percentage share a pane, but must never share a value scale.
      if (config.key === "delivery_qty") line.priceScale().applyOptions({ visible: true });
      added.push(line);
      const values = config.key === "rsi" ? rsi(data.map((row) => row.close), config.period) : rolling(raw, config.period, config.method);
      line.setData(values.map((value, i) => value === null ? { time: toTimestamp(data[i].trade_date) } : { time: toTimestamp(data[i].trade_date), value }));
      if (config.key.endsWith("net_qty") || config.key === "short_selling_qty") {
        const histogram = chart.addSeries(HistogramSeries, { title: label, priceFormat: { type: "volume" }, priceLineVisible: false }, paneIndex);
        added.push(histogram);
        histogram.setData(raw.map((value, i) => value === null ? { time: toTimestamp(data[i].trade_date) } : {
          time: toTimestamp(data[i].trade_date), value, color: value < 0 ? "#e5615c" : `${config.color}80`,
        }));
      }
      if (config.key === "rsi") {
        for (const price of [30, 70]) line.createPriceLine({ price, color: "#787b86", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
      }
    }
    chart.panes().forEach((pane, i) => pane.setStretchFactor(i === 0 ? 4 : 1));
    // Every indicator that gets its own pane (nextPane started at 3 and was
    // incremented once per such indicator actually rendered above) used to
    // just squeeze into the same fixed 720px chart - each existing pane, and
    // the new one, got shorter every time one more indicator was added. The
    // container instead grows with each extra pane, holding every pane
    // (including price) at a legible minimum height rather than shrinking
    // everything to fit a fixed budget.
    const extraPanes = nextPane - 3;
    const MIN_PANE_HEIGHT = 130;
    const PRICE_STRETCH = 4;
    const BASE_SUB_PANES = 2; // volume + delivery
    chart.applyOptions({ height: MIN_PANE_HEIGHT * (PRICE_STRETCH + BASE_SUB_PANES + extraPanes) });
    return () => {
      if (chartRef.current === chart) {
        for (const series of added.reverse()) chart.removeSeries(series);
        if (indicators.some((config) => config.key === "delivery_qty")) {
          chart.priceScale("left", 2).applyOptions({ visible: false });
        }
      }
    };
  }, [data, deliveryData, markers, indicators, bulkDeals, blockDeals, shortSellingDeals, bulkSupported]);

  return <div ref={containerRef} style={{ width: "100%" }} />;
}

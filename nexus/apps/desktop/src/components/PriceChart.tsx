import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export interface Candle {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type ChartRange = "1d" | "5d" | "1mo" | "6mo" | "1y" | "5y";

/**
 * Up / down colours. "classic" matches TradingView (green ↔ red) so the two charts read the same;
 * "colorblind" is a blue ↔ red pair validated for colour-blind separation. Direction is also shown by
 * hollow (up) vs solid (down) candles and by ▲ / ▼, so colour is never the only cue.
 * Live bindings: importers always see the current values; pages re-render when the setting changes.
 */
export const CHART_COLORS = {
  classic: { up: "#089981", down: "#f23645" },
  colorblind: { up: "#3987e5", down: "#e66767" },
} as const;
export type ChartColors = keyof typeof CHART_COLORS;
export let UP: string = CHART_COLORS.classic.up;
export let DOWN: string = CHART_COLORS.classic.down;
export function setChartColors(scheme: string | undefined): void {
  const c = CHART_COLORS[(scheme as ChartColors) in CHART_COLORS ? (scheme as ChartColors) : "classic"];
  UP = c.up;
  DOWN = c.down;
}

const PAD = { top: 10, right: 58, bottom: 22, left: 6 };
const PRICE_H = 300;
const GAP = 14;
const VOL_H = 56;
const RSI_H = 64;

/** Relative Strength Index (Wilder's smoothing): 0–100, where above 70 is often read as stretched up and below 30 as stretched down. */
export function rsi(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = candles.map(() => null);
  if (candles.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i]!.c - candles[i - 1]!.c;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const value = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i]!.c - candles[i - 1]!.c;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

export function sma(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i]!.c;
    if (i >= period) sum -= candles[i - period]!.c;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/** "Nice" axis ticks (1/2/5 × 10ⁿ) covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

export function formatPrice(v: number): string {
  const digits = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : 4;
  return v.toLocaleString(undefined, { minimumFractionDigits: digits === 0 ? 0 : 2, maximumFractionDigits: digits });
}

export function formatVolume(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

function timeLabel(t: number, range: ChartRange, long = false): string {
  const d = new Date(t * 1000);
  if (long) {
    return range === "1d" || range === "5d"
      ? d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
  if (range === "1d") return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (range === "5d") return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
  if (range === "5y") return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * Price chart: candles (or a close line) with optional moving averages, and volume in its own
 * panel underneath — two panels sharing the time axis rather than two scales on one plot.
 * Hover or use ← → to read any bar.
 */
export interface PriceLevel {
  label: string;
  value: number;
  kind: "entry" | "stop" | "target";
}

export function PriceChart({ candles, range, mode, showSma20, showSma50, showRsi = false, levels, label }: {
  candles: Candle[];
  range: ChartRange;
  mode: "candles" | "line";
  showSma20: boolean;
  showSma50: boolean;
  showRsi?: boolean;
  /** Horizontal guide lines for a trade idea (entry, stop-loss, targets). */
  levels?: PriceLevel[];
  label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(320, el.clientWidth));
    return () => ro.disconnect();
  }, []);
  useEffect(() => setHover(null), [candles]);

  const m = useMemo(() => {
    const n = candles.length;
    const plotW = width - PAD.left - PAD.right;
    const s20 = showSma20 ? sma(candles, 20) : [];
    const s50 = showSma50 ? sma(candles, 50) : [];
    const r14 = showRsi ? rsi(candles, 14) : [];
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of candles) {
      lo = Math.min(lo, mode === "candles" ? c.l : c.c);
      hi = Math.max(hi, mode === "candles" ? c.h : c.c);
    }
    for (const v of [...s20, ...s50]) {
      if (v != null) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    for (const lv of levels ?? []) {
      // Keep idea levels on screen, unless one is absurdly far from the visible prices.
      if (Number.isFinite(lo) && lv.value > lo * 0.6 && lv.value < hi * 1.6) {
        lo = Math.min(lo, lv.value);
        hi = Math.max(hi, lv.value);
      }
    }
    if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
    if (hi === lo) [lo, hi] = [lo * 0.99, hi * 1.01 || 1];
    const pad = (hi - lo) * 0.06;
    const [y0, y1] = [lo - pad, hi + pad];
    const step = n > 0 ? plotW / n : plotW;
    const x = (i: number) => PAD.left + step * (i + 0.5);
    const y = (v: number) => PAD.top + (1 - (v - y0) / (y1 - y0)) * PRICE_H;
    const vTop = PAD.top + PRICE_H + GAP;
    const vMax = Math.max(1, ...candles.map((c) => c.v));
    const hasVolume = candles.some((c) => c.v > 0);
    const line = (vals: (number | null)[]) => {
      let d = "";
      let pen = false;
      vals.forEach((v, i) => {
        if (v == null) return void (pen = false);
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    const tickEvery = Math.max(1, Math.round(n / Math.max(2, Math.floor(plotW / 110))));
    const xTicks: number[] = [];
    for (let i = Math.floor(tickEvery / 2); i < n; i += tickEvery) xTicks.push(i);
    const rTop = vTop + (hasVolume ? VOL_H + GAP : 0);
    const ry = (v: number) => rTop + (1 - v / 100) * RSI_H;
    let rsiPath = "";
    let pen = false;
    r14.forEach((v, i) => {
      if (v == null) return void (pen = false);
      rsiPath += `${pen ? "L" : "M"}${x(i).toFixed(1)},${ry(v).toFixed(1)}`;
      pen = true;
    });
    return { n, plotW, step, x, y, s20, s50, r14, rTop, ry, rsiPath, yTicks: niceTicks(y0, y1, 5).filter((v) => v > y0 && v < y1), vTop, vMax, hasVolume, line, xTicks };
  }, [candles, width, mode, showSma20, showSma50, showRsi, levels]);

  const height = PAD.top + PRICE_H + (m.hasVolume ? GAP + VOL_H : 0) + (showRsi ? GAP + RSI_H : 0) + PAD.bottom;
  const bodyW = Math.max(1, Math.min(14, m.step * 0.62));
  const active = hover != null && candles[hover] ? hover : null;
  const cur = active != null ? candles[active]! : null;
  const prev = active != null && active > 0 ? candles[active - 1]! : null;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.floor((px - PAD.left) / m.step);
    setHover(m.n ? Math.max(0, Math.min(m.n - 1, i)) : null);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!m.n) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const base = hover ?? m.n - 1;
      setHover(Math.max(0, Math.min(m.n - 1, base + (e.key === "ArrowLeft" ? -1 : 1))));
    } else if (e.key === "Escape") setHover(null);
  };

  if (!candles.length) return <div ref={wrap} className="grid h-[300px] place-items-center text-[12.5px] text-muted">No price history for this period.</div>;

  const tipLeft = active != null ? Math.min(Math.max(m.x(active) + 14, 8), width - 196) : 0;
  const tipFlip = active != null && m.x(active) + 14 + 188 > width - PAD.right;

  return (
    <div ref={wrap} className="relative w-full select-none">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        tabIndex={0}
        aria-label={`${label} price chart. Use the left and right arrow keys to read each bar.`}
        className="block rounded-xl outline-none focus-visible:ring-1 focus-visible:ring-white/30"
        style={{ touchAction: "pan-y" }}
        onPointerMove={onMove}
        onPointerDown={onMove}
        // A finger "leaves" as soon as it lifts; keep the read-out on touch so a tap is enough.
        onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
        onKeyDown={onKey}
      >
        {/* recessive grid + right-hand price axis */}
        {m.yTicks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={width - PAD.right} y1={m.y(v)} y2={m.y(v)} stroke="rgba(255,255,255,0.06)" />
            <text x={width - PAD.right + 8} y={m.y(v) + 3.5} fontSize="10.5" fill="#7a808c" fontFamily="var(--font-mono)">
              {formatPrice(v)}
            </text>
          </g>
        ))}
        {m.xTicks.map((i) => (
          <text key={i} x={m.x(i)} y={height - 6} fontSize="10.5" fill="#7a808c" textAnchor="middle">
            {timeLabel(candles[i]!.t, range)}
          </text>
        ))}

        {mode === "candles" ? (
          candles.map((c, i) => {
            const up = c.c >= c.o;
            const top = m.y(Math.max(c.o, c.c));
            const h = Math.max(1, Math.abs(m.y(c.o) - m.y(c.c)));
            const color = up ? UP : DOWN;
            return (
              <g key={c.t} opacity={active != null && active !== i ? 0.55 : 1}>
                <line x1={m.x(i)} x2={m.x(i)} y1={m.y(c.h)} y2={m.y(c.l)} stroke={color} strokeWidth={1} />
                {/* direction is carried twice: hue, and hollow (up) vs solid (down) */}
                <rect x={m.x(i) - bodyW / 2} y={top} width={bodyW} height={h} rx={bodyW > 5 ? 1.5 : 0} fill={up ? "#14161b" : color} stroke={color} strokeWidth={1} />
              </g>
            );
          })
        ) : (
          <>
            <defs>
              <linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={UP} stopOpacity="0.22" />
                <stop offset="1" stopColor={UP} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={`${m.line(candles.map((c) => c.c))}L${m.x(m.n - 1).toFixed(1)},${PAD.top + PRICE_H}L${m.x(0).toFixed(1)},${PAD.top + PRICE_H}Z`} fill="url(#price-fill)" />
            <path d={m.line(candles.map((c) => c.c))} fill="none" stroke={UP} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}

        {/* moving averages: neutral ink, told apart by line style rather than a third and fourth hue */}
        {showSma20 && <path d={m.line(m.s20)} fill="none" stroke="#e8eaee" strokeWidth={1.5} strokeLinejoin="round" opacity={0.9} />}
        {showSma50 && <path d={m.line(m.s50)} fill="none" stroke="#aeb3bc" strokeWidth={1.5} strokeDasharray="5 4" strokeLinejoin="round" />}

        {/* volume: its own panel and scale, sharing only the time axis */}
        {m.hasVolume && (
          <>
            <line x1={PAD.left} x2={width - PAD.right} y1={m.vTop + VOL_H} y2={m.vTop + VOL_H} stroke="rgba(255,255,255,0.08)" />
            <text x={width - PAD.right + 8} y={m.vTop + 9} fontSize="10.5" fill="#7a808c" fontFamily="var(--font-mono)">
              {formatVolume(m.vMax)}
            </text>
            <text x={PAD.left + 2} y={m.vTop + 9} fontSize="10" fill="#7a808c" letterSpacing="0.08em">
              VOLUME
            </text>
            {candles.map((c, i) => {
              const h = (c.v / m.vMax) * (VOL_H - 12);
              const w = Math.max(1, Math.min(14, m.step - 2));
              return <rect key={c.t} x={m.x(i) - w / 2} y={m.vTop + VOL_H - h} width={w} height={h} rx={w > 5 ? 1.5 : 0} fill={active === i ? "#cdd3dd" : "rgba(174,179,188,0.38)"} />;
            })}
          </>
        )}

        {/* trade-idea levels: labelled lines; the stop is red, targets blue, the entry neutral */}
        {(levels ?? []).map((lv) => {
          const yy = m.y(lv.value);
          if (yy < PAD.top - 2 || yy > PAD.top + PRICE_H + 2) return null;
          const color = lv.kind === "stop" ? DOWN : lv.kind === "target" ? UP : "#e8eaee";
          return (
            <g key={lv.label} pointerEvents="none">
              <line x1={PAD.left} x2={width - PAD.right} y1={yy} y2={yy} stroke={color} strokeWidth={1.25} strokeDasharray={lv.kind === "entry" ? undefined : "6 4"} opacity={0.9} />
              <rect x={PAD.left + 4} y={yy - 9} width={lv.label.length * 6.3 + 12} height={17} rx={5} fill="#14161b" stroke={color} strokeWidth={1} />
              <text x={PAD.left + 10} y={yy + 3.5} fontSize="10.5" fill="#e8eaee">
                {lv.label}
              </text>
            </g>
          );
        })}

        {/* RSI: a third panel on its own fixed 0–100 scale, with the usual 30 / 70 guides */}
        {showRsi && (
          <>
            <rect x={PAD.left} y={m.ry(70)} width={width - PAD.left - PAD.right} height={m.ry(30) - m.ry(70)} fill="rgba(255,255,255,0.035)" />
            {[70, 30].map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={width - PAD.right} y1={m.ry(v)} y2={m.ry(v)} stroke="rgba(255,255,255,0.14)" strokeDasharray="2 4" />
                <text x={width - PAD.right + 8} y={m.ry(v) + 3.5} fontSize="10.5" fill="#7a808c" fontFamily="var(--font-mono)">
                  {v}
                </text>
              </g>
            ))}
            <text x={PAD.left + 2} y={m.rTop + 9} fontSize="10" fill="#7a808c" letterSpacing="0.08em">
              RSI (14)
            </text>
            <path d={m.rsiPath} fill="none" stroke="#e8eaee" strokeWidth={1.5} strokeLinejoin="round" />
          </>
        )}

        {active != null && cur && (
          <g pointerEvents="none">
            <line x1={m.x(active)} x2={m.x(active)} y1={PAD.top} y2={height - PAD.bottom} stroke="rgba(255,255,255,0.35)" strokeDasharray="3 3" />
            <line x1={PAD.left} x2={width - PAD.right} y1={m.y(cur.c)} y2={m.y(cur.c)} stroke="rgba(255,255,255,0.18)" />
            <rect x={width - PAD.right + 2} y={m.y(cur.c) - 9} width={PAD.right - 4} height={18} rx={5} fill="#e8eaee" />
            <text x={width - PAD.right + 8} y={m.y(cur.c) + 3.5} fontSize="10.5" fill="#14161b" fontFamily="var(--font-mono)" fontWeight={600}>
              {formatPrice(cur.c)}
            </text>
            {mode === "line" && <circle cx={m.x(active)} cy={m.y(cur.c)} r={4.5} fill={UP} stroke="#14161b" strokeWidth={2} />}
          </g>
        )}
      </svg>

      {active != null && cur && (
        <div
          className="pointer-events-none absolute top-2 w-[188px] rounded-xl border border-white/15 bg-[rgba(20,22,27,0.92)] p-2.5 text-[11.5px] shadow-[0_18px_40px_-18px_rgba(0,0,0,0.9)] backdrop-blur-xl"
          style={tipFlip ? { left: Math.max(8, m.x(active) - 14 - 188) } : { left: tipLeft }}
        >
          <p className="mb-1.5 text-fg-2">{timeLabel(cur.t, range, true)}</p>
          <Row k="Close" v={formatPrice(cur.c)} strong />
          {mode === "candles" && (
            <>
              <Row k="Open" v={formatPrice(cur.o)} />
              <Row k="High" v={formatPrice(cur.h)} />
              <Row k="Low" v={formatPrice(cur.l)} />
            </>
          )}
          {prev && <Row k="Change" v={`${cur.c >= prev.c ? "▲" : "▼"} ${Math.abs(((cur.c - prev.c) / prev.c) * 100).toFixed(2)}%`} mark={cur.c >= prev.c ? UP : DOWN} />}
          {showSma20 && m.s20[active] != null && <Row k="Average (20)" v={formatPrice(m.s20[active]!)} line="solid" />}
          {showSma50 && m.s50[active] != null && <Row k="Average (50)" v={formatPrice(m.s50[active]!)} line="dashed" />}
          {m.hasVolume && <Row k="Volume" v={formatVolume(cur.v)} />}
          {showRsi && m.r14[active] != null && <Row k="RSI (14)" v={m.r14[active]!.toFixed(1)} />}
        </div>
      )}
    </div>
  );
}

function Row({ k, v, strong, mark, line }: { k: string; v: string; strong?: boolean; mark?: string; line?: "solid" | "dashed" }) {
  return (
    <p className="flex items-center justify-between gap-3 leading-[1.55]">
      <span className="flex items-center gap-1.5 text-muted">
        {line && <span className="inline-block w-3.5 border-t-[1.5px]" style={{ borderColor: line === "solid" ? "#e8eaee" : "#aeb3bc", borderTopStyle: line }} />}
        {k}
      </span>
      <span className={`flex items-center gap-1 font-mono ${strong ? "text-[13px] font-semibold text-fg" : "text-fg"}`}>
        {mark && <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: mark }} />}
        {v}
      </span>
    </p>
  );
}

/** Legend that mirrors the marks: hollow/solid candle bodies and the two average line styles. */
export function ChartLegend({ mode, showSma20, showSma50 }: { mode: "candles" | "line"; showSma20: boolean; showSma50: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-fg-2">
      {mode === "candles" ? (
        <>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-2 rounded-[2px] border" style={{ borderColor: UP }} /> Closed higher
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-2 rounded-[2px]" style={{ background: DOWN }} /> Closed lower
          </span>
        </>
      ) : (
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-2" style={{ borderColor: UP }} /> Closing price
        </span>
      )}
      {showSma20 && (
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-[1.5px] border-[#e8eaee]" /> 20-bar average
        </span>
      )}
      {showSma50 && (
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-[1.5px] border-dashed border-[#aeb3bc]" /> 50-bar average
        </span>
      )}
    </div>
  );
}

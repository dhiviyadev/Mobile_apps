import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { bus } from "@/lib/events";
import { useCore } from "@/stores/core";
import { ChartLegend, DOWN, PriceChart, UP, formatPrice, type Candle, type ChartRange } from "@/components/PriceChart";
import { Sheet } from "./MobileApp";
import { MarketPulse } from "@/components/MarketPulse";
import { TrendLine } from "@/components/TrendLine";

interface Quote {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  price: number;
  change: number | null;
  change_percent: number | null;
  error?: string;
}
interface Overview {
  enabled: boolean;
  watchlist: { symbol: string; name: string; quote?: Quote | null; spark?: number[] }[];
  portfolio: {
    currency: string;
    equity: number;
    cash: number;
    total_return: number;
    total_return_percent: number;
    positions: { symbol: string; quantity: number; value: number | null; pnl_percent: number | null }[];
  };
  alerts: { id: string; symbol: string; direction: string; price: number; triggered_at: string | null }[];
}

const RANGES: { value: ChartRange; label: string }[] = [
  { value: "1d", label: "1D" }, { value: "5d", label: "5D" }, { value: "1mo", label: "1M" },
  { value: "6mo", label: "6M" }, { value: "1y", label: "1Y" }, { value: "5y", label: "5Y" },
];

function money(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD", maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${formatPrice(v)} ${currency}`;
  }
}

function Change({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <span className="text-muted">—</span>;
  const up = pct >= 0;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12.5px] text-fg-2">
      <span aria-hidden style={{ color: up ? UP : DOWN }}>{up ? "▲" : "▼"}</span>
      <span className="sr-only">{up ? "up" : "down"}</span>
      {Math.abs(pct).toFixed(2)}%
    </span>
  );
}

/** Markets on the phone: look at your watchlist, charts and practice account. Trading and edits stay on the Mac. */
export function MMarkets() {
  const enabled = useCore((s) => Boolean(s.boot?.markets?.enabled));
  const [ov, setOv] = useState<Overview | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.get<Overview>("/api/markets").then(setOv).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    load();
    const off = bus.on("markets", load);
    const t = window.setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    return () => {
      off();
      window.clearInterval(t);
    };
  }, [enabled, load]);

  if (!enabled || !ov) return null;
  const p = ov.portfolio;
  const waiting = ov.alerts.filter((a) => !a.triggered_at).length;
  const symbols = [...ov.watchlist.map((w) => w.symbol), ...p.positions.map((x) => x.symbol).filter((s) => !ov.watchlist.some((w) => w.symbol === s))];
  if (!symbols.length)
    return (
      <>
        <MarketPulse compact onSelect={setOpen} />
        <ChartSheet symbol={open} onClose={() => setOpen(null)} />
      </>
    );

  return (
    <>
    <MarketPulse compact onSelect={setOpen} />
    <section className="surface rise p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.1em] text-muted">Markets</h2>
        {waiting > 0 && <span className="text-[11.5px] text-muted">{waiting} alert{waiting === 1 ? "" : "s"} waiting</span>}
      </div>
      {ov.watchlist.map((w) => (
        <button key={w.symbol} onClick={() => setOpen(w.symbol)} className="press flex w-full items-center gap-3 border-b border-white/[0.06] py-3 text-left last:border-0">
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-[14px] font-semibold text-fg">{w.symbol}</span>
            <span className="block truncate text-[12.5px] text-muted">{w.name}</span>
          </span>
          <TrendLine values={w.spark ?? []} label={w.symbol} />
          <span className="text-right">
            <span className="block font-mono text-[14px] text-fg">{w.quote && !w.quote.error ? formatPrice(w.quote.price) : "—"}</span>
            <Change pct={w.quote?.change_percent} />
          </span>
        </button>
      ))}
      <div className="mt-3 flex items-center justify-between rounded-2xl border border-white/[0.08] bg-white/[0.04] px-3 py-2.5">
        <span>
          <span className="block text-[11.5px] text-muted">Practice account</span>
          <span className="block font-mono text-[15px] font-semibold text-fg">{money(p.equity, p.currency)}</span>
        </span>
        <span className="text-right">
          <span className="block text-[11.5px] text-muted">since start</span>
          <Change pct={p.total_return_percent} />
        </span>
      </div>
      {p.positions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {p.positions.map((x) => (
            <button key={x.symbol} onClick={() => setOpen(x.symbol)} className="press inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-3 font-mono text-[12px] text-fg-2">
              {x.quantity} {x.symbol} <Change pct={x.pnl_percent} />
            </button>
          ))}
        </div>
      )}
      <p className="mt-2 text-[11.5px] leading-snug text-muted">Pretend money, real prices (may be delayed). Trade and edit on your Mac.</p>
    </section>
    {/* Outside the glass card: a blurred card would trap the full-screen sheet inside itself. */}
    <ChartSheet symbol={open} onClose={() => setOpen(null)} />
    </>
  );
}

function ChartSheet({ symbol, onClose }: { symbol: string | null; onClose: () => void }) {
  const [range, setRange] = useState<ChartRange>("6mo");
  const [mode, setMode] = useState<"candles" | "line">("line");
  const [data, setData] = useState<{ quote: Quote; candles: Candle[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!symbol) return;
    let live = true;
    setLoading(true);
    setErr(null);
    api
      .get<{ quote: Quote; candles: Candle[] }>(`/api/markets/history/${encodeURIComponent(symbol)}?range=${range}`)
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setErr(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [symbol, range]);
  useEffect(() => {
    if (!symbol) setData(null);
  }, [symbol]);

  const q = data?.quote.symbol === symbol ? data?.quote : null;
  return (
    <Sheet open={Boolean(symbol)} onClose={onClose} title={q?.name ?? symbol ?? ""}>
      {symbol && (
        <div className="space-y-3 pb-24">
          <div className="flex items-baseline gap-3">
            <span className="text-[30px] font-semibold leading-none tracking-tight text-fg">{q ? formatPrice(q.price) : "—"}</span>
            {q && <Change pct={q.change_percent} />}
            <span className="text-[12px] text-muted">{q?.currency}</span>
          </div>
          <div className="flex items-center gap-1 overflow-x-auto">
            {RANGES.map((r) => (
              <button key={r.value} onClick={() => setRange(r.value)} className={`press h-9 min-w-[44px] rounded-full px-3 text-[13px] ${range === r.value ? "border border-white/15 bg-white/[0.12] text-fg" : "text-muted"}`}>
                {r.label}
              </button>
            ))}
            <span className="flex-1" />
            <button onClick={() => setMode(mode === "line" ? "candles" : "line")} className="press h-9 rounded-full border border-white/10 bg-white/[0.05] px-3 text-[12.5px] text-fg-2">
              {mode === "line" ? "Candles" : "Line"}
            </button>
          </div>
          {err ? (
            <p className="py-8 text-center text-[13px] text-danger">{err}</p>
          ) : !q ? (
            <div className="grid h-[300px] place-items-center">
              <Loader2 size={18} className="animate-spin text-muted" />
            </div>
          ) : (
            // A near-solid panel: the sheet is glass, and a chart needs a quiet background to be readable.
            <div className={`rounded-2xl bg-[rgba(16,18,23,0.9)] p-2 transition-opacity ${loading ? "opacity-60" : ""}`}>
              <div className="mb-1.5">
                <ChartLegend mode={mode} showSma20 showSma50={false} />
              </div>
              <PriceChart candles={data!.candles} range={range} mode={mode} showSma20 showSma50={false} label={q.name} />
            </div>
          )}
          <p className="text-[11.5px] leading-snug text-muted">Touch and slide across the chart to read a day. Information only, not financial advice.</p>
        </div>
      )}
    </Sheet>
  );
}

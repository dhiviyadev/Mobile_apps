import { useCallback, useEffect, useRef, useState } from "react";
import { BellPlus, ChartCandlestick, Loader2, Plus, RotateCcw, Search, Table2, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { bus } from "@/lib/events";
import { cls, relTime } from "@/lib/format";
import { useCore } from "@/stores/core";
import { Badge, Button, Card, Empty, IconButton, Input, SectionTitle, Segmented, Select, Toggle } from "@/components/ui";
import { ChartLegend, DOWN, PriceChart, UP, formatPrice, formatVolume, type Candle, type ChartRange, type PriceLevel } from "@/components/PriceChart";
import { Ideas, LiveTrading, Scan } from "./Trading";
import { MarketPulse } from "@/components/MarketPulse";
import { TrendLine } from "@/components/TrendLine";
import { TradingViewChart, TradingViewRating, isIndianListing } from "@/components/TradingViewChart";

interface Quote {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  kind: string;
  price: number;
  previous_close: number | null;
  change: number | null;
  change_percent: number | null;
  market_time: number | null;
  error?: string;
  delay?: string;
}
interface WatchItem {
  symbol: string;
  name: string;
  currency: string;
  quote?: Quote | null;
  spark?: number[];
}
interface Position {
  symbol: string;
  name: string;
  quantity: number;
  avg_cost: number;
  price: number | null;
  value: number | null;
  pnl: number | null;
  pnl_percent: number | null;
}
interface Portfolio {
  currency: string;
  cash: number;
  starting_cash: number;
  positions_value: number;
  equity: number;
  total_return: number;
  total_return_percent: number;
  realized_pnl: number;
  positions: Position[];
  fully_priced: boolean;
  since: string;
}
interface Alert {
  id: string;
  symbol: string;
  direction: "above" | "below";
  price: number;
  created_at: string;
  triggered_at: string | null;
  triggered_price: number | null;
}
interface Order {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  total: number;
  realized_pnl: number | null;
  created_at: string;
}
interface Overview {
  enabled: boolean;
  watchlist: WatchItem[];
  portfolio: Portfolio;
  alerts: Alert[];
  source: string;
}
interface History {
  symbol: string;
  range: ChartRange;
  quote: Quote;
  candles: Candle[];
  fetched_at: string;
  source: string;
  stale?: boolean;
}

const RANGES: { value: ChartRange; label: string }[] = [
  { value: "1d", label: "1D" }, { value: "5d", label: "5D" }, { value: "1mo", label: "1M" },
  { value: "6mo", label: "6M" }, { value: "1y", label: "1Y" }, { value: "5y", label: "5Y" },
];
const STARTERS = ["RELIANCE.NS", "INFY.NS", "HDFCBANK.NS", "TCS.NS", "^NSEI", "BTC-USD"];

function money(v: number | null | undefined, currency: string): string {
  if (v == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD", maximumFractionDigits: Math.abs(v) >= 1 ? 2 : 4 }).format(v);
  } catch {
    return `${formatPrice(v)} ${currency}`;
  }
}

/** Direction is shown by an arrow and a coloured chip; the number itself stays in normal text colour. */
function Change({ pct, abs, currency }: { pct: number | null | undefined; abs?: number | null; currency?: string }) {
  if (pct == null) return <span className="text-muted">—</span>;
  const up = pct >= 0;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px] text-fg-2">
      <span aria-hidden style={{ color: up ? UP : DOWN }}>{up ? "▲" : "▼"}</span>
      <span className="sr-only">{up ? "up" : "down"}</span>
      {abs != null && currency != null && <span>{money(Math.abs(abs), currency)}</span>}
      <span>{Math.abs(pct).toFixed(2)}%</span>
    </span>
  );
}

/** Markets: real prices and charts, price alerts, and a practice account that trades with pretend money. */
export function Markets() {
  const enabled = useCore((s) => Boolean(s.boot?.markets?.enabled));
  const refreshCore = useCore((s) => s.refresh);
  const [ov, setOv] = useState<Overview | null>(null);
  const [symbol, setSymbol] = useState<string | null>(() => useCore.getState().marketSymbol);
  const asked = useCore((s) => s.marketSymbol);
  useEffect(() => {
    if (asked) {
      setSymbol(asked);
      useCore.setState({ marketSymbol: null });
    }
  }, [asked]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const o = await api.get<Overview>("/api/markets");
      setOv(o);
      setError(null);
      setSymbol((cur) => cur ?? o.watchlist[0]?.symbol ?? o.portfolio.positions[0]?.symbol ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const off = bus.on("markets", () => void load());
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => {
      off();
      window.clearInterval(t);
    };
  }, [load, enabled]);

  const [turningOn, setTurningOn] = useState(false);
  const turnOn = async () => {
    setTurningOn(true);
    setError(null);
    try {
      await api.patch("/api/settings", { values: { "markets.enabled": true } });
      await refreshCore();
      void load();
    } catch (e) {
      const msg = (e as Error).message;
      setError(
        msg.includes("Unknown setting")
          ? "NEXUS's background service is an older version than this app, so it doesn't know about Markets yet. Use “Restart service” in the banner at the top, or quit and reopen NEXUS."
          : `Couldn't turn Markets on: ${msg}`,
      );
    } finally {
      setTurningOn(false);
    }
  };

  if (!enabled) {
    return (
      <div className="mx-auto max-w-[760px] px-8 py-10">
        <SectionTitle title="Markets" sub="Follow prices, read charts, get trade ideas, set alerts and practise trading." />
        <Card>
          <div className="flex items-start gap-4">
            <div className="grid h-11 w-11 flex-none place-items-center rounded-full border border-white/15 bg-white/[0.07]">
              <ChartCandlestick size={18} className="text-accent" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-fg">Turn on market data</p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-fg-2">
                <li>Indian share prices come from NSE India's official free data service, crypto from Coinbase. Only the symbols you look at are sent; your holdings and orders stay on this Mac.</li>
                <li>Prices can lag a few minutes and history is daily, so check your broker's live price before a real trade. Shares outside India rely on Yahoo Finance, which often refuses.</li>
                <li>
                  You start with a <b className="text-fg">practice account with pretend money</b>. Real orders are only possible after you connect Zerodha and switch them on yourself.
                </li>
              </ul>
              <Button className="mt-4" variant="primary" disabled={turningOn} icon={turningOn ? <Loader2 size={12} className="animate-spin" /> : undefined} onClick={() => void turnOn()}>
                Turn on Markets
              </Button>
              {error && <p className="mt-3 text-[12.5px] leading-snug text-danger">{error}</p>}
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const watch = ov?.watchlist ?? [];
  return (
    <div className="mx-auto max-w-[1240px] px-8 py-7">
      <SectionTitle
        title="Markets"
        sub="Real prices, trade ideas, a practice account — and real orders through Zerodha when you connect it."
      />
      {error && <p className="mb-3 text-[12.5px] text-danger">{error}</p>}
      <div className="grid grid-cols-[270px_minmax(0,1fr)] gap-5">
        <Watchlist items={watch} selected={symbol} onSelect={setSymbol} onChanged={load} />
        <div className="min-w-0 space-y-4">
          <MarketPulse onSelect={setSymbol} />
          {watch.length > 0 && <Scan onSelect={setSymbol} />}
          {symbol && !watch.some((w) => w.symbol === symbol) && (
            <div className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-[12.5px] text-fg-2">
              <span className="flex-1">
                <span className="font-mono text-fg">{symbol}</span> isn't on your watchlist.
              </span>
              <Button size="sm" icon={<Plus size={12} />} onClick={() => void api.post("/api/markets/watchlist", { symbol }).then(load).catch((e: Error) => setError(e.message))}>
                Add to watchlist
              </Button>
            </div>
          )}
          {symbol ? (
            <SymbolPanel key={symbol} symbol={symbol} portfolio={ov?.portfolio ?? null} alerts={ov?.alerts ?? []} onChanged={load} />
          ) : (
            <div className="surface">
              <Empty icon={<ChartCandlestick size={22} />} title="Pick something to follow" body="Search for a company, fund, index or crypto on the left, or start with one of the suggestions." />
            </div>
          )}
          {ov && <Account p={ov.portfolio} onSelect={setSymbol} onChanged={load} />}
          <p className="px-1 text-[11.5px] leading-snug text-muted">
            {ov?.source ?? "Yahoo Finance"} · Information only, not financial advice. Practice results don't predict real ones: real orders have fees, spreads and delays.
          </p>
        </div>
      </div>
    </div>
  );
}

function Watchlist({ items, selected, onSelect, onChanged }: { items: WatchItem[]; selected: string | null; onSelect: (s: string) => void; onChanged: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ symbol: string; name: string; exchange: string; kind: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setResults(null);
    const mine = ++seq.current;
    const t = window.setTimeout(() => {
      setBusy(true);
      api
        .get<{ symbol: string; name: string; exchange: string; kind: string }[]>(`/api/markets/search?q=${encodeURIComponent(term)}`)
        .then((r) => mine === seq.current && (setResults(r), setErr(null)))
        .catch((e: Error) => mine === seq.current && setErr(e.message))
        .finally(() => mine === seq.current && setBusy(false));
    }, 350);
    return () => window.clearTimeout(t);
  }, [q]);

  const add = async (symbol: string) => {
    setErr(null);
    setBusy(true);
    try {
      const quote = await api.post<Quote>("/api/markets/watchlist", { symbol });
      setQ("");
      setResults(null);
      await onChanged();
      onSelect(quote.symbol);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="space-y-2">
      <form
        className="relative"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) void add(results?.[0]?.symbol ?? q.trim());
        }}
      >
        <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search — INFY, HDFC Bank, BTC…" className="pl-8" aria-label="Search markets" />
        {busy && <Loader2 size={13} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted" />}
      </form>
      {results && (
        <div className="surface overflow-hidden p-1">
          {results.length === 0 && <p className="p-2 text-[12px] text-muted">No matches.</p>}
          {results.map((r) => (
            <button key={r.symbol} onClick={() => void add(r.symbol)} className="press flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06]">
              <Plus size={12} className="flex-none text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-fg">{r.name}</span>
                <span className="block text-[11px] text-muted">
                  <span className="font-mono">{r.symbol}</span> · {r.exchange} {r.kind && `· ${r.kind}`}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {err && <p className="px-1 text-[12px] text-danger">{err}</p>}
      {items.length === 0 && !results && (
        <div className="surface p-3">
          <p className="text-[12.5px] text-fg-2">Your watchlist is empty. Start with:</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {STARTERS.map((s) => (
              <button key={s} onClick={() => void add(s)} className="press glass-inset h-7 rounded-full px-2.5 font-mono text-[11.5px] text-fg-2 hover:text-fg">
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      {items.map((w) => (
        <div
          key={w.symbol}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(w.symbol)}
          onKeyDown={(e) => e.key === "Enter" && onSelect(w.symbol)}
          className={cls("surface press group flex cursor-pointer items-center gap-2 p-3 transition-colors", selected === w.symbol ? "border-white/20 bg-white/[0.09]" : "hover:bg-white/[0.05]")}
        >
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[12.5px] font-semibold text-fg">{w.symbol}</p>
            <p className="truncate text-[11.5px] text-muted">{w.name}</p>
          </div>
          <TrendLine values={w.spark ?? []} label={w.symbol} />
          <div className="text-right">
            <p className="font-mono text-[12.5px] text-fg">{w.quote && !w.quote.error ? formatPrice(w.quote.price) : "—"}</p>
            <Change pct={w.quote?.change_percent} />
          </div>
          <button
            aria-label={`Remove ${w.symbol} from watchlist`}
            onClick={(e) => {
              e.stopPropagation();
              void api.del(`/api/markets/watchlist/${encodeURIComponent(w.symbol)}`).then(onChanged);
            }}
            className="text-muted opacity-0 transition-opacity hover:text-fg focus:opacity-100 group-hover:opacity-100"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </aside>
  );
}

function SymbolPanel({ symbol, portfolio, alerts, onChanged }: { symbol: string; portfolio: Portfolio | null; alerts: Alert[]; onChanged: () => Promise<void> }) {
  const [range, setRange] = useState<ChartRange>("6mo");
  const [mode, setMode] = useState<"candles" | "line">("candles");
  const [sma20, setSma20] = useState(true);
  const [sma50, setSma50] = useState(false);
  const [showRsi, setShowRsi] = useState(false);
  const [table, setTable] = useState(false);
  const [levels, setLevels] = useState<PriceLevel[]>([]);
  const [account, setAccount] = useState<"practice" | "real">("practice");
  const [h, setH] = useState<History | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const savedChart = useCore((s) => s.boot?.markets?.chart ?? "builtin");
  const colors = useCore((s) => s.boot?.markets?.colors ?? "classic");
  const refreshAll = useCore((s) => s.refresh);
  const [chart, setChartState] = useState<"builtin" | "tradingview">(savedChart);
  const setChart = (v: "builtin" | "tradingview") => {
    setChartState(v);
    void api.patch("/api/settings", { values: { "markets.chart": v } }).catch(() => undefined);
  };

  const load = useCallback(async () => {
    try {
      setH(await api.get<History>(`/api/markets/history/${encodeURIComponent(symbol)}?range=${range}`));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [symbol, range]);

  // Full chart reload now and then; in between, a small live update every few seconds moves the price and last candle.
  const [checkedAt, setCheckedAt] = useState<number>(0);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    setLoading(true);
    void load().then(() => setCheckedAt(Date.now()));
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), 5 * 60_000);
    return () => window.clearInterval(t);
  }, [load, range]);
  useEffect(() => {
    let live = true;
    const pull = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const u = await api.get<{ quote: Quote; last: Candle[]; stale: boolean }>(`/api/markets/live/${encodeURIComponent(symbol)}?range=${range}`);
        if (!live) return;
        setCheckedAt(Date.now());
        setH((cur) => {
          if (!cur || cur.symbol !== u.quote.symbol && cur.symbol !== symbol) return cur;
          const before = cur.quote.price;
          if (u.quote.price !== before) setFlash(u.quote.price > before ? "up" : "down");
          const candles = [...cur.candles];
          for (const c of u.last) {
            const i = candles.findIndex((x) => x.t === c.t);
            if (i >= 0) candles[i] = c;
            else if (!candles.length || c.t > candles[candles.length - 1]!.t) candles.push(c);
          }
          return { ...cur, quote: u.quote, candles, stale: u.stale };
        });
      } catch {
        /* keep showing the last good data; the next pull tries again */
      }
    };
    const t = window.setInterval(() => void pull(), 5_000);
    const clock = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => {
      live = false;
      window.clearInterval(t);
      window.clearInterval(clock);
    };
  }, [symbol, range]);
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 900);
    return () => window.clearTimeout(t);
  }, [flash]);
  const ago = checkedAt ? Math.max(0, Math.round((Date.now() - checkedAt) / 1000)) : null;

  const q = h?.quote;
  return (
    <>
      <section className="surface rise p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-[13px] text-fg-2">
              {q?.name ?? symbol} <span className="text-muted">· {q?.exchange} {q?.currency && `· ${q.currency}`}</span>
            </p>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="font-[family-name:var(--font-display)] text-[34px] font-semibold leading-none tracking-tight text-fg transition-colors duration-700" style={flash ? { color: flash === "up" ? UP : DOWN } : undefined}>{q ? formatPrice(q.price) : "—"}</span>
              {q && <Change pct={q.change_percent} abs={q.change} currency={q.currency} />}
              <span className="text-[11.5px] text-muted">{q?.market_time ? `price from ${new Date(q.market_time * 1000).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "numeric", month: "short" })}` : ""}</span>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted" title={q?.delay ?? ""}>
              <span className={cls("h-1.5 w-1.5 rounded-full", h?.stale ? "bg-warn" : ago != null && ago < 20 ? "bg-ok animate-pulse" : "bg-white/30")} />
              {h?.stale ? "Showing last known prices — the price service isn't answering" : ago == null ? "Connecting…" : `Live · checked ${ago}s ago`}
              {q?.delay && <span>· {q.delay}</span>}
            </p>
          </div>
          {/* one row of controls above the chart */}
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={chart} onChange={setChart} options={[{ value: "builtin", label: "Built-in chart" }, { value: "tradingview", label: "TradingView" }]} />
            <Segmented value={range} onChange={setRange} options={RANGES} />
            {chart === "builtin" && (
              <>
            <Segmented value={mode} onChange={setMode} options={[{ value: "candles", label: "Candles" }, { value: "line", label: "Line" }]} />
            <label className="flex items-center gap-1.5 text-[11.5px] text-fg-2">
              <Toggle checked={sma20} onChange={setSma20} label="20-bar average" /> Avg 20
            </label>
            <label className="flex items-center gap-1.5 text-[11.5px] text-fg-2">
              <Toggle checked={sma50} onChange={setSma50} label="50-bar average" /> Avg 50
            </label>
            <label className="flex items-center gap-1.5 text-[11.5px] text-fg-2" title="Relative Strength Index: a 0–100 gauge of recent momentum">
              <Toggle checked={showRsi} onChange={setShowRsi} label="RSI momentum gauge" /> RSI
            </label>
            <IconButton
              label={colors === "classic" ? "Colours: green/red like TradingView (click for colour-blind friendly blue/red)" : "Colours: blue/red, colour-blind friendly (click for green/red like TradingView)"}
              onClick={() => void api.patch("/api/settings", { values: { "markets.colors": colors === "classic" ? "colorblind" : "classic" } }).then(refreshAll)}
            >
              <span className="flex gap-0.5" aria-hidden>
                <span className="h-3 w-1.5 rounded-[2px]" style={{ background: UP }} />
                <span className="h-3 w-1.5 rounded-[2px]" style={{ background: DOWN }} />
              </span>
            </IconButton>
            <IconButton label={table ? "Show the chart" : "Show the numbers as a table"} active={table} onClick={() => setTable(!table)}>
              <Table2 size={14} />
            </IconButton>
              </>
            )}
          </div>
        </div>
        <div className="mt-4">
          {chart === "tradingview" ? (
            <>
              <TradingViewChart symbol={symbol} range={range} />
              <p className="mt-2 text-[11.5px] leading-snug text-muted">
                Chart and data by TradingView, kept in its own frame: TradingView learns which symbol you view and nothing else.
                {isIndianListing(symbol) && " TradingView doesn't allow NSE prices in embedded charts, so this is the same company's BSE listing — prices differ by a few paise."}
                {!isIndianListing(symbol) && !symbol.includes("-") && " For US shares TradingView's free chart uses Cboe One prices (one exchange group, 15 minutes delayed), so today's bar and the volumes can differ a little from the built-in chart, which uses all US exchanges. Past days match exactly."}{" "}
                Trade-idea levels can't be drawn on it; they're listed in the card below.
              </p>
              <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
                <TradingViewRating symbol={symbol} />
                <div className="self-center text-[12.5px] leading-relaxed text-fg-2">
                  <p className="text-[13.5px] font-medium text-fg">TradingView's rating — a second opinion</p>
                  <p className="mt-1.5">
                    The gauge is TradingView's own tally of common indicators (moving averages and oscillators) for this symbol: how many say sell, neutral or buy. Use the tabs on it to change the timeframe.
                  </p>
                  <p className="mt-1.5 text-muted">
                    It is a different method from the Trade idea below, so the two can disagree. Neither is a prediction; when they disagree, that is a reason for caution, not a tie-breaker.
                  </p>
                </div>
              </div>
            </>
          ) : err ? (
            <div className="py-10 text-center">
              <p className="mx-auto max-w-[520px] text-[12.5px] leading-relaxed text-danger">{err}</p>
              <Button className="mt-3" variant="primary" onClick={() => setChart("tradingview")}>
                Show TradingView's chart instead
              </Button>
            </div>
          ) : loading && !h ? (
            <div className="grid h-[300px] place-items-center">
              <Loader2 size={18} className="animate-spin text-muted" />
            </div>
          ) : h && table ? (
            <PriceTable candles={h.candles} range={range} />
          ) : (
            h && (
              <>
                {h.stale && (
                  <p className="mb-2 text-[12px] text-warn">Showing the last prices NEXUS has — the price service isn't answering right now.</p>
                )}
                <div className="mb-2">
                  <ChartLegend mode={mode} showSma20={sma20} showSma50={sma50} />
                </div>
                <div className={cls("transition-opacity", loading && "opacity-60")}>
                  <PriceChart candles={h.candles} range={range} mode={mode} showSma20={sma20} showSma50={sma50} showRsi={showRsi} levels={levels} label={q?.name ?? symbol} />
                </div>
              </>
            )
          )}
        </div>
      </section>

      <Ideas symbol={symbol} capital={portfolio?.equity ?? null} currency={q?.currency || portfolio?.currency || ""} onLevels={setLevels} />

      <div className="flex items-center gap-3">
        <Segmented value={account} onChange={setAccount} options={[{ value: "practice", label: "Practice money" }, { value: "real", label: "Real money · Zerodha" }]} />
        <span className="text-[11.5px] text-muted">{account === "practice" ? "Pretend money — nothing here is a real order." : "Real orders, each after a review and your confirmation."}</span>
      </div>
      {account === "real" && <LiveTrading symbol={symbol} />}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {account === "practice" && <Ticket symbol={symbol} quote={q ?? null} portfolio={portfolio} onChanged={onChanged} />}
        <div className={account === "practice" ? "" : "lg:col-span-2"}>
          <Alerts symbol={symbol} quote={q ?? null} alerts={alerts} onChanged={onChanged} />
        </div>
      </div>
    </>
  );
}

function PriceTable({ candles, range }: { candles: Candle[]; range: ChartRange }) {
  const rows = [...candles].reverse().slice(0, 120);
  const intraday = range === "1d" || range === "5d";
  return (
    <div className="max-h-[380px] overflow-y-auto rounded-xl border border-white/[0.07]">
      <table className="w-full text-right font-mono text-[12px]">
        <thead className="sticky top-0 bg-[rgba(20,22,27,0.95)] text-[11px] text-muted">
          <tr>
            <th className="px-3 py-2 text-left font-normal">{intraday ? "Time" : "Date"}</th>
            {["Open", "High", "Low", "Close", "Volume"].map((x) => (
              <th key={x} className="px-3 py-2 font-normal">{x}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.t} className="border-t border-white/[0.05] text-fg-2">
              <td className="px-3 py-1.5 text-left font-sans">
                {new Date(c.t * 1000).toLocaleString(undefined, intraday ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" })}
              </td>
              <td className="px-3 py-1.5">{formatPrice(c.o)}</td>
              <td className="px-3 py-1.5">{formatPrice(c.h)}</td>
              <td className="px-3 py-1.5">{formatPrice(c.l)}</td>
              <td className="px-3 py-1.5 text-fg">{formatPrice(c.c)}</td>
              <td className="px-3 py-1.5">{c.v ? formatVolume(c.v) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Ticket({ symbol, quote, portfolio, onChanged }: { symbol: string; quote: Quote | null; portfolio: Portfolio | null; onChanged: () => Promise<void> }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const n = Number(qty);
  const valid = Number.isFinite(n) && n > 0;
  const held = portfolio?.positions.find((p) => p.symbol === symbol)?.quantity ?? 0;
  const currency = portfolio?.currency ?? quote?.currency ?? "USD";
  const est = quote && valid ? quote.price * n : null;
  const differs = Boolean(quote?.currency && portfolio && quote.currency !== portfolio.currency);
  // Nothing traded yet: the practice account simply opens in the currency of the first thing you buy.
  const untouched = Boolean(portfolio && portfolio.positions.length === 0 && portfolio.cash === portfolio.starting_cash);
  const willSwitch = differs && untouched && ["INR", "USD", "EUR", "GBP"].includes(quote?.currency ?? "");
  const mismatch = differs && !willSwitch;

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<Order>("/api/markets/orders", { symbol, side, quantity: n });
      setMsg({
        ok: true,
        text: `Practice ${side === "buy" ? "bought" : "sold"} ${r.quantity} ${r.symbol} at ${formatPrice(r.price)}${r.realized_pnl != null ? ` · ${r.realized_pnl >= 0 ? "gain" : "loss"} ${money(Math.abs(r.realized_pnl), currency)}` : ""}.`,
      });
      await onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Practice trade">
      <div className="flex items-center gap-2">
        <Segmented value={side} onChange={setSide} options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} />
        <Input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" aria-label="Quantity" className="w-28 text-right font-mono" />
        <span className="font-mono text-[12.5px] text-fg-2">{symbol}</span>
        {side === "sell" && held > 0 && (
          <button className="text-[11.5px] text-muted underline underline-offset-2 hover:text-fg-2" onClick={() => setQty(String(held))}>
            all {held}
          </button>
        )}
      </div>
      <dl className="mt-3 space-y-1 text-[12.5px]">
        <div className="flex justify-between">
          <dt className="text-muted">Latest price</dt>
          <dd className="font-mono text-fg-2">{quote ? money(quote.price, quote.currency) : "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Estimated {side === "buy" ? "cost" : "proceeds"}</dt>
          <dd className="font-mono text-fg">{est != null ? money(est, quote?.currency ?? currency) : "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">{side === "buy" ? "Practice cash" : "You hold"}</dt>
          <dd className="font-mono text-fg-2">{side === "buy" ? (willSwitch ? "—" : money(portfolio?.cash, currency)) : `${held} ${symbol}`}</dd>
        </div>
      </dl>
      {willSwitch && (
        <p className="mt-2 text-[12px] text-fg-2">
          Your practice account will be opened in {quote?.currency} for this first trade ({quote?.currency === "INR" ? "₹10,00,000" : "100,000"} of pretend money).
        </p>
      )}
      {mismatch && (
        <p className="mt-2 text-[12px] text-warn">
          {symbol} trades in {quote?.currency}; your practice account is in {portfolio?.currency}. Reset the account in {quote?.currency} to practise with it.
        </p>
      )}
      <Button className="mt-3 w-full" variant="primary" disabled={!valid || busy || !quote || mismatch} onClick={() => void submit()} icon={busy ? <Loader2 size={12} className="animate-spin" /> : undefined}>
        {side === "buy" ? "Buy" : "Sell"} {valid ? qty : ""} {symbol} (practice)
      </Button>
      {msg && <p className={cls("mt-2 text-[12px]", msg.ok ? "text-ok" : "text-danger")}>{msg.text}</p>}
      <p className="mt-2 text-[11px] leading-snug text-muted">Fills instantly at the latest price with pretend money. No broker, no real order.</p>
    </Card>
  );
}

function Alerts({ symbol, quote, alerts, onChanged }: { symbol: string; quote: Quote | null; alerts: Alert[]; onChanged: () => Promise<void> }) {
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [price, setPrice] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const mine = alerts.filter((a) => a.symbol === symbol);
  const others = alerts.filter((a) => a.symbol !== symbol && !a.triggered_at).length;

  const add = async () => {
    setErr(null);
    try {
      await api.post("/api/markets/alerts", { symbol, direction, price: Number(price) });
      setPrice("");
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Card title="Price alerts">
      <p className="mb-2 text-[12.5px] text-fg-2">Tell me when {symbol} goes</p>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Select value={direction} onChange={(v) => setDirection(v as "above" | "below")} options={[{ value: "above", label: "above" }, { value: "below", label: "below" }]} />
        <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder={quote ? formatPrice(quote.price) : "price"} aria-label="Alert price" className="min-w-0 flex-1 text-right font-mono" />
        <Button type="submit" icon={<BellPlus size={12} />} disabled={!(Number(price) > 0)}>
          Add
        </Button>
      </form>
      {err && <p className="mt-2 text-[12px] text-danger">{err}</p>}
      <ul className="mt-3 space-y-1">
        {mine.length === 0 && <li className="text-[12.5px] text-muted">No alerts for {symbol} yet.</li>}
        {mine.map((a) => (
          <li key={a.id} className="flex items-center gap-2 text-[12.5px] text-fg-2">
            <Badge tone={a.triggered_at ? "ok" : "neutral"}>{a.triggered_at ? "reached" : "waiting"}</Badge>
            <span className="flex-1">
              {a.direction} <span className="font-mono text-fg">{formatPrice(a.price)}</span>
              {a.triggered_at && <span className="text-muted"> · hit {formatPrice(a.triggered_price ?? a.price)} {relTime(a.triggered_at)}</span>}
            </span>
            <IconButton label="Remove alert" onClick={() => void api.del(`/api/markets/alerts/${a.id}`).then(onChanged)}>
              <Trash2 size={12} />
            </IconButton>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-snug text-muted">
        Checked every few minutes while NEXUS is running; you get a notification (and one on your phone if that's on).
        {others > 0 && ` ${others} more waiting on other symbols.`}
      </p>
    </Card>
  );
}

function Account({ p, onSelect, onChanged }: { p: Portfolio; onSelect: (s: string) => void; onChanged: () => Promise<void> }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [resetting, setResetting] = useState(false);
  const [cash, setCash] = useState(String(p.starting_cash));
  const [currency, setCurrency] = useState(p.currency);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api.get<Order[]>("/api/markets/orders?limit=12").then(setOrders).catch(() => undefined);
  }, [p.cash, p.since]);

  const reset = async () => {
    setErr(null);
    try {
      await api.post("/api/markets/account/reset", { cash: Number(cash), currency });
      setResetting(false);
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Card
      title="Practice account"
      action={
        resetting ? (
          <span className="flex items-center gap-2">
            <Input value={cash} onChange={(e) => setCash(e.target.value)} inputMode="decimal" aria-label="Starting cash" className="h-7 w-28 text-right font-mono text-[12px]" />
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} aria-label="Currency" className="h-7 w-16 font-mono text-[12px]" />
            <Button size="sm" variant="danger" onClick={() => void reset()}>
              Erase and start over
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setResetting(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => setResetting(true)}>
            Reset
          </Button>
        )
      }
    >
      {err && <p className="mb-2 text-[12px] text-danger">{err}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Total value" value={money(p.equity, p.currency)} />
        <Tile label="Cash" value={money(p.cash, p.currency)} />
        <Tile label="Return since start" value={money(p.total_return, p.currency)} sub={<Change pct={p.total_return_percent} />} />
        <Tile label="Locked-in gains" value={money(p.realized_pnl, p.currency)} />
      </div>
      {!p.fully_priced && <p className="mt-2 text-[11.5px] text-warn">Some holdings couldn't be priced just now, so they're counted at what you paid.</p>}

      <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[1.3fr_1fr]">
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Holdings</p>
          {p.positions.length === 0 ? (
            <p className="text-[12.5px] text-muted">Nothing held yet. Use Practice trade above to buy something.</p>
          ) : (
            <table className="w-full text-right text-[12px]">
              <thead className="text-[11px] text-muted">
                <tr>
                  <th className="py-1 text-left font-normal">Symbol</th>
                  <th className="py-1 font-normal">Qty</th>
                  <th className="py-1 font-normal">Avg cost</th>
                  <th className="py-1 font-normal">Price</th>
                  <th className="py-1 font-normal">Value</th>
                  <th className="py-1 font-normal">Gain / loss</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {p.positions.map((x) => (
                  <tr key={x.symbol} className="cursor-pointer border-t border-white/[0.05] text-fg-2 hover:bg-white/[0.03]" onClick={() => onSelect(x.symbol)}>
                    <td className="py-1.5 text-left font-semibold text-fg">{x.symbol}</td>
                    <td className="py-1.5">{x.quantity}</td>
                    <td className="py-1.5">{formatPrice(x.avg_cost)}</td>
                    <td className="py-1.5">{x.price != null ? formatPrice(x.price) : "—"}</td>
                    <td className="py-1.5 text-fg">{money(x.value, p.currency)}</td>
                    <td className="py-1.5">
                      <Change pct={x.pnl_percent} abs={x.pnl} currency={p.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Recent practice orders</p>
          {orders.length === 0 ? (
            <p className="text-[12.5px] text-muted">No orders yet.</p>
          ) : (
            <ul className="space-y-1 text-[12px]">
              {orders.map((o) => (
                <li key={o.id} className="flex items-center gap-2 text-fg-2">
                  <Badge>{o.side}</Badge>
                  <span className="flex-1 font-mono">
                    {o.quantity} {o.symbol} @ {formatPrice(o.price)}
                  </span>
                  <span className="text-[11px] text-muted">{relTime(o.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="glass-inset rounded-2xl p-3">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="mt-0.5 font-mono text-[15px] font-semibold text-fg">{value}</p>
      {sub && <div className="mt-0.5">{sub}</div>}
    </div>
  );
}

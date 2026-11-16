import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Bot, ExternalLink, Loader2, LogIn, Radar, RefreshCw, ShieldAlert, X } from "lucide-react";
import { api } from "@/lib/api";
import { bus } from "@/lib/events";
import { cls } from "@/lib/format";
import { useCore } from "@/stores/core";
import { Badge, Button, Card, Input, Segmented, Select, Toggle } from "@/components/ui";
import { DOWN, UP, formatPrice, type PriceLevel } from "@/components/PriceChart";

/* ------------------------------------------------------------------ trade ideas */

interface Levels {
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  risk_per_unit: number;
  risk_percent: number;
  next_barrier: number | null;
}
export interface Analysis {
  symbol: string | null;
  name: string | null;
  currency: string | null;
  as_of: string;
  price: number;
  bias: "long" | "short" | "neutral";
  score: number;
  confidence: "low" | "medium";
  verdict: string;
  reasons: { points: number; text: string }[];
  levels: Levels | null;
  indicators: { rsi14: number | null; atr_percent: number | null; from_52w_high_percent: number };
  backtest: { trades: number; win_rate: number | null; total_r: number; average_r: number | null; buy_and_hold_percent: number | null; verdict: string; assumptions: string };
  caveats: string[];
}

const VIEW: Record<Analysis["bias"], { label: string; color: string }> = {
  long: { label: "Go long (buy)", color: UP },
  short: { label: "Go short (sell)", color: DOWN },
  neutral: { label: "Stay out", color: "#aeb3bc" },
};

export function levelsOf(a: Analysis | null): PriceLevel[] {
  if (!a?.levels) return [];
  return [
    { label: "Entry", value: a.levels.entry, kind: "entry" },
    { label: "Stop-loss", value: a.levels.stop, kind: "stop" },
    { label: "Target 1", value: a.levels.target1, kind: "target" },
    { label: "Target 2", value: a.levels.target2, kind: "target" },
  ];
}

/** A rule-based view of one symbol, with levels, its own track record and a position-size helper. */
export function Ideas({ symbol, capital, currency, onLevels }: { symbol: string; capital: number | null; currency: string; onLevels: (l: PriceLevel[]) => void }) {
  const [a, setA] = useState<Analysis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = useState(true);
  const [asking, setAsking] = useState(false);
  const [cap, setCap] = useState(capital ? String(Math.round(capital)) : "100000");
  const [riskPct, setRiskPct] = useState("1");
  const focusTask = useCore((s) => s.focusTask);

  useEffect(() => {
    let live = true;
    setA(null);
    setErr(null);
    api
      .get<Analysis>(`/api/markets/analysis/${encodeURIComponent(symbol)}`)
      .then((r) => live && setA(r))
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [symbol]);
  useEffect(() => onLevels(show ? levelsOf(a) : []), [a, show, onLevels]);
  useEffect(() => () => onLevels([]), [onLevels]);

  const ask = async () => {
    setAsking(true);
    try {
      const t = await api.post<{ id: string }>("/api/agents/trader/tasks", {
        prompt: `Give me your view on ${symbol}: should I go long, go short or stay out? Include entry, stop-loss, targets, why, the track record of the rules, and what would prove you wrong.`,
      });
      focusTask(t.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAsking(false);
    }
  };

  const lv = a?.levels ?? null;
  const capN = Number(cap);
  const riskN = Number(riskPct);
  const qty = lv && capN > 0 && riskN > 0 ? Math.floor((capN * riskN) / 100 / lv.risk_per_unit) : null;

  return (
    <Card
      title="Trade idea"
      action={
        <Button size="sm" icon={asking ? <Loader2 size={12} className="animate-spin" /> : <Bot size={12} />} disabled={asking || !a} onClick={() => void ask()}>
          Ask the Market Analyst
        </Button>
      }
    >
      {err && <p className="text-[12.5px] text-danger">{err}</p>}
      {!a && !err && (
        <p className="flex items-center gap-2 text-[12.5px] text-muted">
          <Loader2 size={13} className="animate-spin" /> Reading five years of prices…
        </p>
      )}
      {a && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13.5px] font-semibold text-fg" style={{ borderColor: VIEW[a.bias].color }}>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: VIEW[a.bias].color }} />
              {VIEW[a.bias].label}
            </span>
            <span className="text-[12px] text-fg-2">
              Score <span className="font-mono text-fg">{a.score > 0 ? "+" : ""}{a.score}</span> of ±100 · confidence <b className="text-fg">{a.confidence}</b>
            </span>
            {lv && (
              <label className="ml-auto flex items-center gap-1.5 text-[11.5px] text-fg-2">
                <Toggle checked={show} onChange={setShow} label="Show levels on the chart" /> Show on chart
              </label>
            )}
          </div>
          <ScoreBar score={a.score} />

          <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Why</p>
              <ul className="space-y-1 text-[12.5px] text-fg-2">
                {a.reasons.map((r, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="w-8 flex-none text-right font-mono text-[11.5px] text-muted">{r.points > 0 ? `+${r.points}` : r.points || "·"}</span>
                    <span>{r.text}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              {lv ? (
                <>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Levels</p>
                  <dl className="space-y-1 font-mono text-[12.5px]">
                    <Line k="Entry (around)" v={formatPrice(lv.entry)} />
                    <Line k="Stop-loss" v={`${formatPrice(lv.stop)}  (${lv.risk_percent}% risk)`} mark={DOWN} />
                    <Line k="Target 1" v={formatPrice(lv.target1)} mark={UP} />
                    <Line k="Target 2" v={formatPrice(lv.target2)} mark={UP} />
                    {lv.next_barrier != null && <Line k={a.bias === "long" ? "Nearest resistance" : "Nearest support"} v={formatPrice(lv.next_barrier)} />}
                  </dl>
                  <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-2.5">
                    <p className="mb-1.5 text-[11.5px] text-fg-2">How many to trade, if a stop-out should cost only a small slice of your money</p>
                    <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-2">
                      <Input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" aria-label="Capital" className="h-7 w-28 text-right font-mono text-[12px]" />
                      <span>{currency} ×</span>
                      <Input value={riskPct} onChange={(e) => setRiskPct(e.target.value)} inputMode="decimal" aria-label="Risk percent" className="h-7 w-14 text-right font-mono text-[12px]" />
                      <span>% risk →</span>
                      <span className="font-mono text-[13px] font-semibold text-fg">{qty != null ? `${qty} units` : "—"}</span>
                    </div>
                    {qty != null && qty > 0 && (
                      <p className="mt-1.5 text-[11.5px] text-muted">
                        Costs about {formatPrice(qty * lv.entry)} {currency}; a stop-out loses about {formatPrice(qty * lv.risk_per_unit)} {currency}.
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-[12.5px] leading-relaxed text-fg-2">
                  The signals don't agree strongly enough for a trade either way. Waiting is a position too — no levels are suggested.
                </p>
              )}
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-2.5 text-[12px] leading-snug text-fg-2">
            <p>
              <b className="text-fg">Track record of these rules on {a.symbol ?? symbol}:</b> {a.backtest.verdict}
            </p>
            <p className="mt-1 text-[11.5px] text-muted">
              {a.backtest.trades} past signals{a.backtest.win_rate != null ? `, ${a.backtest.win_rate}% profitable` : ""}
              {a.backtest.buy_and_hold_percent != null ? ` · just holding returned ${a.backtest.buy_and_hold_percent}%` : ""} · {a.backtest.assumptions}
            </p>
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-snug text-muted">
            <AlertTriangle size={12} className="mt-0.5 flex-none" /> {a.caveats[0]} {a.caveats[1]} As of {a.as_of}.
          </p>
        </>
      )}
    </Card>
  );
}

function ScoreBar({ score }: { score: number }) {
  const pos = ((score + 100) / 200) * 100;
  return (
    <div className="mt-3" role="img" aria-label={`Score ${score} on a scale from minus 100 (bearish) to plus 100 (bullish)`}>
      <div className="relative h-2 rounded-full" style={{ background: `linear-gradient(90deg, ${DOWN}, #383835 35%, #383835 65%, ${UP})` }}>
        <span className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#14161b] bg-white" style={{ left: `${pos}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-muted">
        <span>Bearish</span>
        <span>No edge</span>
        <span>Bullish</span>
      </div>
    </div>
  );
}

function Line({ k, v, mark }: { k: string; v: string; mark?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex items-center gap-1.5 font-sans text-muted">
        {mark && <span className="inline-block w-3 border-t-[1.5px] border-dashed" style={{ borderColor: mark }} />}
        {k}
      </dt>
      <dd className="text-fg">{v}</dd>
    </div>
  );
}

interface ScanRow {
  symbol: string;
  name?: string;
  price?: number;
  bias: Analysis["bias"];
  score: number;
  levels?: Levels | null;
  backtest_total_r?: number;
  backtest_trades?: number;
  error?: string;
}

/** Ranks the whole watchlist: strongest long ideas first, strongest short ideas last. */
export function Scan({ onSelect }: { onSelect: (s: string) => void }) {
  const [rows, setRows] = useState<ScanRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setRows(await api.get<ScanRow[]>("/api/markets/scan"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Where to go long, where to go short"
      action={
        <span className="flex items-center gap-1">
          <Button size="sm" variant="primary" icon={busy ? <Loader2 size={12} className="animate-spin" /> : <Radar size={12} />} disabled={busy} onClick={() => void run()}>
            {rows ? "Scan again" : "Scan my watchlist"}
          </Button>
          {rows && (
            <Button size="sm" variant="ghost" aria-label="Close scan" icon={<X size={12} />} onClick={() => setRows(null)} />
          )}
        </span>
      }
    >
      {err && <p className="text-[12.5px] text-danger">{err}</p>}
      {!rows && !err && <p className="text-[12.5px] text-fg-2">Runs the same rules on every symbol you follow and ranks them from the strongest buy case to the strongest sell case.</p>}
      {rows && rows.length === 0 && <p className="text-[12.5px] text-muted">Add symbols to your watchlist first.</p>}
      {rows && rows.length > 0 && (
        <table className="w-full text-right text-[12px]">
          <thead className="text-[11px] text-muted">
            <tr>
              <th className="py-1 text-left font-normal">Symbol</th>
              <th className="py-1 text-left font-normal">View</th>
              <th className="py-1 font-normal">Score</th>
              <th className="py-1 font-normal">Entry</th>
              <th className="py-1 font-normal">Stop</th>
              <th className="py-1 font-normal">Target</th>
              <th className="py-1 font-normal" title="What these rules made or lost on this symbol in the past, in multiples of the amount risked">Past result</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((r) => (
              <tr key={r.symbol} className="cursor-pointer border-t border-white/[0.05] text-fg-2 hover:bg-white/[0.03]" onClick={() => onSelect(r.symbol)}>
                <td className="py-1.5 text-left font-semibold text-fg">{r.symbol}</td>
                <td className="py-1.5 text-left font-sans">
                  {r.error ? (
                    <span className="text-muted">couldn't analyse</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ background: VIEW[r.bias].color }} /> {VIEW[r.bias].label}
                    </span>
                  )}
                </td>
                <td className="py-1.5">{r.error ? "—" : `${r.score > 0 ? "+" : ""}${r.score}`}</td>
                <td className="py-1.5">{r.levels ? formatPrice(r.levels.entry) : "—"}</td>
                <td className="py-1.5">{r.levels ? formatPrice(r.levels.stop) : "—"}</td>
                <td className="py-1.5">{r.levels ? formatPrice(r.levels.target2) : "—"}</td>
                <td className="py-1.5">{r.backtest_trades ? `${(r.backtest_total_r ?? 0) > 0 ? "+" : ""}${r.backtest_total_r}R / ${r.backtest_trades}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows && <p className="mt-2 text-[11.5px] text-muted">Readings of past prices, not predictions. Click a row for the full reasoning.</p>}
    </Card>
  );
}

/* ------------------------------------------------------------------ real money (Zerodha) */

export interface BrokerStatus {
  brokers: { id: string; name: string; what: string; trading: boolean }[];
  configured: boolean;
  connected: boolean;
  keychain_available: boolean;
  user: { name: string; id: string; exchanges: string[] } | null;
  session_note: string | null;
  redirect_url: string;
  live_enabled: boolean;
  max_order_value: number;
  max_orders_per_day: number;
  orders_today: number;
}
interface LiveAccount {
  funds: { net: number | null; cash: number | null };
  holdings: { tradingsymbol: string; exchange: string; quantity: number; average_price: number; last_price: number; pnl: number; day_change_percentage: number | null }[];
  positions: { tradingsymbol: string; exchange: string; product: string; quantity: number; average_price: number; last_price: number; pnl: number }[];
  orders: { order_id: string; variety: string; status: string; status_message: string | null; tradingsymbol: string; transaction_type: string; quantity: number; filled_quantity: number; price: number; average_price: number; order_type: string; product: string }[];
  mutual_funds: { fund: string; quantity: number; average_price: number; last_price: number; pnl: number }[];
  holdings_value: number;
  holdings_pnl: number;
}
interface Preview {
  order: Record<string, string | number | null>;
  estimated_price: number | null;
  estimated_value: number | null;
  price_source: string;
  warnings: string[];
  confirm_code: string;
  expires_in: number;
}

export function useBroker(): { st: BrokerStatus | null; reload: () => void } {
  const [st, setSt] = useState<BrokerStatus | null>(null);
  const reload = useCallback(() => void api.get<BrokerStatus>("/api/broker").then(setSt).catch(() => undefined), []);
  useEffect(() => {
    reload();
    return bus.on("broker", reload);
  }, [reload]);
  return { st, reload };
}

const inr = (v: number | null | undefined) => (v == null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(v));

/** Symbols from the charts look like INFY.NS; Zerodha wants exchange NSE and symbol INFY. */
function toZerodha(symbol: string): { exchange: string; tradingsymbol: string } {
  if (symbol.endsWith(".NS")) return { exchange: "NSE", tradingsymbol: symbol.slice(0, -3) };
  if (symbol.endsWith(".BO")) return { exchange: "BSE", tradingsymbol: symbol.slice(0, -3) };
  return { exchange: "NSE", tradingsymbol: "" };
}

/** Real orders through Zerodha: review first, then confirm. Nothing is sent without both steps. */
export function LiveTrading({ symbol }: { symbol: string }) {
  const { st, reload } = useBroker();
  const openSettings = useCore((s) => s.openSettings);
  const [acct, setAcct] = useState<LiveAccount | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadAcct = useCallback(() => {
    void api.get<LiveAccount>("/api/broker/account").then((a) => (setAcct(a), setErr(null))).catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(() => {
    if (!st?.connected) return;
    loadAcct();
    const off = bus.on("broker", loadAcct);
    const t = window.setInterval(() => document.visibilityState === "visible" && loadAcct(), 30_000);
    return () => {
      off();
      window.clearInterval(t);
    };
  }, [st?.connected, loadAcct]);

  if (!st) return null;
  if (!st.connected) {
    return (
      <Card title="Real money · Zerodha">
        <p className="text-[12.5px] leading-relaxed text-fg-2">
          {st.session_note ?? (st.configured ? "Your Zerodha keys are saved. Log in to start today's session." : "Connect your Zerodha account to place real orders from here.")}
        </p>
        <Button className="mt-3" variant="primary" icon={<LogIn size={13} />} onClick={() => openSettings("brokers")}>
          {st.configured ? "Log in to Zerodha" : "Connect Zerodha"}
        </Button>
      </Card>
    );
  }
  return (
    <>
      <Card
        title={`Real money · Zerodha · ${st.user?.name ?? st.user?.id ?? ""}`}
        action={
          <span className="flex items-center gap-2">
            <Badge tone={st.live_enabled ? "danger" : "neutral"}>{st.live_enabled ? "Real orders ON" : "Real orders off"}</Badge>
            <Button size="sm" variant="ghost" aria-label="Refresh" icon={<RefreshCw size={12} />} onClick={() => (reload(), loadAcct())} />
          </span>
        }
      >
        {err && <p className="mb-2 text-[12.5px] text-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Available to trade" value={inr(acct?.funds.cash)} />
          <Tile label="Holdings value" value={inr(acct?.holdings_value)} />
          <Tile label="Holdings gain / loss" value={inr(acct?.holdings_pnl)} />
          <Tile label="Real orders today" value={`${st.orders_today}${st.max_orders_per_day ? ` of ${st.max_orders_per_day}` : ""}`} />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <LiveTicket symbol={symbol} st={st} onPlaced={() => (reload(), loadAcct())} />
          <div className="min-w-0 space-y-4">
            <MiniTable
              title="Today's orders"
              empty="No orders today."
              head={["Order", "Status", ""]}
              rows={(acct?.orders ?? []).slice(0, 8).map((o) => [
                `${o.transaction_type} ${o.quantity} ${o.tradingsymbol} ${o.order_type}${o.price ? ` @ ${formatPrice(o.price)}` : ""}`,
                <span key="s" title={o.status_message ?? ""}>{o.status}{o.filled_quantity ? ` (${o.filled_quantity} filled)` : ""}</span>,
                ["OPEN", "TRIGGER PENDING", "AMO REQ RECEIVED"].includes(o.status) ? (
                  <button key="c" className="text-[11.5px] text-muted underline underline-offset-2 hover:text-fg" onClick={() => void api.del(`/api/broker/orders/${o.order_id}?variety=${o.variety}`).then(loadAcct).catch((e: Error) => setErr(e.message))}>
                    Cancel
                  </button>
                ) : "",
              ])}
            />
            <MiniTable
              title="Open positions"
              empty="No open positions."
              head={["Position", "Avg", "Gain / loss"]}
              rows={(acct?.positions ?? []).map((p) => [`${p.quantity} ${p.tradingsymbol} · ${p.product}`, formatPrice(p.average_price), inr(p.pnl)])}
            />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <MiniTable
            title="Holdings"
            empty="No holdings."
            head={["Holding", "Avg → now", "Gain / loss"]}
            rows={(acct?.holdings ?? []).map((h) => [`${h.quantity} ${h.tradingsymbol}`, `${formatPrice(h.average_price)} → ${formatPrice(h.last_price)}`, inr(h.pnl)])}
          />
          <MiniTable
            title="Mutual funds (Coin)"
            empty="No mutual funds, or Coin data isn't available on this plan."
            head={["Fund", "Units", "Gain / loss"]}
            rows={(acct?.mutual_funds ?? []).map((f) => [f.fund, String(f.quantity), inr(f.pnl)])}
          />
        </div>
      </Card>
    </>
  );
}

function LiveTicket({ symbol, st, onPlaced }: { symbol: string; st: BrokerStatus; onPlaced: () => void }) {
  const guess = toZerodha(symbol);
  const [o, setO] = useState({ exchange: guess.exchange, tradingsymbol: guess.tradingsymbol, transaction_type: "BUY", quantity: "1", product: "CNC", order_type: "LIMIT", price: "", trigger_price: "", variety: "regular" });
  const [pv, setPv] = useState<Preview | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const openSettings = useCore((s) => s.openSettings);
  useEffect(() => setO((cur) => ({ ...cur, ...toZerodha(symbol) })), [symbol]);

  const body = () => ({ ...o, quantity: Number(o.quantity), price: o.price ? Number(o.price) : null, trigger_price: o.trigger_price ? Number(o.trigger_price) : null });
  const review = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setPv(await api.post<Preview>("/api/broker/orders/preview", body()));
      setAgree(false);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const place = async () => {
    if (!pv) return;
    setBusy(true);
    try {
      const r = await api.post<{ order_id: string; note: string }>("/api/broker/orders", { ...body(), confirm_code: pv.confirm_code });
      setMsg({ ok: true, text: `Order ${r.order_id} sent. ${r.note}` });
      setPv(null);
      onPlaced();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      setPv(null);
    } finally {
      setBusy(false);
    }
  };
  const fno = ["NFO", "BFO", "MCX", "CDS", "BCD"].includes(o.exchange);
  const needsPrice = o.order_type === "LIMIT" || o.order_type === "SL";
  const needsTrigger = o.order_type === "SL" || o.order_type === "SL-M";

  return (
    <div className="min-w-0">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Place a real order</p>
      {!st.live_enabled && (
        <p className="mb-2 rounded-xl border border-white/10 bg-white/[0.04] p-2.5 text-[12px] text-fg-2">
          Real orders are switched off.{" "}
          <button className="underline underline-offset-2 hover:text-fg" onClick={() => openSettings("brokers")}>
            Turn them on in Settings → Brokers
          </button>
          .
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Segmented value={o.transaction_type} onChange={(v) => setO({ ...o, transaction_type: v })} options={[{ value: "BUY", label: "Buy" }, { value: "SELL", label: "Sell" }]} />
        <Select value={o.exchange} onChange={(v) => setO({ ...o, exchange: v, product: ["NFO", "BFO", "MCX", "CDS", "BCD"].includes(v) ? "NRML" : "CNC" })} options={["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"].map((x) => ({ value: x, label: x }))} />
        <Input value={o.tradingsymbol} onChange={(e) => setO({ ...o, tradingsymbol: e.target.value.toUpperCase() })} placeholder="Symbol, e.g. INFY" aria-label="Zerodha symbol" className="font-mono" />
        <Input value={o.quantity} onChange={(e) => setO({ ...o, quantity: e.target.value })} inputMode="numeric" placeholder="Quantity" aria-label="Quantity" className="text-right font-mono" />
        <Select
          value={o.product}
          onChange={(v) => setO({ ...o, product: v })}
          options={fno ? [{ value: "NRML", label: "NRML · carry forward" }, { value: "MIS", label: "MIS · intraday" }] : [{ value: "CNC", label: "CNC · delivery" }, { value: "MIS", label: "MIS · intraday" }, { value: "MTF", label: "MTF · margin" }]}
        />
        <Select value={o.order_type} onChange={(v) => setO({ ...o, order_type: v })} options={[{ value: "LIMIT", label: "Limit" }, { value: "MARKET", label: "Market" }, { value: "SL", label: "Stop-loss limit" }, { value: "SL-M", label: "Stop-loss market" }]} />
        {needsPrice && <Input value={o.price} onChange={(e) => setO({ ...o, price: e.target.value })} inputMode="decimal" placeholder="Price ₹" aria-label="Price" className="text-right font-mono" />}
        {needsTrigger && <Input value={o.trigger_price} onChange={(e) => setO({ ...o, trigger_price: e.target.value })} inputMode="decimal" placeholder="Trigger price ₹" aria-label="Trigger price" className="text-right font-mono" />}
        <Select value={o.variety} onChange={(v) => setO({ ...o, variety: v })} options={[{ value: "regular", label: "Now (market hours)" }, { value: "amo", label: "After-market order" }]} />
      </div>
      <Button className="mt-3 w-full" disabled={busy || !o.tradingsymbol || !(Number(o.quantity) > 0)} icon={busy && !pv ? <Loader2 size={12} className="animate-spin" /> : undefined} onClick={() => void review()}>
        Review order
      </Button>
      {msg && <p className={cls("mt-2 text-[12px] leading-snug", msg.ok ? "text-ok" : "text-danger")}>{msg.text}</p>}
      <p className="mt-2 text-[11px] leading-snug text-muted">
        Limit per order {st.max_order_value ? inr(st.max_order_value) : "none"}. Nothing is sent until you confirm on the next screen.
      </p>

      {pv && createPortal(
        // Rendered at the top of the page: a glass card would otherwise trap the dialog inside itself.
        <div className="fixed inset-0 z-[90] grid place-items-center bg-black/70 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="Confirm real order">
          <div className="silver-edge w-[460px] max-w-[92vw] rounded-[24px] border border-white/15 bg-[#17191f] p-6 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]">
            <div className="flex items-center gap-2.5">
              <ShieldAlert size={18} style={{ color: DOWN }} />
              <h3 className="text-[16px] font-semibold text-fg">Send this real order to Zerodha?</h3>
            </div>
            <p className="mt-3 text-[20px] font-semibold tracking-tight text-fg">
              {pv.order.transaction_type} {pv.order.quantity} × {pv.order.tradingsymbol}
            </p>
            <dl className="mt-3 space-y-1 text-[12.5px]">
              <Line k="Exchange" v={String(pv.order.exchange)} />
              <Line k="Order type" v={`${pv.order.order_type}${pv.order.price ? ` at ₹${formatPrice(Number(pv.order.price))}` : ""}${pv.order.trigger_price ? ` · trigger ₹${formatPrice(Number(pv.order.trigger_price))}` : ""}`} />
              <Line k="Product" v={String(pv.order.product)} />
              <Line k="When" v={pv.order.variety === "amo" ? "After-market order" : "Now"} />
              <Line k="Estimated value" v={`${inr(pv.estimated_value)}${pv.price_source ? ` (${pv.price_source})` : ""}`} />
            </dl>
            {pv.warnings.length > 0 && (
              <ul className="mt-3 space-y-1.5 rounded-xl border border-warn/30 bg-warn/[0.06] p-2.5 text-[12px] leading-snug text-fg-2">
                {pv.warnings.map((w) => (
                  <li key={w} className="flex gap-1.5">
                    <AlertTriangle size={12} className="mt-0.5 flex-none text-warn" /> {w}
                  </li>
                ))}
              </ul>
            )}
            <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[12.5px] text-fg">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 h-4 w-4" />
              I understand this uses real money from my Zerodha account and can lose money.
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPv(null)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={!agree || busy} icon={busy ? <Loader2 size={12} className="animate-spin" /> : undefined} onClick={() => void place()}>
                Place real order
              </Button>
            </div>
            <p className="mt-2 text-right text-[11px] text-muted">This review is valid for {Math.round(pv.expires_in / 60)} minutes.</p>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-inset rounded-2xl p-3">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="mt-0.5 font-mono text-[15px] font-semibold text-fg">{value}</p>
    </div>
  );
}

function MiniTable({ title, head, rows, empty }: { title: string; head: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">{title}</p>
      {rows.length === 0 ? (
        <p className="text-[12.5px] text-muted">{empty}</p>
      ) : (
        <table className="w-full text-[12px]">
          <thead className="text-[11px] text-muted">
            <tr>
              {head.map((h, i) => (
                <th key={i} className={cls("py-1 font-normal", i === 0 ? "text-left" : "text-right")}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-white/[0.05] text-fg-2">
                {r.map((c, j) => (
                  <td key={j} className={cls("py-1.5", j === 0 ? "text-left font-mono text-fg" : "text-right font-mono")}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Settings → Brokers */

type SetFn = (k: string, v: unknown) => Promise<void>;

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line-soft py-3 last:border-0">
      <div className="min-w-0">
        <p className="text-[13px] text-fg">{label}</p>
        {hint && <p className="text-[11.5px] leading-snug text-muted">{hint}</p>}
      </div>
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  );
}

function Secret({ account, label, onSaved }: { account: string; label: string; onSaved: () => void }) {
  const [has, setHas] = useState(false);
  const [v, setV] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => void api.get<{ secrets: Record<string, boolean> }>("/api/secrets").then((r) => setHas(Boolean(r.secrets[account]))), [account]);
  useEffect(load, [load]);
  return (
    <Row label={label} hint="Kept in the macOS Keychain. NEXUS never shows it again and never writes it to a file or log.">
      {has && <Badge tone="ok">saved</Badge>}
      <Input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder={has ? "Replace…" : "Paste here"} className="w-52" aria-label={label} />
      <Button size="sm" disabled={!v} onClick={() => void api.post("/api/secrets", { account, value: v }).then(() => (setV(""), setMsg(null), load(), onSaved())).catch((e: Error) => setMsg(e.message))}>
        Save
      </Button>
      {msg && <span className="max-w-[180px] text-[11px] text-danger">{msg}</span>}
    </Row>
  );
}

export function BrokerSettings({ values, set }: { values: Record<string, unknown>; set: SetFn }) {
  const { st, reload } = useBroker();
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [maxValue, setMaxValue] = useState("");
  const [maxOrders, setMaxOrders] = useState("");
  useEffect(() => {
    setMaxValue(String(values["trading.max_order_value"] ?? 25000));
    setMaxOrders(String(values["trading.max_orders_per_day"] ?? 20));
  }, [values]);

  const login = async () => {
    setErr(null);
    try {
      const r = await api.post<{ url: string; opened: boolean }>("/api/broker/zerodha/login");
      setLoginUrl(r.opened ? null : r.url);
      if (!r.opened) window.open(r.url, "_blank", "noopener");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (!st) return null;
  return (
    <div className="space-y-4">
      <Card title="Broker">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {st.brokers.map((b) => (
            <div key={b.id} className={cls("rounded-2xl border p-3", b.trading ? "border-white/25 bg-white/[0.07]" : "border-white/[0.08] bg-white/[0.03]")}>
              <p className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
                {b.name} {b.trading ? <Badge tone="accent">Trading</Badge> : <Badge>View only</Badge>}
              </p>
              <p className="mt-0.5 text-[12px] text-fg-2">{b.what}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11.5px] leading-snug text-muted">
          Both use the same Zerodha login. Zerodha's other brands (Streak, Sensibull, smallcase, Varsity) aren't brokers with their own order systems, so there is nothing separate to connect.
        </p>
      </Card>

      <Card title="Connect Zerodha">
        <ol className="mb-3 list-decimal space-y-1.5 pl-4 text-[12.5px] leading-relaxed text-fg-2">
          <li>
            At <span className="font-mono text-fg">developers.kite.trade</span>, create an app. The <b className="text-fg">Personal</b> type is free and is enough to place orders.
          </li>
          <li>
            Set its redirect URL to exactly: <span className="selectable break-all font-mono text-fg">{st.redirect_url}</span>
          </li>
          <li>
            Register your <b className="text-fg">static IP address</b> for the app. Since April 2026 Zerodha only accepts API orders from a registered static IP; most home internet connections change address, so ask your provider for a static one if orders are refused.
          </li>
          <li>Paste the app's API key and secret below, then log in. Zerodha ends every session at 6 AM, so you log in once each trading day.</li>
        </ol>
        {!st.keychain_available && <p className="mb-2 text-[12.5px] text-warn">The macOS Keychain isn't available here, so keys can't be saved on this machine.</p>}
        <Secret account="broker.zerodha.api_key" label="API key" onSaved={reload} />
        <Secret account="broker.zerodha.api_secret" label="API secret" onSaved={reload} />
        <Row
          label={st.connected ? `Connected as ${st.user?.name ?? st.user?.id}` : "Not logged in"}
          hint={st.session_note ?? (st.connected ? "Today's session is active." : st.configured ? "Opens Zerodha's own login page in your browser." : "Save the key and secret first.")}
        >
          {st.connected && (
            <Button size="sm" variant="ghost" onClick={() => void api.post("/api/broker/disconnect", { forget_keys: false }).then(reload)}>
              Log out
            </Button>
          )}
          <Button size="sm" variant="primary" icon={<ExternalLink size={12} />} disabled={!st.configured} onClick={() => void login()}>
            {st.connected ? "Log in again" : "Log in to Zerodha"}
          </Button>
        </Row>
        {loginUrl && (
          <p className="mt-2 text-[12px] text-fg-2">
            If your browser didn't open, copy this address into it: <span className="selectable break-all font-mono text-[11px] text-muted">{loginUrl}</span>
          </p>
        )}
        {err && <p className="mt-2 text-[12px] text-danger">{err}</p>}
        {st.configured && (
          <button className="mt-2 text-[11.5px] text-muted underline underline-offset-2 hover:text-fg-2" onClick={() => void api.post("/api/broker/disconnect", { forget_keys: true }).then(reload)}>
            Remove Zerodha from this Mac (forgets the key, secret and session)
          </button>
        )}
      </Card>

      <Card title="Safety limits for real orders">
        <Row label="Allow real orders" hint="Off: NEXUS can show your account but cannot send an order. On: you can place orders, each after a review screen and a confirmation.">
          <Toggle checked={Boolean(values["trading.live_enabled"])} onChange={(v) => void set("trading.live_enabled", v)} />
        </Row>
        <Row label="Largest single order" hint="Orders worth more than this are refused before they reach Zerodha. 0 removes the limit.">
          <span className="text-[12.5px] text-muted">₹</span>
          <Input value={maxValue} onChange={(e) => setMaxValue(e.target.value)} onBlur={() => Number(maxValue) >= 0 && void set("trading.max_order_value", Number(maxValue))} inputMode="numeric" className="w-28 text-right font-mono" aria-label="Largest single order" />
        </Row>
        <Row label="Most real orders in a day" hint="A brake on over-trading. 0 removes the limit.">
          <Input value={maxOrders} onChange={(e) => setMaxOrders(e.target.value)} onBlur={() => Number(maxOrders) >= 0 && void set("trading.max_orders_per_day", Number(maxOrders))} inputMode="numeric" className="w-20 text-right font-mono" aria-label="Most real orders in a day" />
        </Row>
        <p className="mt-3 text-[11.5px] leading-snug text-muted">
          Only you can place a real order, on this Mac. Agents and automations have no way to send one, paired phones are refused, and the emergency stop blocks all orders. Every order and every refusal is in the audit log.
        </p>
      </Card>
    </div>
  );
}

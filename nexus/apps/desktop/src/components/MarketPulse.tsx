import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { cls } from "@/lib/format";
import { useCore } from "@/stores/core";
import { DOWN, UP, formatPrice } from "./PriceChart";

interface Index {
  name: string;
  last: number;
  change: number;
  change_percent: number;
  symbol: string | null;
}
interface Mover {
  symbol: string;
  name: string;
  price: number;
  change_percent: number;
}
export interface Overview {
  indices: Index[];
  gainers: Mover[];
  losers: Mover[];
  market_open: boolean;
  stale?: boolean;
  source: string;
}

function Pct({ v }: { v: number }) {
  const up = v >= 0;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px] text-fg-2">
      <span aria-hidden style={{ color: up ? UP : DOWN }}>{up ? "▲" : "▼"}</span>
      <span className="sr-only">{up ? "up" : "down"}</span>
      {Math.abs(v).toFixed(2)}%
    </span>
  );
}

export function useOverview(enabled: boolean): { data: Overview | null; error: string | null } {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () =>
      void api
        .get<Overview>("/api/markets/overview")
        .then((d) => live && (setData(d), setError(null)))
        .catch((e: Error) => live && setError(e.message));
    load();
    const t = window.setInterval(() => document.visibilityState === "visible" && load(), 90_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [enabled]);
  return { data, error };
}

/** Indian market at a glance: headline indices and the Nifty 50's biggest movers. Click anything to open its chart. */
export function MarketPulse({ onSelect, compact = false }: { onSelect: (symbol: string) => void; compact?: boolean }) {
  const enabled = useCore((s) => Boolean(s.boot?.markets?.enabled));
  const { data, error } = useOverview(enabled);
  if (!enabled) return null;
  if (error && !data) return compact ? null : <section className="surface p-4 text-[12.5px] text-muted">Today's market: {error}</section>;
  if (!data)
    return (
      <section className="surface flex items-center gap-2 p-4 text-[12.5px] text-muted">
        <Loader2 size={13} className="animate-spin" /> Loading today's market…
      </section>
    );
  const indices = compact ? data.indices.slice(0, 3) : data.indices;
  return (
    <section className={cls("surface rise", compact ? "p-4" : "p-5")}>
      <header className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-muted">Today's market</h3>
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <span className={cls("h-1.5 w-1.5 rounded-full", data.market_open ? "bg-ok" : "bg-white/30")} />
          {data.market_open ? "Open" : "Closed"}
          {data.stale && " · last known"}
        </span>
      </header>
      <div className={cls("grid gap-2", compact ? "grid-cols-3" : "grid-cols-2 md:grid-cols-5")}>
        {indices.map((ix) => (
          <button
            key={ix.name}
            disabled={!ix.symbol}
            onClick={() => ix.symbol && onSelect(ix.symbol)}
            className="glass-inset press rounded-2xl p-2.5 text-left enabled:hover:bg-white/[0.06]"
          >
            <p className="truncate text-[11px] text-muted">{ix.name}</p>
            <p className="font-mono text-[14px] font-semibold text-fg">{formatPrice(ix.last)}</p>
            <Pct v={ix.change_percent} />
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4">
        {(["gainers", "losers"] as const).map((k) => (
          <div key={k} className="min-w-0">
            <p className="mb-1 text-[11px] text-muted">{k === "gainers" ? "Top gainers · Nifty 50" : "Top losers · Nifty 50"}</p>
            {data[k].slice(0, compact ? 3 : 5).map((m) => (
              <button key={m.symbol} onClick={() => onSelect(m.symbol)} className="press flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-white/[0.05]">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">{m.name}</span>
                <span className="font-mono text-[12px] text-fg-2">{formatPrice(m.price)}</span>
                <Pct v={m.change_percent} />
              </button>
            ))}
            {data[k].length === 0 && <p className="text-[12px] text-muted">—</p>}
          </div>
        ))}
      </div>
      {!compact && <p className="mt-2 text-[11px] text-muted">From NSE India's official free service; can lag a few minutes. Click anything to see its chart and trade idea.</p>}
    </section>
  );
}

import { useEffect, useState } from "react";
import { connection } from "@/lib/api";

/** Our watchlist symbols follow Yahoo's style (INFY.NS, BTC-USD, ^NSEI); TradingView writes them differently. */
const INDEX: Record<string, string> = {
  "^NSEI": "NSE:NIFTY", "^NSEBANK": "NSE:BANKNIFTY", "^BSESN": "BSE:SENSEX", "^GSPC": "SP:SPX", "^IXIC": "NASDAQ:IXIC",
  "^DJI": "DJ:DJI", "^FTSE": "FTSE:UKX", "^N225": "TVC:NI225",
};

export function tradingViewSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (INDEX[s]) return INDEX[s]!;
  if (s.endsWith(".NS")) return `NSE:${s.slice(0, -3).replace(/-/g, "_")}`;
  if (s.endsWith(".BO")) return `BSE:${s.slice(0, -3)}`;
  const crypto = s.match(/^([A-Z0-9]{2,10})-(USD|USDT|EUR|INR)$/);
  if (crypto) return `${crypto[1]}${crypto[2]}`;
  if (s.endsWith("=X")) return `FX_IDC:${s.slice(0, -2)}`;
  return s.replace(/^\^/, "").replace(/-/g, ".");
}

/**
 * TradingView's own interactive chart (the embeddable version of Supercharts): indicators, drawing tools,
 * every timeframe, their exchange data. It is shown in a sandboxed frame served by the NEXUS core, so
 * TradingView's code is walled off from NEXUS — it only learns which symbol you are viewing.
 */
export function TradingViewChart({ symbol, height = 560 }: { symbol: string; height?: number }) {
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => void connection().then((c) => setBase(c.baseUrl)), []);
  if (!base) return <div style={{ height }} />;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
  const src = `${base}/api/tradingview?symbol=${encodeURIComponent(tradingViewSymbol(symbol))}&interval=D&tz=${encodeURIComponent(tz)}`;
  return (
    <iframe
      key={src}
      src={src}
      title={`TradingView chart for ${symbol}`}
      // No "allow-same-origin": the frame gets an isolated origin and cannot read anything of NEXUS's.
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
      referrerPolicy="no-referrer"
      loading="lazy"
      className="block w-full rounded-xl border border-white/[0.07] bg-[#14161b]"
      style={{ height }}
    />
  );
}

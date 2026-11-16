import { useEffect, useState } from "react";
import { connection } from "@/lib/api";

/** Our watchlist symbols follow Yahoo's style (INFY.NS, BTC-USD, ^NSEI); TradingView writes them differently. */
const INDEX: Record<string, string> = {
  "^NSEI": "BSE:SENSEX", "^BSESN": "BSE:SENSEX", "^GSPC": "SP:SPX", "^IXIC": "NASDAQ:IXIC", "^DJI": "DJ:DJI", "^FTSE": "FTSE:UKX", "^N225": "TVC:NI225",
};

/**
 * TradingView does not allow NSE prices in embedded charts ("only available on TradingView"), so Indian
 * shares are shown through their BSE listing: same company, prices within a few paise. Checked against
 * the real widget (Nov 2026): BSE:INFY and BSE:RELIANCE load, NSE:INFY does not.
 */
export function tradingViewSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (INDEX[s]) return INDEX[s]!;
  if (s.endsWith(".NS") || s.endsWith(".BO")) return `BSE:${s.slice(0, -3).replace(/[-&]/g, "_")}`;
  const crypto = s.match(/^([A-Z0-9]{2,10})-(USD|USDT|EUR|INR)$/);
  if (crypto) return `${crypto[1]}${crypto[2]}`;
  if (s.endsWith("=X")) return `FX_IDC:${s.slice(0, -2)}`;
  return s.replace(/^\^/, "").replace(/-/g, ".");
}

export const isIndianListing = (symbol: string) => /\.(NS|BO)$/i.test(symbol) || symbol.toUpperCase() === "^NSEI";

/**
 * The frame is loaded from "localhost", while the app talks to its core at "127.0.0.1": to a browser those are
 * different sites. So TradingView's script gets a working, ordinary web origin (it shows nothing without one —
 * tested) that is nevertheless empty: no NEXUS data, no token, and every NEXUS request needs a token it doesn't have.
 */
function frameBase(apiBase: string): string {
  return apiBase.replace("://127.0.0.1", "://localhost");
}

const SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms";

function useFrameBase(): string | null {
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => void connection().then((c) => setBase(frameBase(c.baseUrl))), []);
  return base;
}

/**
 * TradingView's own interactive chart (the embeddable version of Supercharts): indicators, drawing tools,
 * every timeframe, their data. TradingView learns which symbol you are viewing and nothing else.
 */
export function TradingViewChart({ symbol, height = 580 }: { symbol: string; height?: number }) {
  const base = useFrameBase();
  if (!base) return <div style={{ height }} />;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
  const src = `${base}/api/tradingview?symbol=${encodeURIComponent(tradingViewSymbol(symbol))}&interval=D&tz=${encodeURIComponent(tz)}`;
  return (
    <iframe key={src} src={src} title={`TradingView chart for ${symbol}`} sandbox={SANDBOX} referrerPolicy="no-referrer" loading="lazy"
      className="block w-full rounded-xl border border-white/[0.07] bg-[#14161b]" style={{ height }} />
  );
}

/** TradingView's summary of its own indicators for the symbol: a gauge from "Strong sell" to "Strong buy". */
export function TradingViewRating({ symbol, height = 400 }: { symbol: string; height?: number }) {
  const base = useFrameBase();
  if (!base) return <div style={{ height }} />;
  const src = `${base}/api/tradingview?widget=technical-analysis&symbol=${encodeURIComponent(tradingViewSymbol(symbol))}`;
  return (
    <iframe key={src} src={src} title={`TradingView technical rating for ${symbol}`} sandbox={SANDBOX} referrerPolicy="no-referrer" loading="lazy"
      className="block w-full rounded-xl border border-white/[0.07] bg-[#14161b]" style={{ height }} />
  );
}

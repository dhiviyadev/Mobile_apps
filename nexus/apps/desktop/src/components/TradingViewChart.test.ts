import { describe, expect, it } from "vitest";
import { tradingViewSymbol } from "./TradingViewChart";

describe("TradingView symbol mapping", () => {
  it("translates the watchlist's symbols", () => {
    expect(tradingViewSymbol("INFY.NS")).toBe("NSE:INFY");
    expect(tradingViewSymbol("BAJAJ-AUTO.NS")).toBe("NSE:BAJAJ_AUTO");
    expect(tradingViewSymbol("500325.BO")).toBe("BSE:500325");
    expect(tradingViewSymbol("btc-usd")).toBe("BTCUSD");
    expect(tradingViewSymbol("^NSEI")).toBe("NSE:NIFTY");
    expect(tradingViewSymbol("AAPL")).toBe("AAPL");
    expect(tradingViewSymbol("BRK-B")).toBe("BRK.B");
    expect(tradingViewSymbol("EURUSD=X")).toBe("FX_IDC:EURUSD");
  });
});

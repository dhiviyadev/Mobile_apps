import { describe, expect, it } from "vitest";
import { tradingViewSymbol } from "./TradingViewChart";

describe("TradingView symbol mapping", () => {
  it("translates the watchlist's symbols", () => {
    // NSE isn't allowed in TradingView's embedded charts, so Indian shares use the BSE listing.
    expect(tradingViewSymbol("INFY.NS")).toBe("BSE:INFY");
    expect(tradingViewSymbol("BAJAJ-AUTO.NS")).toBe("BSE:BAJAJ_AUTO");
    expect(tradingViewSymbol("M&M.NS")).toBe("BSE:M_M");
    expect(tradingViewSymbol("500325.BO")).toBe("BSE:500325");
    expect(tradingViewSymbol("btc-usd")).toBe("BTCUSD");
    expect(tradingViewSymbol("^NSEI")).toBe("BSE:SENSEX");
    expect(tradingViewSymbol("AAPL")).toBe("AAPL");
    expect(tradingViewSymbol("BRK-B")).toBe("BRK.B");
    expect(tradingViewSymbol("EURUSD=X")).toBe("FX_IDC:EURUSD");
  });
});

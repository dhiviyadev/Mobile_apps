import { describe, expect, it } from "vitest";
import { formatVolume, niceTicks, rsi, sma, type Candle } from "./PriceChart";

const bar = (c: number, i: number): Candle => ({ t: i, o: c, h: c, l: c, c, v: 0 });

describe("price chart maths", () => {
  it("computes a simple moving average and leaves the warm-up bars empty", () => {
    expect(sma([1, 2, 3, 4, 5].map(bar), 3)).toEqual([null, null, 2, 3, 4]);
    expect(sma([], 20)).toEqual([]);
  });

  it("picks round axis ticks inside the range", () => {
    expect(niceTicks(218, 252, 5)).toEqual([220, 230, 240, 250]);
    const t = niceTicks(0.0312, 0.0388, 5);
    expect(t.every((v) => v >= 0.0312 && v <= 0.0388)).toBe(true);
    expect(niceTicks(5, 5)).toEqual([5]);
  });

  it("computes RSI with Wilder's smoothing", () => {
    // Wilder's own worked example (first RSI value ≈ 70.5 after 14 changes).
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03];
    const out = rsi(closes.map(bar), 14);
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(out[14]!).toBeCloseTo(70.46, 1);
    expect(out[15]!).toBeCloseTo(66.25, 1);
    expect(rsi([1, 2, 3].map(bar), 14)).toEqual([null, null, null]);
    expect(rsi(Array.from({ length: 20 }, (_, i) => bar(i + 1, i)), 14)[19]).toBe(100); // only gains
  });

  it("shortens volumes", () => {
    expect([formatVolume(950), formatVolume(18_670_000), formatVolume(2_400_000_000)]).toEqual(["950", "18.67M", "2.40B"]);
  });
});

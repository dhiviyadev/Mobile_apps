import { describe, expect, it } from "vitest";
import { formatVolume, niceTicks, sma, type Candle } from "./PriceChart";

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

  it("shortens volumes", () => {
    expect([formatVolume(950), formatVolume(18_670_000), formatVolume(2_400_000_000)]).toEqual(["950", "18.67M", "2.40B"]);
  });
});

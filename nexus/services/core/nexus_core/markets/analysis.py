"""Technical analysis for trade ideas: indicators, a transparent rule-based view, price levels and a back-test.

What this is, honestly
----------------------
Nobody can reliably predict markets, and this module doesn't claim to. It measures a few
well-known things (trend, momentum, volatility, nearby support and resistance), turns them into a
*view* with an explicit score and the reasons behind it, and derives entry / stop / target levels
from recent volatility. The back-test replays the very same rules on the symbol's own history so the
view always comes with its track record — including when that record is poor.

Everything is pure arithmetic on closing data, so the same input always gives the same answer and
every number an agent quotes can be traced to here.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

Candle = dict[str, float]
MIN_BARS = 60
LONG_AT, SHORT_AT = 30, -30
HOLD_BARS = 20
STOP_ATR, TARGET_R = 1.5, 2.0


def sma(values: list[float], n: int) -> list[float | None]:
    out: list[float | None] = []
    total = 0.0
    for i, v in enumerate(values):
        total += v
        if i >= n:
            total -= values[i - n]
        out.append(total / n if i >= n - 1 else None)
    return out


def ema(values: list[float], n: int) -> list[float | None]:
    out: list[float | None] = []
    k = 2 / (n + 1)
    prev: float | None = None
    for i, v in enumerate(values):
        if i < n - 1:
            out.append(None)
        elif i == n - 1:
            prev = sum(values[:n]) / n
            out.append(prev)
        else:
            assert prev is not None
            prev = v * k + prev * (1 - k)
            out.append(prev)
    return out


def rsi(values: list[float], n: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) <= n:
        return out
    gain = loss = 0.0
    for i in range(1, n + 1):
        d = values[i] - values[i - 1]
        gain += max(d, 0)
        loss += max(-d, 0)
    gain, loss = gain / n, loss / n
    out[n] = 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)
    for i in range(n + 1, len(values)):
        d = values[i] - values[i - 1]
        gain = (gain * (n - 1) + max(d, 0)) / n
        loss = (loss * (n - 1) + max(-d, 0)) / n
        out[i] = 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)
    return out


def atr(candles: list[Candle], n: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(candles)
    if len(candles) <= n:
        return out
    trs = [0.0]
    for i in range(1, len(candles)):
        c, p = candles[i], candles[i - 1]["c"]
        trs.append(max(c["h"] - c["l"], abs(c["h"] - p), abs(c["l"] - p)))
    cur = sum(trs[1:n + 1]) / n
    out[n] = cur
    for i in range(n + 1, len(candles)):
        cur = (cur * (n - 1) + trs[i]) / n
        out[i] = cur
    return out


def macd(values: list[float]) -> tuple[list[float | None], list[float | None], list[float | None]]:
    fast, slow = ema(values, 12), ema(values, 26)
    line: list[float | None] = [f - s if f is not None and s is not None else None for f, s in zip(fast, slow, strict=True)]
    start = next((i for i, v in enumerate(line) if v is not None), len(line))
    sig_part = ema([v for v in line[start:] if v is not None], 9)
    signal: list[float | None] = [None] * start + sig_part
    hist: list[float | None] = [m - s if m is not None and s is not None else None for m, s in zip(line, signal, strict=True)]
    return line, signal, hist


def pivots(candles: list[Candle], upto: int, width: int = 5, lookback: int = 120) -> tuple[list[float], list[float]]:
    """Swing lows (support) and swing highs (resistance) confirmed by `width` bars on each side, up to bar `upto`."""
    lows: list[float] = []
    highs: list[float] = []
    for i in range(max(width, upto - lookback), upto - width + 1):
        window = candles[i - width:i + width + 1]
        if candles[i]["l"] == min(c["l"] for c in window):
            lows.append(candles[i]["l"])
        if candles[i]["h"] == max(c["h"] for c in window):
            highs.append(candles[i]["h"])
    return lows, highs


class Series:
    """All indicator series for a symbol, computed once. Every series is causal (bar i uses only bars ≤ i)."""

    def __init__(self, candles: list[Candle]):
        self.candles = candles
        self.close = [c["c"] for c in candles]
        self.sma20, self.sma50, self.sma200 = sma(self.close, 20), sma(self.close, 50), sma(self.close, 200)
        self.rsi = rsi(self.close, 14)
        self.atr = atr(candles, 14)
        self.macd, self.macd_signal, self.macd_hist = macd(self.close)
        self.vol20 = sma([c.get("v", 0.0) for c in candles], 20)
        # Running total of absolute daily moves, for the "is this trending or just chopping about" measure.
        self._path = [0.0]
        for i in range(1, len(self.close)):
            self._path.append(self._path[-1] + abs(self.close[i] - self.close[i - 1]))

    def efficiency(self, i: int, n: int = 50) -> float | None:
        """Kaufman's efficiency ratio: net move ÷ distance travelled over n bars. Near 1 = clean trend, near 0 = chop."""
        if i < n:
            return None
        travelled = self._path[i] - self._path[i - n]
        return abs(self.close[i] - self.close[i - n]) / travelled if travelled > 0 else 0.0


def score_at(s: Series, i: int) -> tuple[int, list[dict[str, Any]]]:
    """A score from -100 (strongly bearish) to +100 (strongly bullish) at bar i, with the reasons that built it."""
    price = s.close[i]
    reasons: list[dict[str, Any]] = []

    def add(points: int, text: str) -> None:
        reasons.append({"points": points, "text": text})

    unit = s.atr[i] or price * 0.01  # distances are judged against normal daily movement, so noise doesn't count as trend
    if s.sma50[i] is not None:
        gap = price - s.sma50[i]
        if abs(gap) < 0.5 * unit:
            add(0, "Price is sitting on its 50-day average")
        else:
            add(20 if gap > 0 else -20, f"Price is {'above' if gap > 0 else 'below'} its 50-day average")
    if s.sma200[i] is not None and s.sma50[i] is not None:
        gap = s.sma50[i] - s.sma200[i]
        if abs(gap) < unit:
            add(0, "The 50- and 200-day averages are tangled together: no long-term trend")
        else:
            add(20 if gap > 0 else -20, f"The 50-day average is {'above' if gap > 0 else 'below'} the 200-day average "
                                        f"({'long-term uptrend' if gap > 0 else 'long-term downtrend'})")
    if s.sma20[i] is not None and i >= 5 and s.sma20[i - 5] is not None:
        slope = s.sma20[i] - s.sma20[i - 5]
        if abs(slope) >= 0.25 * unit:
            add(10 if slope > 0 else -10, f"The 20-day average is {'rising' if slope > 0 else 'falling'}")
    r = s.rsi[i]
    if r is not None:
        if r >= 75:
            add(-10, f"RSI is {r:.0f}: stretched after a strong run, so a pause or pullback is more likely")
        elif r <= 25:
            add(10, f"RSI is {r:.0f}: heavily sold, so a bounce is more likely")
        elif r >= 55:
            add(15, f"RSI is {r:.0f}: buyers have the upper hand")
        elif r <= 45:
            add(-15, f"RSI is {r:.0f}: sellers have the upper hand")
        else:
            add(0, f"RSI is {r:.0f}: no clear momentum")
    h = s.macd_hist[i]
    if h is not None and i >= 1 and s.macd_hist[i - 1] is not None:
        if h > 0:
            add(15 if h >= s.macd_hist[i - 1] else 8, "MACD is positive" + (" and strengthening" if h >= s.macd_hist[i - 1] else " but fading"))
        else:
            add(-15 if h <= s.macd_hist[i - 1] else -8, "MACD is negative" + (" and weakening further" if h <= s.macd_hist[i - 1] else " but recovering"))
    if i >= 20:
        ret = (price - s.close[i - 20]) / s.close[i - 20] * 100
        if abs(ret) >= 3:
            add(10 if ret > 0 else -10, f"{'Up' if ret > 0 else 'Down'} {abs(ret):.1f}% over the last 20 sessions")
    v = s.candles[i].get("v", 0.0)
    if s.vol20[i] and v > 1.5 * s.vol20[i] and i >= 1:
        up_day = price >= s.close[i - 1]
        add(10 if up_day else -10, f"Heavy volume on {'an up' if up_day else 'a down'} day ({v / s.vol20[i]:.1f}× normal)")
    total = sum(x["points"] for x in reasons)
    er = s.efficiency(i)
    if er is not None and er < 0.15:
        total = round(total / 2)
        reasons.append({"points": 0, "text": "Prices have been going sideways, where these signals are least reliable — so the score is halved"})
    return max(-100, min(100, total)), reasons


def bias_of(score: int) -> str:
    return "long" if score >= LONG_AT else "short" if score <= SHORT_AT else "neutral"


def levels_at(s: Series, i: int, bias: str) -> dict[str, Any] | None:
    """Entry, stop and targets from volatility (ATR), snapped to nearby support / resistance when sensible."""
    a = s.atr[i]
    if a is None or a <= 0 or bias == "neutral":
        return None
    price = s.close[i]
    lows, highs = pivots(s.candles, i)
    sign = 1 if bias == "long" else -1
    stop = price - sign * STOP_ATR * a
    # Put the stop just beyond the nearest swing point if one sits between 0.5 and 3 ATR away.
    beyond = [x for x in (lows if bias == "long" else highs) if 0.5 * a <= sign * (price - x) <= 3 * a]
    if beyond:
        anchor = max(beyond) if bias == "long" else min(beyond)
        stop = anchor - sign * 0.25 * a
    risk = abs(price - stop)
    target1 = price + sign * risk * 1.0
    target2 = price + sign * risk * TARGET_R
    ahead = sorted((x for x in (highs if bias == "long" else lows) if sign * (x - price) > 0.5 * risk), key=lambda x: abs(x - price))
    return {"entry": round(price, 4), "stop": round(stop, 4), "target1": round(target1, 4), "target2": round(target2, 4),
            "risk_per_unit": round(risk, 4), "risk_percent": round(risk / price * 100, 2), "reward_to_risk": TARGET_R,
            "atr": round(a, 4), "next_barrier": round(ahead[0], 4) if ahead else None,
            "supports": [round(x, 4) for x in sorted({x for x in lows if x < price}, reverse=True)[:3]],
            "resistances": [round(x, 4) for x in sorted({x for x in highs if x > price})[:3]]}


def backtest(s: Series, start: int = 200) -> dict[str, Any]:
    """Replay the same rules on this symbol's own history.

    Enter at the next bar's open when the view turns long or short; exit at the stop, at the 2R target,
    or after 20 bars. One trade at a time. No costs, slippage or taxes are included, so real results
    would be worse. Results are in R (multiples of the amount risked).
    """
    c = s.candles
    start = max(start, 30) if len(c) > 260 else max(60, len(c) // 3)
    trades: list[dict[str, Any]] = []
    i = start
    prev_bias = "neutral"
    while i < len(c) - 2:
        score, _ = score_at(s, i)
        b = bias_of(score)
        if b != "neutral" and b != prev_bias:
            lv = levels_at(s, i, b)
            if lv:
                sign = 1 if b == "long" else -1
                entry = c[i + 1]["o"]
                risk = lv["risk_per_unit"]
                stop, target = entry - sign * risk, entry + sign * risk * TARGET_R
                exit_price, exit_i, how = c[min(i + HOLD_BARS, len(c) - 1)]["c"], min(i + HOLD_BARS, len(c) - 1), "time"
                for j in range(i + 1, min(i + 1 + HOLD_BARS, len(c))):
                    hit_stop = c[j]["l"] <= stop if b == "long" else c[j]["h"] >= stop
                    hit_target = c[j]["h"] >= target if b == "long" else c[j]["l"] <= target
                    if hit_stop:  # if both happen in one bar, assume the stop came first (the cautious reading)
                        exit_price, exit_i, how = stop, j, "stop"
                        break
                    if hit_target:
                        exit_price, exit_i, how = target, j, "target"
                        break
                trades.append({"side": b, "r": round(sign * (exit_price - entry) / risk, 2), "exit": how,
                               "date": datetime.fromtimestamp(c[i + 1]["t"], timezone.utc).date().isoformat()})
                prev_bias = b
                i = exit_i + 1
                continue
        prev_bias = b
        i += 1
    n = len(trades)
    wins = sum(1 for t in trades if t["r"] > 0)
    total_r = round(sum(t["r"] for t in trades), 2)
    hold = round((c[-1]["c"] - c[start]["c"]) / c[start]["c"] * 100, 1) if len(c) > start else None
    out: dict[str, Any] = {
        "trades": n, "wins": wins, "win_rate": round(wins / n * 100) if n else None, "total_r": total_r,
        "average_r": round(total_r / n, 2) if n else None, "long_trades": sum(1 for t in trades if t["side"] == "long"),
        "short_trades": sum(1 for t in trades if t["side"] == "short"), "buy_and_hold_percent": hold,
        "bars_tested": len(c) - start, "recent": trades[-5:],
        "assumptions": "Next-bar entry, stop at the suggested level, target at 2× the risk, exit after 20 bars. No costs or slippage.",
    }
    if n < 10:
        out["verdict"] = "Too few past signals to judge these rules on this symbol."
    elif total_r > 0 and (out["average_r"] or 0) >= 0.2:
        out["verdict"] = f"These rules would have made money here in the past ({total_r:+.1f}R over {n} trades). That is no promise for the future."
    elif total_r > 0:
        out["verdict"] = f"These rules were only marginally profitable here in the past ({total_r:+.1f}R over {n} trades) — not a reliable edge."
    else:
        out["verdict"] = f"These rules would have LOST money on this symbol in the past ({total_r:+.1f}R over {n} trades). Treat this view with extra doubt."
    return out


def analyse(candles: list[Candle], quote: dict[str, Any] | None = None) -> dict[str, Any]:
    if len(candles) < MIN_BARS:
        raise ValueError(f"Not enough price history to analyse (need {MIN_BARS} sessions, have {len(candles)}).")
    s = Series(candles)
    i = len(candles) - 1
    score, reasons = score_at(s, i)
    bias = bias_of(score)
    bt = backtest(s)
    strength = abs(score)
    confidence = "low"
    if bias != "neutral" and strength >= 60 and bt["trades"] >= 10 and bt["total_r"] > 0:
        confidence = "medium"  # never "high": a daily-bar rule set does not earn that word
    high52 = max(c["h"] for c in candles[-252:])
    low52 = min(c["l"] for c in candles[-252:])
    price = s.close[i]
    return {
        "as_of": datetime.fromtimestamp(candles[i]["t"], timezone.utc).date().isoformat(),
        "price": price, "bias": bias, "score": score, "confidence": confidence,
        "verdict": {"long": "Leaning long (buy)", "short": "Leaning short (sell)", "neutral": "No clear edge — stay out"}[bias],
        "reasons": reasons, "levels": levels_at(s, i, bias),
        "indicators": {"rsi14": round(s.rsi[i], 1) if s.rsi[i] is not None else None,
                       "sma20": s.sma20[i], "sma50": s.sma50[i], "sma200": s.sma200[i],
                       "atr14": s.atr[i], "atr_percent": round(s.atr[i] / price * 100, 2) if s.atr[i] else None,
                       "macd_hist": s.macd_hist[i], "high_52w": high52, "low_52w": low52,
                       "from_52w_high_percent": round((price - high52) / high52 * 100, 1)},
        "backtest": bt,
        "currency": (quote or {}).get("currency"), "name": (quote or {}).get("name"), "symbol": (quote or {}).get("symbol"),
        "caveats": ["This is a rule-based reading of past prices, not a prediction. Markets regularly do the opposite.",
                    "It knows nothing about news, results, or events due tomorrow.",
                    "Never risk more than a small part of your capital on one idea (many traders cap it at 1%)."],
    }

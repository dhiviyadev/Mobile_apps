"""Markets: real price data, a watchlist, price alerts and a practice trading account.

What this is
------------
* Prices and charts come from Yahoo Finance's public chart service. It needs no
  account or key, but it is unofficial: data can be delayed (often 15 minutes for
  shares) and the service can change or rate-limit without notice.
* The trading account is a **practice account**. Orders fill instantly at the
  latest real price, using pretend money stored only in the local database.
  NEXUS never places real orders and has no connection to any broker.
* Nothing here is financial advice.

Privacy
-------
Off until switched on (`markets.enabled`). When on, the only thing sent is the
ticker symbol or search phrase. Holdings, orders and cash never leave the Mac.
Requests go through the same guarded fetcher as web access (public addresses
only, pinned connection, size cap).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

import httpx

from ..integrations.web import WebBlocked
from .providers import USER_AGENT as HONEST_AGENT
from .providers import CoinbaseProvider, NseProvider, ProviderError
from ..util import new_id, now_iso

if TYPE_CHECKING:
    from ..app_state import AppState

log = logging.getLogger(__name__)

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"
SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search"
# range -> (bar size, seconds a cached answer stays fresh)
RANGES: dict[str, tuple[str, int]] = {
    "1d": ("5m", 60), "5d": ("30m", 120), "1mo": ("1d", 600), "6mo": ("1d", 900),
    "1y": ("1d", 900), "5y": ("1wk", 3600),
    "5yd": ("1d", 3600),  # five years of daily bars: used for analysis and back-tests, not offered as a chart range
}
RANGE_PARAM = {"5yd": "5y"}
_SYMBOL = re.compile(r"^[A-Za-z0-9.\-=^&]{1,15}$")  # "&" appears in NSE tickers such as M&M
DEFAULT_CASH = 100_000.0
MAX_WATCHLIST = 40
ALERT_INTERVAL_S = 180


class MarketError(Exception):
    """kind: not_found | refused (the data service turned us away) | network | other"""

    def __init__(self, message: str, kind: str = "other"):
        super().__init__(message)
        self.kind = kind


REFUSED = ("Yahoo Finance is turning away automated requests, so prices for this symbol can't be loaded. Indian shares (add .NS, "
           "e.g. INFY.NS) and crypto (e.g. BTC-USD) use other free sources and work. For this symbol, switch the chart to TradingView.")
SOURCES = "Indian shares: NSE India's official free service · Crypto: Coinbase · Others: Yahoo Finance (often unavailable)"
DEFAULT_CASH_BY_CURRENCY = {"INR": 1_000_000.0, "USD": 100_000.0, "EUR": 100_000.0, "GBP": 100_000.0}


class MarketsDisabled(MarketError):
    pass


def clean_symbol(symbol: str) -> str:
    s = (symbol or "").strip().upper()
    if not _SYMBOL.match(s):
        raise MarketError("That doesn't look like a ticker symbol (for example AAPL, MSFT, BTC-USD).")
    return s


def parse_chart(payload: dict[str, Any]) -> dict[str, Any]:
    """Turn Yahoo's chart response into {meta, candles}. Bars with missing prices are dropped."""
    chart = payload.get("chart") or {}
    if chart.get("error"):
        raise MarketError(str((chart["error"] or {}).get("description") or "No data for that symbol."))
    result = (chart.get("result") or [None])[0]
    if not result:
        raise MarketError("No data for that symbol.")
    meta = result.get("meta") or {}
    stamps = result.get("timestamp") or []
    quote_ = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    o, h, low, c, v = (quote_.get(k) or [] for k in ("open", "high", "low", "close", "volume"))
    candles = []
    for i, ts in enumerate(stamps):
        try:
            bar = (o[i], h[i], low[i], c[i])
        except IndexError:
            break
        if any(x is None for x in bar):
            continue
        candles.append({"t": int(ts), "o": float(bar[0]), "h": float(bar[1]), "l": float(bar[2]), "c": float(bar[3]),
                        "v": float(v[i]) if i < len(v) and v[i] is not None else 0.0})
    price = meta.get("regularMarketPrice")
    if price is None and candles:
        price = candles[-1]["c"]
    if price is None:
        raise MarketError("No price is available for that symbol right now.")
    prev = meta.get("chartPreviousClose") or meta.get("previousClose")
    return {
        "meta": {
            "symbol": str(meta.get("symbol") or "").upper(),
            "name": meta.get("longName") or meta.get("shortName") or str(meta.get("symbol") or ""),
            "currency": (meta.get("currency") or "").upper(),
            "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
            "kind": (meta.get("instrumentType") or "").lower(),
            "price": float(price),
            "previous_close": float(prev) if prev is not None else None,
            "market_time": int(meta["regularMarketTime"]) if meta.get("regularMarketTime") else None,
            "timezone": meta.get("exchangeTimezoneName") or "",
        },
        "candles": candles,
    }


def quote_from(parsed: dict[str, Any]) -> dict[str, Any]:
    m = parsed["meta"]
    prev = m["previous_close"]
    change = m["price"] - prev if prev else None
    return {**m, "change": change, "change_percent": (change / prev * 100) if change is not None and prev else None}


class MarketService:
    def __init__(self, state: "AppState"):
        self.state = state
        self._cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
        self.nse = NseProvider(state.db)
        self.crypto = CoinbaseProvider(state.db, state.web)
        self.retry_delay = 1.5
        self._refused_until = 0.0  # after a refusal, stop asking for a while instead of knocking repeatedly

    # -- switches -----------------------------------------------------------------
    @property
    def enabled(self) -> bool:
        return bool(self.state.prefs.get("markets.enabled"))

    def _require(self) -> None:
        if not self.enabled:
            raise MarketsDisabled("Market data is turned off. Turn it on in Markets (or Settings → Web & apps).")

    # -- data ---------------------------------------------------------------------
    async def _json(self, url: str, params: dict[str, str]) -> dict[str, Any]:
        body = ""
        if time.time() < self._refused_until:
            raise MarketError(REFUSED, "refused")
        for attempt in (1, 2):
            try:
                _, _, body = await self.state.web._get(url, params, user_agent=HONEST_AGENT)  # noqa: SLF001 - shared guarded fetcher
                self._refused_until = 0.0
                break
            except WebBlocked as exc:
                msg = str(exc)
                if "(404)" in msg:
                    raise MarketError("That symbol wasn't found.", "not_found") from exc
                if any(code in msg for code in ("(429)", "(401)", "(403)", "(999)")):
                    if attempt == 1:
                        await asyncio.sleep(self.retry_delay)  # one polite retry, then give up rather than hammer the service
                        continue
                    self._refused_until = time.time() + 120
                    raise MarketError(REFUSED, "refused") from exc
                raise MarketError(f"Couldn't get market data. {msg}") from exc
            except httpx.HTTPError as exc:
                raise MarketError("Couldn't reach the market data service. Check the internet connection.", "network") from exc
        try:
            return json.loads(body)
        except ValueError as exc:
            raise MarketError("The market data service sent an answer NEXUS couldn't read.") from exc

    def _provider(self, symbol: str) -> NseProvider | CoinbaseProvider | None:
        """Which free official source serves this symbol (None = only Yahoo knows it)."""
        if self.nse.handles(symbol):
            return self.nse
        if self.crypto.handles(symbol):
            return self.crypto
        return None

    async def close(self) -> None:
        await self.nse.close()

    async def history(self, symbol: str, range_: str = "6mo", fresh: bool = False) -> dict[str, Any]:
        self._require()
        symbol = clean_symbol(symbol)
        if range_ not in RANGES:
            raise MarketError(f"range must be one of {', '.join(RANGES)}")
        provider = self._provider(symbol)
        if provider:
            try:
                return await provider.history(symbol, range_, fresh)
            except ProviderError as exc:
                raise MarketError(str(exc), exc.kind) from exc
        interval, ttl = RANGES[range_]
        key = (symbol, range_)
        hit = self._cache.get(key)
        if hit and not fresh and time.time() - hit[0] < ttl:
            return hit[1]
        try:
            payload = await self._json(CHART_URL + quote(symbol, safe=""), {"range": RANGE_PARAM.get(range_, range_), "interval": interval, "includePrePost": "false"})
        except MarketError as exc:
            if hit and exc.kind in ("refused", "network"):
                return {**hit[1], "stale": True}  # better yesterday's numbers, clearly marked, than nothing
            raise
        parsed = parse_chart(payload)
        q = quote_from(parsed)
        if range_ != "1d":
            # On longer ranges the service's "previous close" is the close before the *range* began, so the
            # day's change has to come from the one-day view (cached for a minute).
            try:
                q = (await self.history(symbol, "1d", fresh=fresh))["quote"]
            except MarketError:
                q = {**q, "previous_close": None, "change": None, "change_percent": None}
        out = {"symbol": symbol, "range": range_, "interval": interval, "quote": q, "candles": parsed["candles"],
               "fetched_at": now_iso(), "source": "Yahoo Finance (unofficial, may be delayed)"}
        self._cache[key] = (time.time(), out)
        if len(self._cache) > 200:
            for k in sorted(self._cache, key=lambda k: self._cache[k][0])[:50]:
                self._cache.pop(k, None)
        return out

    async def quote(self, symbol: str, fresh: bool = False) -> dict[str, Any]:
        self._require()
        symbol = clean_symbol(symbol)
        provider = self._provider(symbol)
        if provider:
            try:
                return await provider.quote(symbol, fresh)
            except ProviderError as exc:
                raise MarketError(str(exc), exc.kind) from exc
        return (await self.history(symbol, "1d", fresh=fresh))["quote"]

    async def quotes(self, symbols: list[str]) -> dict[str, dict[str, Any]]:
        """Latest quotes for several symbols; a symbol that fails is reported with an error instead of failing all."""
        sem = asyncio.Semaphore(2)

        async def one(sym: str) -> tuple[str, dict[str, Any]]:
            async with sem:
                try:
                    return sym, await self.quote(sym)
                except MarketError as exc:
                    return sym, {"symbol": sym, "error": str(exc)}

        return dict(await asyncio.gather(*(one(s) for s in symbols)))

    async def search(self, query: str) -> list[dict[str, Any]]:
        """Find symbols by ticker or name: NSE shares first, then crypto, then whatever Yahoo will tell us."""
        self._require()
        query = " ".join(query.split())[:60]
        if not query:
            return []
        out: list[dict[str, Any]] = []
        try:
            out += await self.nse.search(query)
        except ProviderError:
            pass
        out += await self.crypto.search(query)
        if time.time() >= self._refused_until:
            try:
                data = await self._json(SEARCH_URL, {"q": query, "quotesCount": "8", "newsCount": "0", "listsCount": "0"})
                for q in data.get("quotes") or []:
                    sym = str(q.get("symbol") or "").upper()
                    if _SYMBOL.match(sym) and not any(r["symbol"] == sym for r in out):
                        out.append({"symbol": sym, "name": q.get("longname") or q.get("shortname") or sym,
                                    "exchange": q.get("exchDisp") or q.get("exchange") or "", "kind": (q.get("typeDisp") or q.get("quoteType") or "").lower()})
            except MarketError:
                if not out:
                    raise
        return out[:10]

    # -- watchlist ----------------------------------------------------------------
    def watchlist(self) -> list[dict[str, Any]]:
        return self.state.db.query("SELECT * FROM market_watchlist ORDER BY position, added_at")

    async def watch(self, symbol: str) -> dict[str, Any]:
        self._require()
        try:
            q = await self.quote(symbol)  # also proves the symbol exists
        except MarketError as exc:
            sym = clean_symbol(symbol)
            q = None
            if exc.kind in ("refused", "not_found") and "." not in sym and "-" not in sym and not sym.startswith("^"):
                # A bare ticker Yahoo won't answer for is very likely an Indian share: accept it if NSE itself confirms it.
                try:
                    q = await self.quote(f"{sym}.NS")
                except MarketError:
                    q = None
            if q is None:
                if exc.kind not in ("refused", "network"):
                    raise
                # The price service is unavailable, not the symbol wrong: keep it anyway so it can still be charted.
                q = {"symbol": sym, "name": sym, "exchange": "", "kind": "", "currency": "", "price": None, "change": None,
                     "change_percent": None, "error": str(exc)}
        db = self.state.db
        if not db.query_one("SELECT symbol FROM market_watchlist WHERE symbol = ?", (q["symbol"],)):
            count = (db.query_one("SELECT COUNT(*) AS n FROM market_watchlist") or {"n": 0})["n"]
            if count >= MAX_WATCHLIST:
                raise MarketError(f"The watchlist is full ({MAX_WATCHLIST}). Remove one first.")
            db.execute("INSERT INTO market_watchlist(symbol, name, exchange, kind, currency, position, added_at) VALUES (?,?,?,?,?,?,?)",
                       (q["symbol"], q["name"], q["exchange"], q["kind"], q["currency"], count, now_iso()))
            self.state.bus.publish("markets.changed", {"what": "watchlist"})
        return q

    def unwatch(self, symbol: str) -> None:
        self.state.db.execute("DELETE FROM market_watchlist WHERE symbol = ?", (clean_symbol(symbol),))
        self.state.bus.publish("markets.changed", {"what": "watchlist"})

    # -- practice account ---------------------------------------------------------
    def account(self) -> dict[str, Any]:
        db = self.state.db
        acct = db.query_one("SELECT * FROM paper_account WHERE id = 1")
        if not acct:
            db.execute("INSERT INTO paper_account(id, currency, starting_cash, cash, created_at) VALUES (1,?,?,?,?)",
                       ("USD", DEFAULT_CASH, DEFAULT_CASH, now_iso()))
            acct = db.query_one("SELECT * FROM paper_account WHERE id = 1")
        assert acct is not None
        return acct

    def reset_account(self, cash: float = DEFAULT_CASH, currency: str = "USD") -> dict[str, Any]:
        currency = (currency or "USD").strip().upper()
        if not re.fullmatch(r"[A-Z]{3}", currency):
            raise MarketError("Currency must be a three-letter code such as USD, EUR or INR.")
        if not 100 <= cash <= 1_000_000_000:
            raise MarketError("Starting cash must be between 100 and 1,000,000,000.")
        db = self.state.db
        with db.transaction():
            db.execute("DELETE FROM paper_orders")
            db.execute("DELETE FROM paper_positions")
            db.execute("DELETE FROM paper_account")
            db.execute("INSERT INTO paper_account(id, currency, starting_cash, cash, created_at) VALUES (1,?,?,?,?)",
                       (currency, float(cash), float(cash), now_iso()))
        self.state.audit.record("user", "markets.practice_reset", currency, "executed", cash=cash)
        self.state.bus.publish("markets.changed", {"what": "account"})
        return self.account()

    async def order(self, symbol: str, side: str, quantity: float, actor: str = "user") -> dict[str, Any]:
        """Fill a practice order at the latest real price. No shorting, no borrowing."""
        self._require()
        if side not in ("buy", "sell"):
            raise MarketError("side must be buy or sell")
        try:
            quantity = float(quantity)
        except (TypeError, ValueError) as exc:
            raise MarketError("Enter a quantity.") from exc
        if not (quantity > 0) or quantity > 1e9 or round(quantity, 6) != quantity:
            raise MarketError("Quantity must be a positive number with at most 6 decimal places.")
        q = await self.quote(symbol, fresh=True)
        acct = self.account()
        untouched = not self.state.db.query_one("SELECT 1 AS x FROM paper_orders LIMIT 1") and acct["cash"] == acct["starting_cash"]
        if q["currency"] and q["currency"] != acct["currency"] and untouched and q["currency"] in DEFAULT_CASH_BY_CURRENCY:
            # Nothing has been traded yet, so simply open the practice account in the currency of the first thing bought.
            acct = self.reset_account(DEFAULT_CASH_BY_CURRENCY[q["currency"]], q["currency"])
        if q["currency"] and q["currency"] != acct["currency"]:
            raise MarketError(f"{q['symbol']} trades in {q['currency']}, but the practice account is in {acct['currency']}. "
                              f"Reset the account in that currency to practise with it.")
        price = q["price"]
        if not price or price <= 0:
            raise MarketError("No valid price is available for that symbol right now.")
        total = round(price * quantity, 2)
        db = self.state.db
        realized: float | None = None
        with db.transaction():
            acct = db.query_one("SELECT * FROM paper_account WHERE id = 1") or acct
            pos = db.query_one("SELECT * FROM paper_positions WHERE symbol = ?", (q["symbol"],))
            if side == "buy":
                if total > acct["cash"] + 1e-9:
                    raise MarketError(f"Not enough practice cash: this costs {total:,.2f} {acct['currency']} and you have {acct['cash']:,.2f}.")
                held = pos["quantity"] if pos else 0.0
                avg = ((pos["avg_cost"] * held) + total) / (held + quantity) if pos else price
                db.execute("INSERT INTO paper_positions(symbol, name, quantity, avg_cost, updated_at) VALUES (?,?,?,?,?) "
                           "ON CONFLICT(symbol) DO UPDATE SET quantity = excluded.quantity, avg_cost = excluded.avg_cost, updated_at = excluded.updated_at",
                           (q["symbol"], q["name"], round(held + quantity, 6), avg, now_iso()))
                db.execute("UPDATE paper_account SET cash = cash - ? WHERE id = 1", (total,))
            else:
                held = pos["quantity"] if pos else 0.0
                if quantity > held + 1e-9:
                    raise MarketError(f"You hold {held:g} of {q['symbol']}; you can't sell {quantity:g}. (The practice account doesn't allow short selling.)")
                realized = round((price - pos["avg_cost"]) * quantity, 2)
                left = round(held - quantity, 6)
                if left <= 1e-9:
                    db.execute("DELETE FROM paper_positions WHERE symbol = ?", (q["symbol"],))
                else:
                    db.execute("UPDATE paper_positions SET quantity = ?, updated_at = ? WHERE symbol = ?", (left, now_iso(), q["symbol"]))
                db.execute("UPDATE paper_account SET cash = cash + ? WHERE id = 1", (total,))
            oid = new_id("ord")
            db.execute("INSERT INTO paper_orders(id, symbol, side, quantity, price, total, realized_pnl, created_at) VALUES (?,?,?,?,?,?,?,?)",
                       (oid, q["symbol"], side, quantity, price, total, realized, now_iso()))
        self.state.audit.record(actor, "markets.practice_order", q["symbol"], "executed", side=side, quantity=quantity, price=price)
        self.state.bus.publish("markets.changed", {"what": "account"})
        return {"id": oid, "symbol": q["symbol"], "side": side, "quantity": quantity, "price": price, "total": total,
                "realized_pnl": realized, "practice": True}

    def orders(self, limit: int = 50) -> list[dict[str, Any]]:
        return self.state.db.query("SELECT * FROM paper_orders ORDER BY created_at DESC, rowid DESC LIMIT ?", (max(1, min(limit, 500)),))

    async def portfolio(self) -> dict[str, Any]:
        acct = self.account()
        positions = self.state.db.query("SELECT * FROM paper_positions ORDER BY symbol")
        quotes = await self.quotes([p["symbol"] for p in positions]) if positions and self.enabled else {}
        rows, value, priced = [], 0.0, True
        for p in positions:
            q = quotes.get(p["symbol"]) or {}
            price = q.get("price")
            cost = p["avg_cost"] * p["quantity"]
            if price is None:
                priced = False
                rows.append({**p, "price": None, "value": None, "pnl": None, "pnl_percent": None, "cost": cost, "error": q.get("error")})
                value += cost  # fall back to cost so the total doesn't swing when a quote is missing
                continue
            mv = price * p["quantity"]
            value += mv
            rows.append({**p, "price": price, "value": mv, "cost": cost, "pnl": mv - cost,
                         "pnl_percent": ((mv - cost) / cost * 100) if cost else None,
                         "day_change_percent": q.get("change_percent")})
        realized = (self.state.db.query_one("SELECT COALESCE(SUM(realized_pnl), 0) AS r FROM paper_orders") or {"r": 0})["r"]
        equity = acct["cash"] + value
        return {"practice": True, "currency": acct["currency"], "cash": acct["cash"], "starting_cash": acct["starting_cash"],
                "positions_value": value, "equity": equity, "total_return": equity - acct["starting_cash"],
                "total_return_percent": (equity - acct["starting_cash"]) / acct["starting_cash"] * 100,
                "realized_pnl": realized, "positions": rows, "fully_priced": priced, "since": acct["created_at"]}

    # -- price alerts -------------------------------------------------------------
    def alerts(self, include_triggered: bool = True) -> list[dict[str, Any]]:
        where = "" if include_triggered else "WHERE triggered_at IS NULL"
        return self.state.db.query(f"SELECT * FROM market_alerts {where} ORDER BY triggered_at IS NOT NULL, created_at DESC LIMIT 100")

    def add_alert(self, symbol: str, direction: str, price: float) -> dict[str, Any]:
        symbol = clean_symbol(symbol)
        if direction not in ("above", "below"):
            raise MarketError("direction must be above or below")
        if not (isinstance(price, (int, float)) and 0 < price < 1e12):
            raise MarketError("Enter a price above zero.")
        active = (self.state.db.query_one("SELECT COUNT(*) AS n FROM market_alerts WHERE triggered_at IS NULL") or {"n": 0})["n"]
        if active >= 50:
            raise MarketError("You already have 50 active alerts. Remove one first.")
        aid = new_id("alr")
        self.state.db.execute("INSERT INTO market_alerts(id, symbol, direction, price, created_at) VALUES (?,?,?,?,?)",
                              (aid, symbol, direction, float(price), now_iso()))
        self.state.bus.publish("markets.changed", {"what": "alerts"})
        return self.state.db.query_one("SELECT * FROM market_alerts WHERE id = ?", (aid,))  # type: ignore[return-value]

    def remove_alert(self, alert_id: str) -> None:
        self.state.db.execute("DELETE FROM market_alerts WHERE id = ?", (alert_id,))
        self.state.bus.publish("markets.changed", {"what": "alerts"})

    async def check_alerts(self) -> list[dict[str, Any]]:
        """Compare active alerts with the latest prices; notify once for each that has been crossed."""
        if not self.enabled:
            return []
        active = self.alerts(include_triggered=False)
        if not active:
            return []
        quotes = await self.quotes(sorted({a["symbol"] for a in active}))
        fired = []
        for a in active:
            price = (quotes.get(a["symbol"]) or {}).get("price")
            if price is None:
                continue
            if (a["direction"] == "above" and price >= a["price"]) or (a["direction"] == "below" and price <= a["price"]):
                self.state.db.execute("UPDATE market_alerts SET triggered_at = ?, triggered_price = ? WHERE id = ? AND triggered_at IS NULL",
                                      (now_iso(), price, a["id"]))
                fired.append({**a, "triggered_price": price})
                await self.state.notifications.notify(
                    f"{a['symbol']} is {a['direction']} {a['price']:g}", f"Now {price:g}. Price alert from NEXUS Markets.", level="info")
        if fired:
            self.state.bus.publish("markets.changed", {"what": "alerts"})
        return fired

    async def run_alerts(self) -> None:
        while True:
            await asyncio.sleep(ALERT_INTERVAL_S)
            try:
                await self.check_alerts()
            except Exception:  # noqa: BLE001 - never let the loop die
                log.exception("price alert check failed")

    # -- market overview ----------------------------------------------------------
    async def overview(self) -> dict[str, Any]:
        """Indian market at a glance: headline indices plus the Nifty 50's top gainers and losers."""
        self._require()
        hit = self._cache.get(("__overview__", ""))
        from .providers import market_open

        if hit and time.time() - hit[0] < (60 if market_open() else 600):
            return hit[1]
        try:
            out = await self.nse.overview()
        except ProviderError as exc:
            if hit:
                return {**hit[1], "stale": True}
            raise MarketError(str(exc), exc.kind) from exc
        self._cache[("__overview__", "")] = (time.time(), out)
        return out

    # -- trade ideas --------------------------------------------------------------
    async def analysis(self, symbol: str) -> dict[str, Any]:
        """A rule-based view of a symbol with levels and a back-test of the same rules (see markets/analysis.py)."""
        from . import analysis as ta

        h = await self.history(symbol, "5yd")
        try:
            out = ta.analyse(h["candles"], h["quote"])
        except ValueError as exc:
            raise MarketError(str(exc)) from exc
        out["source"] = h["source"]
        return out

    async def scan(self, symbols: list[str] | None = None) -> list[dict[str, Any]]:
        """Analyse every watchlist symbol and rank them: strongest long ideas first, strongest short ideas last."""
        symbols = symbols or [w["symbol"] for w in self.watchlist()]
        sem = asyncio.Semaphore(3)

        async def one(sym: str) -> dict[str, Any]:
            async with sem:
                try:
                    a = await self.analysis(sym)
                    return {"symbol": a["symbol"] or sym, "name": a["name"], "price": a["price"], "currency": a["currency"], "bias": a["bias"],
                            "score": a["score"], "confidence": a["confidence"], "verdict": a["verdict"], "levels": a["levels"],
                            "rsi14": a["indicators"]["rsi14"], "backtest_total_r": a["backtest"]["total_r"], "backtest_trades": a["backtest"]["trades"]}
                except MarketError as exc:
                    return {"symbol": sym, "error": str(exc), "score": 0, "bias": "neutral"}

        rows = await asyncio.gather(*(one(s) for s in symbols[:MAX_WATCHLIST]))
        return sorted(rows, key=lambda r: -r["score"])

    # -- for agents ---------------------------------------------------------------
    async def summary(self, symbol: str, range_: str = "6mo") -> dict[str, Any]:
        """A compact, text-friendly view of a symbol for a model: quote, range high/low, change and recent closes."""
        h = await self.history(symbol, range_)
        candles = h["candles"]
        q = h["quote"]
        out: dict[str, Any] = {"symbol": q["symbol"], "name": q["name"], "currency": q["currency"], "price": q["price"],
                               "previous_close": q["previous_close"], "day_change_percent": round(q["change_percent"], 2) if q["change_percent"] is not None else None,
                               "range": range_, "source": h["source"], "note": "Informational only, not financial advice. Data may be delayed."}
        if candles:
            first, last = candles[0], candles[-1]
            out.update({
                "period_start": datetime.fromtimestamp(first["t"], timezone.utc).date().isoformat(),
                "period_change_percent": round((last["c"] - first["c"]) / first["c"] * 100, 2) if first["c"] else None,
                "period_high": max(c["h"] for c in candles), "period_low": min(c["l"] for c in candles),
                "recent_closes": [{"date": datetime.fromtimestamp(c["t"], timezone.utc).date().isoformat(), "close": round(c["c"], 4)}
                                  for c in candles[-10:]],
            })
        return out

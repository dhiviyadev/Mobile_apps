"""Free price sources that are *meant* to be read by programs.

* NSE India publishes two official, no-login data services for software (Model Context Protocol
  servers at mcp.nseindia.in): live quotes and indices (refreshed about once a minute during market
  hours) and daily price history taken from NSE's own end-of-day "bhavcopy" files. NEXUS speaks
  that protocol directly. NSE's notice applies: the data is for education and research, not
  investment advice.
* Coinbase Exchange's public market-data API covers crypto pairs such as BTC-USD.

What was learned by testing against the real services (Nov 2026), and is handled here:
  - NSE history comes in pages of at most three months, each naming the date the next page ends on.
    So daily bars are kept in the local database and only new days are fetched afterwards.
  - NSE's history is NOT adjusted for bonus issues and splits (a 1:1 bonus looks like a 50% crash).
    NSE lists those events with an adjustment factor; earlier prices are scaled by it when read.
  - A few days carry a "T0" settlement-series row with a handful of shares traded; those are dropped.
  - History currently begins in January 2024. There are no intraday bars.
  - Symbol search matches ticker text only (INFY, not "Infosys"), so a small table of well-known
    company names is added on top.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

import httpx

from ..db.database import Database
from ..integrations.web import WebBlocked
from ..util import now_iso

if TYPE_CHECKING:
    from ..integrations.web import WebService

log = logging.getLogger(__name__)

NSE_LIVE = "https://mcp.nseindia.in/cmmkt/mcp"
NSE_HISTORY = "https://mcp.nseindia.in/bhavcopy/cm/mcp"
COINBASE = "https://api.exchange.coinbase.com"
# An honest client name: these services are for programs, so there is nothing to pretend about.
USER_AGENT = "personal-desktop-app/0.1 (market data client)"
IST = timezone(timedelta(hours=5, minutes=30))
NSE_SOURCE = "NSE India's official free data service (quotes can lag a few minutes; for education and research, not investment advice)"
COINBASE_SOURCE = "Coinbase Exchange public market data"

# Yahoo-style index symbols people know → the names NSE uses.
NSE_INDEX = {"^NSEI": "NIFTY 50", "^NSEBANK": "NIFTY BANK", "^CNXIT": "NIFTY IT", "^INDIAVIX": "INDIA VIX",
             "^NSMIDCP": "NIFTY NEXT 50", "^CNX100": "NIFTY 100", "^CRSLDX": "NIFTY 500", "^NSEMDCP50": "NIFTY MIDCAP 50"}
# NSE's search only matches ticker text; these cover names that differ from their ticker.
NSE_ALIASES = {
    "INFOSYS": "INFY", "STATE BANK": "SBIN", "SBI": "SBIN", "MAHINDRA": "M&M", "LARSEN": "LT", "L&T": "LT",
    "HINDUSTAN UNILEVER": "HINDUNILVR", "HUL": "HINDUNILVR", "AIRTEL": "BHARTIARTL", "BHARTI": "BHARTIARTL",
    "ICICI": "ICICIBANK", "HDFC": "HDFCBANK", "KOTAK": "KOTAKBANK", "AXIS": "AXISBANK", "BAJAJ FINANCE": "BAJFINANCE",
    "BAJAJ FINSERV": "BAJAJFINSV", "ASIAN PAINTS": "ASIANPAINT", "ULTRATECH": "ULTRACEMCO", "SUN PHARMA": "SUNPHARMA",
    "DR REDDY": "DRREDDY", "POWER GRID": "POWERGRID", "COAL INDIA": "COALINDIA", "TATA STEEL": "TATASTEEL",
    "TATA POWER": "TATAPOWER", "TATA CONSUMER": "TATACONSUM", "JSW STEEL": "JSWSTEEL", "TECH MAHINDRA": "TECHM",
    "HCL": "HCLTECH", "ADANI ENTERPRISES": "ADANIENT", "ADANI PORTS": "ADANIPORTS", "INDUSIND": "INDUSINDBK",
    "NESTLE": "NESTLEIND", "BRITANNIA": "BRITANNIA", "EICHER": "EICHERMOT", "HERO": "HEROMOTOCO", "BAJAJ AUTO": "BAJAJ-AUTO",
    "APOLLO HOSPITALS": "APOLLOHOSP", "DIVIS": "DIVISLAB", "GRASIM": "GRASIM", "HINDALCO": "HINDALCO", "ZOMATO": "ETERNAL",
    "ETERNAL": "ETERNAL", "PAYTM": "PAYTM", "NYKAA": "NYKAA", "LIC": "LICI", "IRCTC": "IRCTC", "DMART": "DMART",
    "AVENUE SUPERMARTS": "DMART", "TITAN": "TITAN", "WIPRO": "WIPRO", "ITC": "ITC", "ONGC": "ONGC", "NTPC": "NTPC",
    "MARUTI": "MARUTI", "RELIANCE": "RELIANCE", "TCS": "TCS", "TATA CONSULTANCY": "TCS",
}
CRYPTO_ALIASES = {"BITCOIN": "BTC-USD", "BTC": "BTC-USD", "ETHEREUM": "ETH-USD", "ETH": "ETH-USD", "SOLANA": "SOL-USD", "SOL": "SOL-USD",
                  "DOGECOIN": "DOGE-USD", "DOGE": "DOGE-USD", "XRP": "XRP-USD", "RIPPLE": "XRP-USD", "CARDANO": "ADA-USD", "ADA": "ADA-USD",
                  "LITECOIN": "LTC-USD", "LTC": "LTC-USD"}


class ProviderError(Exception):
    """kind: not_found | refused | network | unsupported | other (mirrors MarketError, which wraps it)."""

    def __init__(self, message: str, kind: str = "other"):
        super().__init__(message)
        self.kind = kind


def market_open(now: datetime | None = None) -> bool:
    """Roughly: is NSE trading right now (Mon–Fri, 09:00–16:00 IST)? Only used to choose how long to cache."""
    n = (now or datetime.now(timezone.utc)).astimezone(IST)
    return n.weekday() < 5 and 9 <= n.hour < 16


def day_stamp(day: str) -> int:
    """A timestamp inside the given calendar day for (almost) every timezone, so charts label the right date."""
    y, m, d = (int(x) for x in day.split("-"))
    return int(datetime(y, m, d, 9, 30, tzinfo=timezone.utc).timestamp())


def weekly(candles: list[dict[str, float]]) -> list[dict[str, float]]:
    out: list[dict[str, float]] = []
    key = None
    for c in candles:
        iso = datetime.fromtimestamp(c["t"], timezone.utc).isocalendar()
        k = (iso[0], iso[1])
        if k != key:
            out.append(dict(c))
            key = k
        else:
            w = out[-1]
            w["h"], w["l"], w["c"], w["v"] = max(w["h"], c["h"]), min(w["l"], c["l"]), c["c"], w["v"] + c["v"]
    return out


class McpClient:
    """Just enough of the Model Context Protocol (Streamable HTTP transport) to call a tool and read its JSON answer."""

    def __init__(self, url: str, transport: httpx.AsyncBaseTransport | None = None):
        self.url = url
        self.transport = transport
        self._client: httpx.AsyncClient | None = None
        self._ready = False
        self._session: str | None = None
        self._id = 0
        self._init_lock = asyncio.Lock()
        self._gate = asyncio.Semaphore(3)  # be a polite guest: at most three requests in flight

    def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(transport=self.transport, timeout=httpx.Timeout(25, connect=10))
        return self._client

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json", "User-Agent": USER_AGENT}
        if self._session:
            h["Mcp-Session-Id"] = self._session
        return h

    @staticmethod
    def _message(resp: httpx.Response) -> dict[str, Any]:
        text = resp.text
        if "text/event-stream" in resp.headers.get("content-type", ""):
            frames = [ln[5:].strip() for ln in text.splitlines() if ln.startswith("data:")]
            text = frames[-1] if frames else ""
        try:
            data = json.loads(text) if text.strip() else {}
        except ValueError:
            raise ProviderError("The data service sent an answer NEXUS couldn't read.") from None
        return data if isinstance(data, dict) else {}

    async def _initialize(self) -> None:
        async with self._init_lock:
            if self._ready:
                return
            self._session = None
            r = await self._http().post(self.url, headers=self._headers(), json={
                "jsonrpc": "2.0", "id": 0, "method": "initialize",
                "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "personal-desktop-app", "version": "0.1"}}})
            if r.status_code >= 400:
                raise ProviderError(f"The data service refused the connection ({r.status_code}).", "refused" if r.status_code in (403, 429) else "other")
            self._session = r.headers.get("mcp-session-id")
            await self._http().post(self.url, headers=self._headers(), json={"jsonrpc": "2.0", "method": "notifications/initialized"})
            self._ready = True

    async def call(self, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Call a tool; return the JSON object it answers with. Tool-level problems come back as {"error": ...}."""
        async with self._gate:
            for attempt in (1, 2):
                try:
                    await self._initialize()
                    self._id += 1
                    r = await self._http().post(self.url, headers=self._headers(), json={
                        "jsonrpc": "2.0", "id": self._id, "method": "tools/call", "params": {"name": tool, "arguments": arguments}})
                except httpx.HTTPError as exc:
                    raise ProviderError("Couldn't reach the data service. Check the internet connection.", "network") from exc
                if r.status_code in (400, 401, 404) and attempt == 1:
                    self._ready = False  # the service forgot our session (it restarts now and then): start a new one
                    continue
                if r.status_code == 429:
                    raise ProviderError("The data service is busy right now. Try again in a minute.", "refused")
                if r.status_code >= 400:
                    raise ProviderError(f"The data service answered with an error ({r.status_code}).")
                msg = self._message(r)
                if msg.get("error"):
                    if attempt == 1 and "session" in json.dumps(msg["error"]).lower():
                        self._ready = False
                        continue
                    raise ProviderError(str((msg["error"] or {}).get("message") or "The data service reported an error."))
                result = msg.get("result") or {}
                text = next((c.get("text", "") for c in result.get("content") or [] if c.get("type") == "text"), "")
                if result.get("isError"):
                    raise ProviderError(text[:200] or "The data service reported an error.")
                try:
                    data = json.loads(text) if text.strip() else {}
                except ValueError:
                    return {"error": text[:200]}
                return data if isinstance(data, dict) else {"data": data}
        raise ProviderError("The data service kept dropping the connection.", "network")

    async def close(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()


class DailyStore:
    """Daily bars kept in the local database (as received, unadjusted) so history is fetched once and then topped up."""

    def __init__(self, db: Database):
        self.db = db

    def last_date(self, symbol: str) -> str | None:
        row = self.db.query_one("SELECT MAX(date) AS d FROM market_candles WHERE symbol = ?", (symbol,))
        return row["d"] if row else None

    def first_date(self, symbol: str) -> str | None:
        row = self.db.query_one("SELECT MIN(date) AS d FROM market_candles WHERE symbol = ?", (symbol,))
        return row["d"] if row else None

    def upsert(self, symbol: str, rows: list[tuple[str, float, float, float, float, float]]) -> None:
        if rows:
            self.db.executemany(
                "INSERT INTO market_candles(symbol, date, o, h, l, c, v) VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(symbol, date) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v",
                [(symbol, *r) for r in rows])

    def read(self, symbol: str) -> list[dict[str, Any]]:
        return self.db.query("SELECT date, o, h, l, c, v FROM market_candles WHERE symbol = ? ORDER BY date", (symbol,))

    def meta(self, symbol: str) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM market_series WHERE symbol = ?", (symbol,))
        if not row:
            return {"symbol": symbol, "synced_at": 0.0, "complete": 0, "actions": [], "actions_at": 0.0}
        row["actions"] = json.loads(row["actions"] or "[]")
        return row

    def set_meta(self, symbol: str, provider: str, **fields: Any) -> None:
        cur = self.meta(symbol)
        cur.update(fields)
        self.db.execute(
            "INSERT INTO market_series(symbol, provider, synced_at, complete, actions, actions_at) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(symbol) DO UPDATE SET provider=excluded.provider, synced_at=excluded.synced_at, complete=excluded.complete, "
            "actions=excluded.actions, actions_at=excluded.actions_at",
            (symbol, provider, float(cur["synced_at"]), int(cur["complete"]), json.dumps(cur["actions"]), float(cur["actions_at"])))


def adjust(rows: list[dict[str, Any]], actions: list[dict[str, Any]]) -> list[dict[str, float]]:
    """Turn stored daily rows into chart candles, scaling prices before each bonus/split by its factor."""
    acts = sorted((a for a in actions if a.get("factor") and a["factor"] > 0 and a["factor"] != 1), key=lambda a: a["date"])
    factor = 1.0
    for a in acts:
        factor *= a["factor"]
    out: list[dict[str, float]] = []
    i = 0
    for r in rows:
        while i < len(acts) and r["date"] >= acts[i]["date"]:
            factor /= acts[i]["factor"]  # on and after the ex-date, this event no longer applies
            i += 1
        out.append({"t": day_stamp(r["date"]), "o": r["o"] * factor, "h": r["h"] * factor, "l": r["l"] * factor, "c": r["c"] * factor,
                    "v": r["v"] / factor if factor else r["v"]})
    return out


class NseProvider:
    name = "nse"

    def __init__(self, db: Database, transport: httpx.AsyncBaseTransport | None = None):
        self.live = McpClient(NSE_LIVE, transport)
        self.hist = McpClient(NSE_HISTORY, transport)
        self.store = DailyStore(db)
        self._quotes: dict[str, tuple[float, dict[str, Any]]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    @staticmethod
    def handles(symbol: str) -> bool:
        return symbol.endswith(".NS") or symbol in NSE_INDEX

    async def close(self) -> None:
        await self.live.close()
        await self.hist.close()

    # -- quotes -------------------------------------------------------------------
    async def quote(self, symbol: str, fresh: bool = False) -> dict[str, Any]:
        hit = self._quotes.get(symbol)
        ttl = 60 if market_open() else 900
        if hit and not fresh and time.time() - hit[0] < ttl:
            return hit[1]
        if symbol in NSE_INDEX:
            d = await self.live.call("cm_get_index_quote", {"indexName": NSE_INDEX[symbol]})
            ix = d.get("index") or {}
            if d.get("error") or not ix:
                raise ProviderError(f"NSE doesn't list an index called {NSE_INDEX[symbol]}.", "not_found")
            price, prev = float(ix.get("last") or 0), float(ix.get("previousClose") or 0) or None
            when = _parse_time(str(ix.get("timeVal") or ""), "%d-%b-%Y %H:%M")
            q = {"symbol": symbol, "name": str(ix.get("indexName") or NSE_INDEX[symbol]), "currency": "INR", "exchange": "NSE", "kind": "index",
                 "price": price, "previous_close": prev, "day_open": ix.get("open"), "day_high": ix.get("high"), "day_low": ix.get("low"), "volume": 0.0}
        else:
            ticker = symbol[:-3]
            d = await self.live.call("cm_get_stock_quote", {"symbol": ticker})
            st = d.get("stock") or {}
            if d.get("error") or not st:
                raise ProviderError(f"NSE doesn't list a share called {ticker}.", "not_found")
            prev = float(st.get("preClosePrice") or 0) or None
            price = float(st.get("lastTradedPrice") or 0) or (prev or 0.0)
            when = _parse_time(str(st.get("latestTimestamp") or ""), "%Y-%m-%d %H:%M:%S")
            q = {"symbol": symbol, "name": str(st.get("symbol") or ticker), "currency": "INR", "exchange": "NSE", "kind": "equity",
                 "price": price, "previous_close": prev, "day_open": st.get("openPrice"), "day_high": st.get("highPrice"),
                 "day_low": st.get("lowPrice"), "volume": float(st.get("volume") or 0),
                 "year_high": st.get("fiftyTwoWeekHigh"), "year_low": st.get("fiftyTwoWeekLow")}
        if not q["price"]:
            raise ProviderError("NSE has no price for that symbol right now.")
        change = q["price"] - q["previous_close"] if q["previous_close"] else None
        q.update({"change": change, "change_percent": (change / q["previous_close"] * 100) if change is not None and q["previous_close"] else None,
                  "market_time": int(when.timestamp()) if when else None, "date": when.date().isoformat() if when else None,
                  "timezone": "Asia/Kolkata"})
        self._quotes[symbol] = (time.time(), q)
        return q

    # -- history ------------------------------------------------------------------
    async def _sync(self, symbol: str) -> bool:
        """Bring the stored daily bars up to date. Returns False if the service couldn't be reached but old data exists."""
        meta = self.store.meta(symbol)
        last = self.store.last_date(symbol)
        if last and time.time() - meta["synced_at"] < (600 if market_open() else 3600):
            return True
        is_index = symbol in NSE_INDEX
        tool = "get_index_history" if is_index else "get_stock_history"
        who = {"indexName": NSE_INDEX[symbol]} if is_index else {"symbol": symbol[:-3]}
        recent = bool(last) and (date.today() - date.fromisoformat(last)).days < 20
        end, complete = "", bool(meta["complete"])
        try:
            for page in range(30):
                d = await self.hist.call(tool, {**who, "months": 1 if (recent and page == 0) else 3, "endDate": end})
                rows = d.get("data") or []
                if not rows:
                    if page == 0 and not last:
                        raise ProviderError(f"NSE has no price history for {symbol.replace('.NS', '')}.", "not_found")
                    complete = True  # ran off the beginning of what NSE keeps
                    break
                self.store.upsert(symbol, [
                    (str(r["date"]), float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), float(r.get("volume") or 0))
                    for r in rows if r.get("series", "EQ") != "T0" and r.get("close") and r.get("open") and r.get("high") and r.get("low")])
                oldest = str(rows[0]["date"])
                end = str(d.get("next_end_date") or "")
                if last and oldest <= last and complete:
                    break  # caught up with what is already stored, and the older part was fetched before
                if last and oldest <= (self.store.first_date(symbol) or oldest) and not end:
                    complete = True
                    break
                if not end:
                    complete = True
                    break
        except ProviderError as exc:
            if exc.kind == "not_found" or not self.store.last_date(symbol):
                raise
            log.warning("NSE history refresh failed for %s: %s", symbol, exc)
            return False
        actions, actions_at = meta["actions"], meta["actions_at"]
        if not is_index and time.time() - actions_at > 86400:
            try:
                first = self.store.first_date(symbol) or "2020-01-01"
                ca = await self.hist.call("get_corporate_actions", {"symbol": symbol[:-3], "fromDate": first, "toDate": date.today().isoformat()})
                actions = [{"date": str(a["exDate"]), "factor": float(a["adjustmentFactor"]), "what": str(a.get("purpose") or a.get("actionType") or "")}
                           for a in ca.get("actions") or [] if a.get("exDate") and a.get("adjustmentFactor") not in (None, 1, 1.0)]
                actions_at = time.time()
            except (ProviderError, ValueError, TypeError) as exc:
                log.warning("NSE corporate actions failed for %s: %s", symbol, exc)
        self.store.set_meta(symbol, self.name, synced_at=time.time(), complete=int(complete), actions=actions, actions_at=actions_at)
        return True

    async def daily(self, symbol: str) -> tuple[list[dict[str, float]], bool]:
        """All daily candles (adjusted), plus whether they may be out of date."""
        lock = self._locks.setdefault(symbol, asyncio.Lock())
        async with lock:  # one download per symbol at a time, however many parts of the app ask at once
            ok = await self._sync(symbol)
        rows = self.store.read(symbol)
        candles = adjust(rows, self.store.meta(symbol)["actions"])
        try:
            q = await self.quote(symbol)
            # Before NSE publishes the day's official bar, show today's trading so far from the live quote.
            if rows and q.get("date") and q["date"] > rows[-1]["date"] and q.get("day_open") and q.get("day_high") and q.get("day_low"):
                candles.append({"t": day_stamp(q["date"]), "o": float(q["day_open"]), "h": float(q["day_high"]), "l": float(q["day_low"]),
                                "c": float(q["price"]), "v": float(q.get("volume") or 0)})
        except ProviderError:
            ok = False
        return candles, not ok

    async def history(self, symbol: str, range_: str, fresh: bool = False) -> dict[str, Any]:
        if range_ in ("1d", "5d"):
            raise ProviderError("NSE's free service has daily prices only. For minute-by-minute charts, switch the chart to TradingView.", "unsupported")
        candles, stale = await self.daily(symbol)
        interval = "1d"
        if range_ == "5y":
            candles, interval = weekly(candles), "1wk"
        else:
            n = {"1mo": 22, "6mo": 126, "1y": 252}.get(range_)
            if n:
                candles = candles[-n:]
        q = await self.quote(symbol, fresh=fresh)
        out = {"symbol": symbol, "range": range_, "interval": interval, "quote": q, "candles": candles, "fetched_at": now_iso(), "source": NSE_SOURCE}
        if stale:
            out["stale"] = True
        return out

    # -- market overview ----------------------------------------------------------
    OVERVIEW_INDICES = ("NIFTY 50", "NIFTY BANK", "NIFTY IT", "NIFTY MIDCAP 100", "INDIA VIX")

    async def overview(self) -> dict[str, Any]:
        """Headline indices and the day's biggest Nifty 50 movers, from NSE's live service."""
        indices: list[dict[str, Any]] = []
        for name in self.OVERVIEW_INDICES:
            try:
                d = await self.live.call("cm_get_index_quote", {"indexName": name})
            except ProviderError:
                continue
            ix = d.get("index") or {}
            if ix.get("last") is None:
                continue
            indices.append({"name": str(ix.get("indexName") or name), "last": float(ix["last"]), "change": float(ix.get("change") or 0),
                            "change_percent": float(ix.get("percChange") or 0), "high": ix.get("high"), "low": ix.get("low"),
                            "symbol": next((k for k, v in NSE_INDEX.items() if v == name), None), "time": ix.get("timeVal")})
        movers = await self.live.call("nse_get_market_movers", {"indexName": "NIFTY", "limit": 5})

        def rows(key: str) -> list[dict[str, Any]]:
            out = []
            for r in movers.get(key) or []:
                if r.get("symbol") and r.get("ltp") is not None:
                    out.append({"symbol": f"{r['symbol']}.NS", "name": str(r["symbol"]), "price": float(r["ltp"]),
                                "change_percent": float(r.get("perChange") or 0), "turnover": r.get("turnover")})
            return out

        if not indices and not movers.get("gainers"):
            raise ProviderError("NSE's live market service didn't return any data.")
        return {"indices": indices, "gainers": rows("gainers"), "losers": rows("losers"), "market_open": market_open(),
                "updated_at": movers.get("gainersUpdatedAt"), "source": NSE_SOURCE}

    # -- search -------------------------------------------------------------------
    async def search(self, query: str) -> list[dict[str, Any]]:
        raw = " ".join(query.upper().split())
        tries: list[str] = []
        for alias, ticker in NSE_ALIASES.items():
            if raw == alias or (len(raw) >= 4 and alias.startswith(raw)):
                tries.append(ticker)
        joined = re.sub(r"[^A-Z0-9&-]", "", raw)
        tries += [joined, raw.split(" ")[0]]
        seen: dict[str, dict[str, Any]] = {}
        cutoff = (date.today() - timedelta(days=12)).isoformat()
        for order, term in enumerate(dict.fromkeys(t for t in tries if len(t) >= 2)):
            try:
                d = await self.hist.call("search_symbols", {"query": term})
            except ProviderError:
                break
            for r in d.get("results") or []:
                sym = str(r.get("symbol") or "")
                if not sym or sym in seen:
                    continue
                active = str(r.get("last_date") or "") >= cutoff
                seen[sym] = {"symbol": f"{sym}.NS", "name": sym if active else f"{sym} (last traded {r.get('last_date')})",
                             "exchange": "NSE", "kind": "equity",
                             "_key": (0 if active else 1, order, 0 if sym == term else 1 if sym.startswith(term) else 2, len(sym))}
        ranked = sorted(seen.values(), key=lambda r: r["_key"])
        if any(r["_key"][0] == 0 for r in ranked):
            ranked = [r for r in ranked if r["_key"][0] == 0]  # hide tickers that no longer trade (old names, delisted) when live ones match
        return [{k: v for k, v in r.items() if k != "_key"} for r in ranked][:8]


def _parse_time(text: str, fmt: str) -> datetime | None:
    try:
        return datetime.strptime(text, fmt).replace(tzinfo=IST)
    except ValueError:
        return None


class CoinbaseProvider:
    name = "coinbase"
    _PAIR = re.compile(r"^[A-Z0-9]{2,10}-(USD|EUR|GBP|USDT|USDC)$")

    def __init__(self, db: Database, web: "WebService"):
        self.web = web
        self.store = DailyStore(db)
        self._cache: dict[tuple[str, str], tuple[float, Any]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    @classmethod
    def handles(cls, symbol: str) -> bool:
        return bool(cls._PAIR.match(symbol))

    async def close(self) -> None:
        return None

    async def _get(self, path: str, params: dict[str, str] | None = None) -> Any:
        try:
            _, _, body = await self.web._get(COINBASE + path, params, user_agent=USER_AGENT)  # noqa: SLF001 - shared guarded fetcher
        except WebBlocked as exc:
            msg = str(exc)
            if "(404)" in msg:
                raise ProviderError("Coinbase doesn't list that pair.", "not_found") from exc
            if "(429)" in msg:
                raise ProviderError("Coinbase's price service is busy. Try again in a minute.", "refused") from exc
            raise ProviderError(f"Couldn't get crypto prices. {msg}") from exc
        except httpx.HTTPError as exc:
            raise ProviderError("Couldn't reach Coinbase. Check the internet connection.", "network") from exc
        try:
            return json.loads(body)
        except ValueError:
            raise ProviderError("Coinbase sent an answer NEXUS couldn't read.") from None

    async def quote(self, symbol: str, fresh: bool = False) -> dict[str, Any]:
        hit = self._cache.get((symbol, "quote"))
        if hit and not fresh and time.time() - hit[0] < 30:
            return hit[1]
        ticker = await self._get(f"/products/{symbol}/ticker")
        stats = await self._get(f"/products/{symbol}/stats")
        price = float(ticker.get("price") or stats.get("last") or 0)
        if not price:
            raise ProviderError("Coinbase has no price for that pair right now.")
        base = float(stats.get("open") or 0) or None  # price 24 hours ago: crypto has no daily close
        change = price - base if base else None
        when = None
        try:
            when = datetime.fromisoformat(str(ticker.get("time", "")).replace("Z", "+00:00")[:26] + ("+00:00" if "+" not in str(ticker.get("time", ""))[19:] and "Z" not in str(ticker.get("time", "")) else ""))
        except ValueError:
            when = None
        q = {"symbol": symbol, "name": symbol.replace("-", " / "), "currency": symbol.split("-")[1].replace("USDT", "USD").replace("USDC", "USD"),
             "exchange": "Coinbase", "kind": "crypto", "price": price, "previous_close": base, "change": change,
             "change_percent": (change / base * 100) if change is not None and base else None,
             "market_time": int(when.timestamp()) if when else int(time.time()), "timezone": "UTC"}
        self._cache[(symbol, "quote")] = (time.time(), q)
        return q

    @staticmethod
    def _bars(raw: Any) -> list[dict[str, float]]:
        # Coinbase rows are [time, low, high, open, close, volume], newest first.
        out = [{"t": int(r[0]), "o": float(r[3]), "h": float(r[2]), "l": float(r[1]), "c": float(r[4]), "v": float(r[5]) if len(r) > 5 else 0.0}
               for r in raw if isinstance(r, list) and len(r) >= 5]
        return sorted(out, key=lambda c: c["t"])

    async def _sync(self, symbol: str) -> bool:
        meta = self.store.meta(symbol)
        last = self.store.last_date(symbol)
        if last and time.time() - meta["synced_at"] < 600:
            return True
        today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        floor = today - timedelta(days=5 * 365)
        stop = datetime.fromisoformat(last).replace(tzinfo=timezone.utc) if last else floor
        end = today + timedelta(days=1)
        try:
            for _ in range(8):
                start = max(stop, end - timedelta(days=299))
                raw = await self._get(f"/products/{symbol}/candles", {"granularity": "86400", "start": start.isoformat(), "end": end.isoformat()})
                bars = self._bars(raw)
                self.store.upsert(symbol, [(datetime.fromtimestamp(b["t"], timezone.utc).date().isoformat(), b["o"], b["h"], b["l"], b["c"], b["v"]) for b in bars])
                if not bars or start <= stop:
                    break
                end = start
        except ProviderError as exc:
            if exc.kind == "not_found" or not self.store.last_date(symbol):
                raise
            log.warning("Coinbase history refresh failed for %s: %s", symbol, exc)
            return False
        self.store.set_meta(symbol, self.name, synced_at=time.time(), complete=1)
        return True

    async def history(self, symbol: str, range_: str, fresh: bool = False) -> dict[str, Any]:
        stale = False
        if range_ in ("1d", "5d"):
            gran, span, ttl = (300, timedelta(hours=24), 60) if range_ == "1d" else (3600, timedelta(days=5), 300)
            hit = self._cache.get((symbol, range_))
            if hit and not fresh and time.time() - hit[0] < ttl:
                candles = hit[1]
            else:
                end = datetime.now(timezone.utc)
                candles = self._bars(await self._get(f"/products/{symbol}/candles", {
                    "granularity": str(gran), "start": (end - span).isoformat(), "end": end.isoformat()}))
                self._cache[(symbol, range_)] = (time.time(), candles)
            interval = "5m" if range_ == "1d" else "1h"
        else:
            async with self._locks.setdefault(symbol, asyncio.Lock()):
                stale = not await self._sync(symbol)
            candles = [{"t": day_stamp(r["date"]), "o": r["o"], "h": r["h"], "l": r["l"], "c": r["c"], "v": r["v"]} for r in self.store.read(symbol)]
            interval = "1d"
            if range_ == "5y":
                candles, interval = weekly(candles), "1wk"
            else:
                n = {"1mo": 30, "6mo": 182, "1y": 365}.get(range_)
                if n:
                    candles = candles[-n:]
        q = await self.quote(symbol, fresh=fresh)
        out = {"symbol": symbol, "range": range_, "interval": interval, "quote": q, "candles": candles, "fetched_at": now_iso(), "source": COINBASE_SOURCE}
        if stale:
            out["stale"] = True
        return out

    async def search(self, query: str) -> list[dict[str, Any]]:
        raw = " ".join(query.upper().split())
        sym = CRYPTO_ALIASES.get(raw) or (raw if self.handles(raw) else None)
        return [{"symbol": sym, "name": sym.replace("-", " / "), "exchange": "Coinbase", "kind": "crypto"}] if sym else []

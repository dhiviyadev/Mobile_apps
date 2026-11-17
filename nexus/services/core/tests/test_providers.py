"""NSE's official data service and Coinbase's public API, both replaced by stand-ins that behave the way the
real services were observed to behave (paging, unadjusted prices, T0 rows, session ids, error shapes)."""

import json
from datetime import date, timedelta

import httpx
import pytest
from conftest import arun, wait_task

from nexus_core.markets import providers
from nexus_core.markets.providers import adjust, day_stamp, weekly


def business_days(start: date, end: date):
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


class FakeNse:
    """Speaks the MCP Streamable-HTTP handshake and the NSE tools NEXUS uses."""

    def __init__(self):
        self.today = date.today()
        self.calls = []
        self.sessions = set()
        self.forget_sessions_once = False
        self.down = False
        self.bonus_on = None  # date of a 1:1 bonus for INFY
        self.first = self.today - timedelta(days=400)
        self.live = {"INFY": (1145.1, 1141.5), "RELIANCE": (1344.8, 1339.7), "M&M": (3340.0, 3333.0)}

    def rows(self, symbol):
        out, price = [], 2000.0
        for i, d in enumerate(business_days(self.first, self.today - timedelta(days=1))):
            if self.bonus_on and d == self.bonus_on:
                price /= 2  # unadjusted, exactly like the real feed
            prev = price
            price = round(price * (1.002 if i % 3 else 0.997), 2)
            out.append({"symbol": symbol, "series": "EQ", "open": prev, "high": round(max(prev, price) * 1.01, 2), "low": round(min(prev, price) * 0.99, 2),
                        "close": price, "prevClose": prev, "volume": 1_000_000 + i, "date": d.isoformat()})
        if len(out) > 40:
            out[-40] = {**out[-40], "series": "T0", "volume": 2}  # the odd thin settlement-series row
        return out

    def tool(self, name, a):
        if name == "cm_get_stock_quote":
            sym = a["symbol"].upper()
            if sym not in self.live:
                return {"error": f"Symbol '{sym}' not found"}
            last, prev = self.live[sym]
            return {"stock": {"type": "CM", "symbol": sym, "series": "EQ", "openPrice": prev + 1, "highPrice": last + 5, "lowPrice": prev - 5,
                              "preClosePrice": prev, "lastTradedPrice": last, "change": round(last - prev, 2), "perChange": 0.32, "volume": 4_852_092,
                              "fiftyTwoWeekHigh": 1728.0, "fiftyTwoWeekLow": 980.4, "latestTimestamp": f"{self.today.isoformat()} 15:29:58"}}
        if name == "cm_get_index_quote":
            if a["indexName"] != "NIFTY 50":
                return {"error": "Index not found"}
            return {"index": {"indexName": "NIFTY 50", "last": 25291.1, "previousClose": 25144.3, "open": 25206.15, "high": 25337.6, "low": 25172.1,
                              "timeVal": self.today.strftime("%d-%b-%Y") + " 15:30"}}
        if name in ("get_stock_history", "get_index_history"):
            sym = a.get("symbol") or a.get("indexName")
            if sym not in ("INFY", "RELIANCE", "NIFTY 50"):
                return {"error": f"Symbol not found: {sym}", "hint": "Use search_symbols tool to find valid symbols"}
            end = date.fromisoformat(a["endDate"]) if a["endDate"] else self.today
            start = end - timedelta(days=30 * min(int(a["months"]), 3))  # never more than three months a page
            page = [r for r in self.rows(sym) if start <= date.fromisoformat(r["date"]) <= end]
            if not page:
                return {"error": f"Symbol not found: {sym}"}  # what the real service says past the start of its data
            if name == "get_index_history":
                page = [{k: v for k, v in r.items() if k not in ("series", "symbol")} for r in page]
            return {"symbol": sym, "data": page, "chunk_months": int(a["months"]), "next_end_date": (start - timedelta(days=1)).isoformat()}
        if name == "get_corporate_actions":
            acts = [{"exDate": (self.today - timedelta(days=200)).isoformat(), "actionType": "DIVIDEND", "purpose": "Dividend - Rs 10", "adjustmentFactor": 1.0}]
            if self.bonus_on and a["symbol"] == "INFY":
                acts.append({"exDate": self.bonus_on.isoformat(), "actionType": "BONUS", "purpose": "Bonus 1:1", "adjustmentFactor": 0.5})
            return {"symbol": a["symbol"], "count": len(acts), "actions": acts}
        if name == "search_symbols":
            fresh, old = self.today.isoformat(), "2023-06-06"
            book = {"INFY": fresh, "INFIBEAM": fresh, "HDFC": old, "HDFCBANK": fresh, "HDFCLIFE": fresh, "TATAMOTORS": "2025-10-23", "M&M": fresh}
            hits = [{"symbol": s, "last_close": 100.0, "pct_change": 0.1, "last_date": d} for s, d in book.items() if a["query"] in s]
            return {"results": hits, "count": len(hits), "query": a["query"]}
        return {"error": f"unknown tool {name}"}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("no route")
        assert request.headers["user-agent"].startswith("personal-desktop-app")  # honest client name, never a fake browser
        msg = json.loads(request.content)
        if msg["method"] == "initialize":
            sid = f"sess-{len(self.sessions) + 1}"
            self.sessions.add(sid)
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake"}}}, headers={"mcp-session-id": sid})
        if msg["method"] == "notifications/initialized":
            return httpx.Response(202)
        if self.forget_sessions_once:
            self.forget_sessions_once = False
            self.sessions.clear()
        if request.headers.get("mcp-session-id") not in self.sessions:
            return httpx.Response(404, json={"error": "unknown session"})
        self.calls.append((msg["params"]["name"], msg["params"]["arguments"]))
        text = json.dumps(self.tool(msg["params"]["name"], msg["params"]["arguments"]))
        body = {"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [{"type": "text", "text": text}], "isError": False}}
        if len(self.calls) % 2:  # the real service may answer either way; accept both
            return httpx.Response(200, text=f"event: message\ndata: {json.dumps(body)}\n\n", headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json=body)


def coinbase(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    assert request.headers["host"] == "api.exchange.coinbase.com" and request.headers["user-agent"].startswith("personal-desktop-app")
    if "/NOPE-USD/" in path:
        return httpx.Response(404, json={"message": "NotFound"})
    if path.endswith("/ticker"):
        return httpx.Response(200, json={"price": "64626.06", "time": "2026-11-16T16:49:28.408739358Z", "volume": "11644.8"})
    if path.endswith("/stats"):
        return httpx.Response(200, json={"open": "64672.19", "high": "65626.98", "low": "63833.47", "last": "64627", "volume": "11644.8"})
    if path.endswith("/candles"):
        q = dict(request.url.params)
        gran = int(q["granularity"])
        from datetime import datetime

        start, end = (datetime.fromisoformat(q[k]).timestamp() for k in ("start", "end"))
        assert (end - start) / gran <= 300  # the real API refuses more than 300 bars a request
        t0 = int(start // gran * gran)
        bars = [[t, 60000 + i, 60500 + i, 60100 + i, 60300 + i, 12.5] for i, t in enumerate(range(t0, int(end), gran))]
        return httpx.Response(200, json=list(reversed(bars)))  # newest first, [time, low, high, open, close, volume]
    return httpx.Response(404, json={"message": "NotFound"})


@pytest.fixture
def nse(client, st):
    fake = FakeNse()
    t = httpx.MockTransport(fake)
    st.markets.nse.live.transport = st.markets.nse.hist.transport = t
    st.web.transport = httpx.MockTransport(lambda r: coinbase(r) if r.headers["host"].endswith("coinbase.com") else httpx.Response(429, text="Too Many Requests"))

    async def resolver(host, port):
        return ["93.184.216.34"]

    st.web.resolver = resolver
    st.markets.retry_delay = 0
    client.patch("/api/settings", json={"values": {"markets.enabled": True}})
    return fake


def test_pure_helpers():
    rows = [{"date": "2024-10-24", "o": 2670.0, "h": 2690.0, "l": 2650.0, "c": 2680.0, "v": 100.0},
            {"date": "2024-10-25", "o": 2687.0, "h": 2700.0, "l": 2640.0, "c": 2655.7, "v": 100.0},
            {"date": "2024-10-28", "o": 1337.0, "h": 1340.0, "l": 1320.0, "c": 1334.35, "v": 200.0}]
    plain = adjust(rows, [])
    assert plain[1]["c"] == 2655.7 and plain[0]["t"] == day_stamp("2024-10-24")
    adj = adjust(rows, [{"date": "2024-10-28", "factor": 0.5}, {"date": "2024-08-19", "factor": 1.0}])
    assert adj[1]["c"] == pytest.approx(1327.85) and adj[1]["v"] == 200.0  # before the bonus: price halved, volume doubled
    assert adj[2]["c"] == 1334.35 and adj[2]["v"] == 200.0  # on and after the ex-date: untouched
    assert abs(adj[2]["o"] / adj[1]["c"] - 1) < 0.01  # so the fake 50% "crash" is gone
    wk = weekly([{"t": day_stamp(d), "o": o, "h": h, "l": lo, "c": c, "v": 10.0} for d, o, h, lo, c in
                 (("2026-11-09", 10, 12, 9, 11), ("2026-11-10", 11, 15, 10, 14), ("2026-11-16", 14, 16, 13, 15))])
    assert len(wk) == 2 and wk[0] == {"t": day_stamp("2026-11-09"), "o": 10, "h": 15, "l": 9, "c": 14, "v": 20.0}
    assert providers.market_open.__doc__ and providers.NseProvider.handles("INFY.NS") and providers.NseProvider.handles("^NSEI")
    assert not providers.NseProvider.handles("AAPL") and providers.CoinbaseProvider.handles("BTC-USD") and not providers.CoinbaseProvider.handles("INFY.NS")


def test_nse_quote_history_paging_and_local_store(client, st, nse):
    h = client.get("/api/markets/history/infy.ns?range=6mo").json()
    q = h["quote"]
    assert q["symbol"] == "INFY.NS" and q["price"] == 1145.1 and q["previous_close"] == 1141.5 and q["currency"] == "INR" and q["exchange"] == "NSE"
    assert q["change"] == pytest.approx(3.6) and round(q["change_percent"], 2) == 0.32 and "NSE India" in h["source"] and "stale" not in h
    pages = [a for n, a in nse.calls if n == "get_stock_history"]
    assert len(pages) >= 5 and all(p["months"] <= 3 for p in pages) and pages[0]["endDate"] == "" and pages[1]["endDate"]  # paged backwards
    stored = st.db.query_one("SELECT COUNT(*) AS n, MIN(date) AS a FROM market_candles WHERE symbol = 'INFY.NS'")
    assert stored["n"] > 250 and stored["a"] <= (nse.first + timedelta(days=3)).isoformat()
    assert not st.db.query_one("SELECT 1 AS x FROM market_candles c WHERE symbol='INFY.NS' AND v < 10")  # the thin T0 row was dropped
    assert len(h["candles"]) == 126 and h["interval"] == "1d"
    # Today's bar isn't published until the evening, so it comes from the live quote.
    assert h["candles"][-1]["t"] == day_stamp(nse.today.isoformat()) and h["candles"][-1]["c"] == 1145.1
    # Everything is now local: other ranges and a second look cost no further history downloads.
    before = len([1 for n, _ in nse.calls if n == "get_stock_history"])
    assert client.get("/api/markets/history/INFY.NS?range=1y").json()["candles"][-1]["c"] == 1145.1
    wk = client.get("/api/markets/history/INFY.NS?range=5y").json()
    assert wk["interval"] == "1wk" and 50 < len(wk["candles"]) < 70
    assert len([1 for n, _ in nse.calls if n == "get_stock_history"]) == before
    r = client.get("/api/markets/history/INFY.NS?range=1d")
    assert r.status_code == 400 and "daily prices only" in r.json()["detail"] and "TradingView" in r.json()["detail"]
    # Later the same day: one small top-up request, not the whole history again.
    st.db.execute("UPDATE market_series SET synced_at = 0")
    client.get("/api/markets/history/INFY.NS?range=6mo")
    top_up = [a for n, a in nse.calls if n == "get_stock_history"][before:]
    assert len(top_up) == 1 and top_up[0]["months"] == 1


def test_nse_bonus_issue_is_adjusted(client, st, nse):
    nse.bonus_on = next(d for d in business_days(nse.today - timedelta(days=120), nse.today))
    candles = client.get("/api/markets/history/INFY.NS?range=1y").json()["candles"]
    worst = min(b["c"] / a["c"] - 1 for a, b in zip(candles[:-2], candles[1:-1]))
    assert worst > -0.05  # no fake 50% drop on the bonus date
    raw = st.db.query("SELECT date, c FROM market_candles WHERE symbol='INFY.NS' ORDER BY date")
    assert min(b["c"] / a["c"] - 1 for a, b in zip(raw, raw[1:])) < -0.45  # ...although the stored raw data does have it
    a = client.get("/api/markets/analysis/INFY.NS").json()
    assert a["bias"] in ("long", "short", "neutral") and a["currency"] == "INR" and a["backtest"]["bars_tested"] > 50


def test_nse_index_search_errors_and_session_recovery(client, st, nse):
    ix = client.get("/api/markets/history/%5ENSEI?range=1mo").json()
    assert ix["quote"]["name"] == "NIFTY 50" and ix["quote"]["price"] == 25291.1 and ix["quote"]["kind"] == "index" and len(ix["candles"]) == 22
    names = lambda q: [r["symbol"] for r in client.get("/api/markets/search", params={"q": q}).json()]  # noqa: E731
    assert names("infy")[0] == "INFY.NS" and "INFIBEAM.NS" not in names("INFY")[:1]
    assert names("Infosys")[0] == "INFY.NS"  # NSE only searches tickers; well-known names are mapped
    assert names("hdfc bank")[0] == "HDFCBANK.NS" and "HDFC.NS" not in names("hdfc bank")  # the long-delisted HDFC is hidden
    assert names("mahindra")[0] == "M&M.NS" and names("bitcoin") == ["BTC-USD"]
    assert client.get("/api/markets/history/NOPE.NS").json()["detail"].startswith("NSE has no price history")
    assert client.post("/api/markets/watchlist", json={"symbol": "NOPE.NS"}).status_code == 400
    # A bare ticker Yahoo refuses is tried on NSE, so typing "RELIANCE" just works.
    assert client.post("/api/markets/watchlist", json={"symbol": "reliance"}).json()["symbol"] == "RELIANCE.NS"
    assert client.post("/api/markets/watchlist", json={"symbol": "M&M.NS"}).json()["price"] == 3340.0
    # The service forgets sessions now and then; NEXUS quietly starts a new one.
    nse.forget_sessions_once = True
    st.markets.nse._quotes.clear()
    assert client.get("/api/markets").json()["watchlist"][0]["quote"]["price"] == 1344.8 and len(nse.sessions) >= 1
    # If NSE can't be reached, stored history is still shown, marked as possibly out of date.
    client.get("/api/markets/history/RELIANCE.NS?range=6mo")
    nse.down = True
    st.markets.nse._quotes.clear()
    st.db.execute("UPDATE market_series SET synced_at = 0")
    r = client.get("/api/markets/history/RELIANCE.NS?range=6mo")
    assert r.status_code == 400 and "internet connection" in r.json()["detail"]  # no live quote at all → say so plainly
    nse.down = False


def test_crypto_from_coinbase(client, st, nse):
    h = client.get("/api/markets/history/btc-usd?range=1d").json()
    assert h["quote"]["price"] == 64626.06 and h["quote"]["currency"] == "USD" and h["quote"]["exchange"] == "Coinbase"
    assert h["quote"]["change"] == pytest.approx(64626.06 - 64672.19) and h["interval"] == "5m" and 280 <= len(h["candles"]) <= 290
    assert h["candles"][0]["o"] == 60100 and h["candles"][0]["h"] == 60500 and h["candles"][0]["l"] == 60000 and h["candles"][0]["c"] == 60300
    y = client.get("/api/markets/history/BTC-USD?range=1y").json()
    assert y["interval"] == "1d" and len(y["candles"]) == 365 and "Coinbase" in y["source"]
    assert st.db.query_one("SELECT COUNT(*) AS n FROM market_candles WHERE symbol='BTC-USD'")["n"] > 1500  # five years, fetched in pages of ≤300
    assert client.get("/api/markets/history/NOPE-USD").json()["detail"] == "Coinbase doesn't list that pair."


def test_practice_account_alerts_and_agents_run_on_nse_prices(client, st, nse, fake_ollama):
    client.post("/api/markets/watchlist", json={"symbol": "INFY.NS"})
    # First trade is in rupees and nothing has been traded yet: the practice account simply becomes a rupee account.
    o = client.post("/api/markets/orders", json={"symbol": "INFY.NS", "side": "buy", "quantity": 10}).json()
    assert o["price"] == 1145.1 and o["total"] == 11451.0
    p = client.get("/api/markets").json()["portfolio"]
    assert p["currency"] == "INR" and p["starting_cash"] == 1_000_000 and p["cash"] == 1_000_000 - 11451.0 and p["positions"][0]["value"] == 11451.0
    # Once trading has started, the account's currency is fixed until the user resets it.
    assert "trades in USD" in client.post("/api/markets/orders", json={"symbol": "BTC-USD", "side": "buy", "quantity": 0.01}).json()["detail"]
    a = client.post("/api/markets/alerts", json={"symbol": "INFY.NS", "direction": "above", "price": 1150}).json()
    assert arun(client, st.markets.check_alerts) == []
    nse.live["INFY"] = (1152.0, 1141.5)
    st.markets.nse._quotes.clear()
    assert [f["id"] for f in arun(client, st.markets.check_alerts)] == [a["id"]]
    scan = client.get("/api/markets/scan").json()
    assert scan[0]["symbol"] == "INFY.NS" and "error" not in scan[0]
    fake_ollama.script({"tool_calls": [{"function": {"name": "market_analysis", "arguments": {"symbol": "INFY.NS"}}}]}, {"content": "**View:** Stay out."})
    t = wait_task(client, client.post("/api/agents/trader/tasks", json={"prompt": "INFY?", "runtime": "native"}).json()["id"])
    tool = json.loads([m for m in [r for r in fake_ollama.requests if r["path"] == "/api/chat"][-1]["body"]["messages"] if m["role"] == "tool"][0]["content"])
    assert t["status"] == "completed" and tool["price"] == 1152.0 and tool["currency"] == "INR" and "NSE India" in tool["source"]


def test_market_overview(client, st, nse):
    def movers(self, name, a, orig=FakeNse.tool):
        if name == "nse_get_market_movers":
            return {"segment": "NIFTY", "gainersUpdatedAt": "2026-11-17T10:00:00Z",
                    "gainers": [{"symbol": "ADANIENT", "ltp": 2745.1, "perChange": 3.24, "turnover": "546.66 Cr"}],
                    "losers": [{"symbol": "HCLTECH", "ltp": 1355.7, "perChange": -2.09, "turnover": "399.80 Cr"}]}
        return orig(self, name, a)

    FakeNse.tool = movers
    try:
        ov = client.get("/api/markets/overview").json()
    finally:
        FakeNse.tool = movers.__defaults__[0]
    assert [i["name"] for i in ov["indices"]] == ["NIFTY 50"] and ov["indices"][0]["symbol"] == "^NSEI"  # unknown indices are skipped
    assert ov["gainers"] == [{"symbol": "ADANIENT.NS", "name": "ADANIENT", "price": 2745.1, "change_percent": 3.24, "turnover": "546.66 Cr"}]
    assert ov["losers"][0]["symbol"] == "HCLTECH.NS" and "NSE India" in ov["source"]
    n = len(nse.calls)
    client.get("/api/markets/overview")
    assert len(nse.calls) == n  # cached
    from nexus_core.automations.templates import TEMPLATES

    tpl = next(t for t in TEMPLATES if t["template"] == "market_close_briefing")
    assert tpl["actions"][0]["agent_id"] == "trader" and "market_overview" in tpl["actions"][0]["prompt"]
    assert "market_overview" in st.agents.get("trader")["tools"]


def test_watchlist_carries_a_local_sparkline(client, st, nse):
    client.post("/api/markets/watchlist", json={"symbol": "INFY.NS"})
    assert client.get("/api/markets").json()["watchlist"][0]["spark"] == []  # nothing downloaded yet: no extra fetch
    client.get("/api/markets/history/INFY.NS?range=1mo")
    spark = client.get("/api/markets").json()["watchlist"][0]["spark"]
    assert len(spark) == 30 and spark == sorted(spark, key=lambda _: 0)  # 30 most recent closes, oldest first
    last = st.db.query_one("SELECT c FROM market_candles WHERE symbol='INFY.NS' ORDER BY date DESC LIMIT 1")["c"]
    assert spark[-1] == last


def test_replies_follow_the_users_language(client, fake_ollama):
    from conftest import read_sse

    conv = client.post("/api/conversations", json={}).json()
    read_sse(client.post(f"/api/conversations/{conv['id']}/messages", json={"content": "निबंध लेखन क्या है?"}))
    system = [r for r in fake_ollama.requests if r["path"] == "/api/chat"][-1]["body"]["messages"][0]["content"]
    assert "reply in the language the user writes in" in system


def test_trend_lines_fill_in_by_themselves(client, st, nse):
    import time

    client.post("/api/markets/watchlist", json={"symbol": "RELIANCE.NS"})
    client.get("/api/markets")  # starts a background download of the missing history
    for _ in range(100):
        if client.get("/api/markets").json()["watchlist"][0]["spark"]:
            break
        time.sleep(0.05)
    assert len(client.get("/api/markets").json()["watchlist"][0]["spark"]) == 30


def test_sparkline_is_bonus_adjusted(client, st, nse):
    nse.bonus_on = next(d for d in business_days(nse.today - timedelta(days=20), nse.today))
    client.post("/api/markets/watchlist", json={"symbol": "INFY.NS"})
    client.get("/api/markets/history/INFY.NS?range=1mo")
    spark = client.get("/api/markets").json()["watchlist"][0]["spark"]
    assert min(b / a - 1 for a, b in zip(spark, spark[1:])) > -0.05  # the 1:1 bonus doesn't show as a 50% fall

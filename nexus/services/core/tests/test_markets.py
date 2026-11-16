"""Markets: real-data parsing, watchlist, practice account, alerts. The data service is faked at the HTTP layer."""

import json

import httpx
import pytest
from conftest import arun, wait_task

from nexus_core.markets.service import MarketError, parse_chart

DAY = 86400


def chart(symbol="AAPL", price=200.0, prev=196.0, currency="USD", closes=(190.0, 194.0, None, 198.0, 200.0), name="Apple Inc."):
    """A response in the shape Yahoo's chart service documents (including a null bar, as it sends for gaps)."""
    n = len(closes)
    return {"chart": {"result": [{
        "meta": {"currency": currency, "symbol": symbol, "exchangeName": "NMS", "fullExchangeName": "NasdaqGS",
                 "instrumentType": "EQUITY", "regularMarketPrice": price, "chartPreviousClose": prev,
                 "regularMarketTime": 1_760_000_000, "exchangeTimezoneName": "America/New_York", "longName": name},
        "timestamp": [1_759_500_000 + i * DAY for i in range(n)],
        "indicators": {"quote": [{
            "open": [None if c is None else c - 1 for c in closes], "high": [None if c is None else c + 2 for c in closes],
            "low": [None if c is None else c - 3 for c in closes], "close": list(closes),
            "volume": [None if c is None else 1_000_000 + i for i, c in enumerate(closes)]}]},
    }], "error": None}}


class FakeYahoo:
    def __init__(self):
        self.prices = {"AAPL": (200.0, 196.0, "USD", "Apple Inc."), "MSFT": (400.0, 404.0, "USD", "Microsoft Corporation"),
                       "SAP.DE": (250.0, 249.0, "EUR", "SAP SE")}
        self.calls = []
        self.status = 200

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        host, path = request.headers["host"], request.url.path
        if self.status != 200:
            return httpx.Response(self.status, json={})
        if host == "query2.finance.yahoo.com":
            return httpx.Response(200, json={"quotes": [
                {"symbol": "AAPL", "shortname": "Apple Inc.", "longname": "Apple Inc.", "exchDisp": "NASDAQ", "typeDisp": "Equity"},
                {"symbol": "bad symbol!", "shortname": "junk"}]})
        if host == "query1.finance.yahoo.com" and path.startswith("/v8/finance/chart/"):
            sym = path.rsplit("/", 1)[-1].upper()
            if sym not in self.prices:
                return httpx.Response(404, json={"chart": {"result": None, "error": {"code": "Not Found", "description": "No data found"}}})
            price, prev, cur, name = self.prices[sym]
            if dict(request.url.params).get("range") != "1d":
                prev = price / 2  # like the real service: on long ranges this is the close before the range began
            return httpx.Response(200, json=chart(sym, price, prev, cur, name=name))
        return httpx.Response(404)


@pytest.fixture
def yahoo(client, st):
    fake = FakeYahoo()
    st.web.transport = httpx.MockTransport(fake)

    async def resolver(host, port):
        return ["93.184.216.34"]

    st.web.resolver = resolver
    return fake


def on(client):
    assert client.patch("/api/settings", json={"values": {"markets.enabled": True}}).status_code == 200


def test_parse_chart_drops_gaps_and_reports_errors():
    parsed = parse_chart(chart())
    assert [c["c"] for c in parsed["candles"]] == [190.0, 194.0, 198.0, 200.0]  # the null bar is skipped
    assert parsed["candles"][0] == {"t": 1_759_500_000, "o": 189.0, "h": 192.0, "l": 187.0, "c": 190.0, "v": 1_000_000.0}
    assert parsed["meta"]["price"] == 200.0 and parsed["meta"]["currency"] == "USD" and parsed["meta"]["name"] == "Apple Inc."
    with pytest.raises(MarketError, match="No data found"):
        parse_chart({"chart": {"result": None, "error": {"description": "No data found"}}})
    with pytest.raises(MarketError):
        parse_chart({})


def test_markets_are_off_by_default(client, yahoo):
    ov = client.get("/api/markets").json()
    assert ov["enabled"] is False and ov["watchlist"] == [] and ov["portfolio"]["cash"] == 100_000
    assert client.get("/api/markets/history/AAPL").status_code == 400
    assert client.post("/api/markets/orders", json={"symbol": "AAPL", "side": "buy", "quantity": 1}).status_code == 400
    assert client.get("/api/markets/search?q=apple").status_code == 400
    assert yahoo.calls == []  # nothing was requested while off


def test_history_quote_search_and_cache(client, st, yahoo):
    on(client)
    h = client.get("/api/markets/history/aapl?range=6mo").json()
    assert h["symbol"] == "AAPL" and h["interval"] == "1d" and len(h["candles"]) == 4
    # The day's change comes from yesterday's close (196), not from the start of the six-month range (100).
    assert h["quote"]["price"] == 200.0 and h["quote"]["previous_close"] == 196.0
    assert round(h["quote"]["change_percent"], 3) == round(4 / 196 * 100, 3)
    assert "may be delayed" in h["source"]
    req = yahoo.calls[-1]
    assert req.url.host == "93.184.216.34" and req.headers["host"] == "query1.finance.yahoo.com"  # pinned, like web access
    assert {dict(c.url.params)["range"] for c in yahoo.calls} == {"6mo", "1d"}
    n = len(yahoo.calls)
    client.get("/api/markets/history/AAPL?range=6mo")
    assert len(yahoo.calls) == n  # served from the short-lived cache
    assert client.get("/api/markets/search?q=apple").json() == [{"symbol": "AAPL", "name": "Apple Inc.", "exchange": "NASDAQ", "kind": "equity"}]
    assert client.get("/api/markets/history/AAPL?range=10y").status_code == 400
    assert client.get("/api/markets/history/NOPE").json()["detail"] == "That symbol wasn't found."
    assert client.get("/api/markets/history/a b").status_code == 400
    yahoo.status = 429
    st.markets.retry_delay = 0
    assert "turning away automated requests" in client.get("/api/markets/history/MSFT").json()["detail"]


def test_watchlist(client, yahoo):
    on(client)
    assert client.post("/api/markets/watchlist", json={"symbol": "msft"}).json()["symbol"] == "MSFT"
    client.post("/api/markets/watchlist", json={"symbol": "AAPL"})
    client.post("/api/markets/watchlist", json={"symbol": "AAPL"})  # adding twice is harmless
    assert client.post("/api/markets/watchlist", json={"symbol": "NOPE"}).status_code == 400
    ov = client.get("/api/markets").json()
    assert [w["symbol"] for w in ov["watchlist"]] == ["MSFT", "AAPL"]
    assert ov["watchlist"][0]["quote"]["price"] == 400.0 and ov["watchlist"][0]["quote"]["change"] == -4.0
    assert ov["watchlist"][1]["name"] == "Apple Inc."
    client.delete("/api/markets/watchlist/msft")
    assert [w["symbol"] for w in client.get("/api/markets").json()["watchlist"]] == ["AAPL"]


def test_practice_account_buy_sell_and_pnl(client, st, yahoo):
    on(client)
    order = lambda **kw: client.post("/api/markets/orders", json=kw)  # noqa: E731
    r = order(symbol="AAPL", side="buy", quantity=10).json()
    assert r["price"] == 200.0 and r["total"] == 2000.0 and r["practice"] is True
    yahoo.prices["AAPL"] = (220.0, 200.0, "USD", "Apple Inc.")
    order(symbol="AAPL", side="buy", quantity=10)  # second lot at 220 → average cost 210
    p = client.get("/api/markets").json()["portfolio"]
    pos = p["positions"][0]
    assert p["cash"] == 100_000 - 2000 - 2200 and pos["quantity"] == 20 and pos["avg_cost"] == 210.0
    assert pos["value"] == 4400.0 and pos["pnl"] == 200.0 and p["equity"] == 100_200.0 and round(p["total_return_percent"], 3) == 0.2

    yahoo.prices["AAPL"] = (230.0, 220.0, "USD", "Apple Inc.")
    sold = order(symbol="AAPL", side="sell", quantity=5).json()
    assert sold["realized_pnl"] == 100.0  # (230 - 210) × 5
    p = client.get("/api/markets").json()["portfolio"]
    assert p["positions"][0]["quantity"] == 15 and p["realized_pnl"] == 100.0 and p["cash"] == 95_800 + 1150

    # Guard rails: no short selling, no overspending, no other-currency instruments, sane quantities.
    assert "short selling" in order(symbol="AAPL", side="sell", quantity=16).json()["detail"]
    assert "Not enough practice cash" in order(symbol="MSFT", side="buy", quantity=1000).json()["detail"]
    assert "trades in EUR" in order(symbol="SAP.DE", side="buy", quantity=1).json()["detail"]
    for bad in (0, -1, 0.0000001):
        assert order(symbol="AAPL", side="buy", quantity=bad).status_code == 400
    assert order(symbol="AAPL", side="hold", quantity=1).status_code == 400

    order(symbol="AAPL", side="sell", quantity=15)
    assert client.get("/api/markets").json()["portfolio"]["positions"] == []
    orders = client.get("/api/markets/orders").json()
    assert [o["side"] for o in orders] == ["sell", "sell", "buy", "buy"]
    assert any(a["action"] == "markets.practice_order" for a in client.get("/api/audit").json())

    # Reset: a fresh account, optionally in another currency.
    assert client.post("/api/markets/account/reset", json={"cash": 5000, "currency": "eur"}).json()["cash"] == 5000
    assert client.get("/api/markets/orders").json() == []
    assert order(symbol="SAP.DE", side="buy", quantity=2).json()["total"] == 500.0
    assert client.post("/api/markets/account/reset", json={"cash": 1, "currency": "USD"}).status_code == 400
    assert client.post("/api/markets/account/reset", json={"cash": 1000, "currency": "dollars"}).status_code == 400


def test_orders_respect_emergency_stop(client, yahoo):
    on(client)
    client.post("/api/system/emergency-stop")
    assert client.post("/api/markets/orders", json={"symbol": "AAPL", "side": "buy", "quantity": 1}).status_code == 403


def test_price_alerts_fire_once(client, st, yahoo):
    on(client)
    a = client.post("/api/markets/alerts", json={"symbol": "aapl", "direction": "above", "price": 210}).json()
    client.post("/api/markets/alerts", json={"symbol": "MSFT", "direction": "below", "price": 390})
    assert client.post("/api/markets/alerts", json={"symbol": "AAPL", "direction": "sideways", "price": 1}).status_code == 400
    assert client.post("/api/markets/alerts", json={"symbol": "AAPL", "direction": "above", "price": 0}).status_code == 400
    assert arun(client, st.markets.check_alerts) == []  # 200 is not above 210, 400 is not below 390
    yahoo.prices["AAPL"] = (212.5, 200.0, "USD", "Apple Inc.")
    st.markets._cache.clear()
    fired = arun(client, st.markets.check_alerts)
    assert [f["id"] for f in fired] == [a["id"]] and fired[0]["triggered_price"] == 212.5
    assert arun(client, st.markets.check_alerts) == []  # already triggered
    notes = client.get("/api/notifications").json()
    assert notes[0]["title"] == "AAPL is above 210" and "212.5" in notes[0]["body"]
    alerts = client.get("/api/markets").json()["alerts"]
    assert [x["triggered_at"] is not None for x in alerts] == [False, True]  # active first
    client.delete(f"/api/markets/alerts/{a['id']}")
    assert len(client.get("/api/markets").json()["alerts"]) == 1


def test_agent_can_read_prices_but_not_trade(client, st, yahoo, fake_ollama):
    from nexus_core.agents.tools import TOOLS

    assert not any("order" in name or "trade" in name or "buy" in name for name in TOOLS)
    fake_ollama.script({"tool_calls": [{"function": {"name": "market_data", "arguments": {"symbol": "AAPL"}}}]}, {"content": "Markets are off."},
                       {"tool_calls": [{"function": {"name": "market_data", "arguments": {"symbol": "AAPL", "range": "1mo"}}}]}, {"content": "AAPL is at 200."})
    t = wait_task(client, client.post("/api/agents/analyst/tasks", json={"prompt": "price of apple", "runtime": "native"}).json()["id"])
    tool = [m for m in [r for r in fake_ollama.requests if r["path"] == "/api/chat"][-1]["body"]["messages"] if m["role"] == "tool"][0]
    assert t["status"] == "completed" and "turned off" in tool["content"]
    on(client)
    t = wait_task(client, client.post("/api/agents/analyst/tasks", json={"prompt": "price of apple", "runtime": "native"}).json()["id"])
    tool = json.loads([m for m in [r for r in fake_ollama.requests if r["path"] == "/api/chat"][-1]["body"]["messages"] if m["role"] == "tool"][0]["content"])
    assert tool["price"] == 200.0 and tool["period_high"] == 202.0 and tool["period_low"] == 187.0 and len(tool["recent_closes"]) == 4
    assert "not financial advice" in tool["note"]


def test_phones_can_look_but_not_trade(client, yahoo):
    on(client)
    client.patch("/api/devices/remote", json={"enabled": True, "hostnames": ["mac.tail1.ts.net"]})
    code = client.post("/api/devices/pair").json()["code"]
    tok = client.post("/api/devices/claim", json={"code": code}).json()["token"]
    h = {"Authorization": f"Bearer {tok}", "Host": "mac.tail1.ts.net"}
    assert client.get("/api/markets", headers=h).status_code == 200
    assert client.post("/api/markets/orders", json={"symbol": "AAPL", "side": "buy", "quantity": 1}, headers=h).status_code == 403
    assert client.post("/api/markets/account/reset", json={}, headers=h).status_code == 403
    assert client.delete("/api/markets/watchlist/AAPL", headers=h).status_code == 403


def test_markets_stay_usable_when_the_price_service_refuses(client, st, yahoo):
    """Yahoo turns automated clients away with 429. That must be said plainly, and must not make the page useless."""
    on(client)
    st.markets.retry_delay = 0
    client.get("/api/markets/history/AAPL?range=6mo")  # fills the cache while the service still answers
    yahoo.status = 429
    st.markets._cache = {k: (0.0, v) for k, (_, v) in st.markets._cache.items()}  # everything is now out of date
    stale = client.get("/api/markets/history/AAPL?range=6mo").json()
    assert stale["stale"] is True and len(stale["candles"]) == 4  # last known data, marked as such
    r = client.get("/api/markets/history/MSFT")
    assert r.status_code == 400 and "turning away automated requests" in r.json()["detail"] and "TradingView" in r.json()["detail"]
    calls = len(yahoo.calls)
    client.get("/api/markets/history/MSFT?range=1mo")
    assert len(yahoo.calls) == calls  # once refused, NEXUS stops asking for two minutes instead of hammering the service
    st.markets._refused_until = 0
    client.get("/api/markets/history/MSFT?range=1mo")
    assert len(yahoo.calls) - calls == 2  # and when it does ask again: one try plus one polite retry, no more
    # A symbol can still be added (so it can be charted with TradingView), just without a price.
    added = client.post("/api/markets/watchlist", json={"symbol": "infy.ns"}).json()
    assert added["symbol"] == "INFY.NS" and added["price"] is None
    ov = client.get("/api/markets").json()
    assert [w["symbol"] for w in ov["watchlist"]] == ["INFY.NS"] and "error" in ov["watchlist"][0]["quote"]
    assert client.post("/api/markets/watchlist", json={"symbol": "not a symbol"}).status_code == 400


def test_tradingview_frame_is_locked_down(client):
    r = client.get("/api/tradingview?symbol=nse:infy&interval=60&tz=Asia/Kolkata", headers={"Authorization": ""})
    assert r.status_code == 200  # a frame can't send the API token, so this page is public — and holds nothing private
    assert '"symbol": "NSE:INFY"' in r.text and '"interval": "60"' in r.text and '"timezone": "Asia/Kolkata"' in r.text
    assert "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" in r.text
    csp = r.headers["content-security-policy"]
    assert "default-src 'none'" in csp and "script-src https://s3.tradingview.com;" in csp and "'unsafe-inline'" not in csp.split("script-src")[1].split(";")[0]
    for bad in ("</script><script>alert(1)</script>", "A\"B", "A B", ""):
        assert client.get("/api/tradingview", params={"symbol": bad}).status_code in (400, 422)
    odd = client.get("/api/tradingview?symbol=AAPL&interval=evil&tz=<x>").text
    assert '"interval": "D"' in odd and '"timezone": "Etc/UTC"' in odd and "<x>" not in odd
    assert client.patch("/api/settings", json={"values": {"markets.chart": "tradingview"}}).status_code == 200
    assert client.patch("/api/settings", json={"values": {"markets.chart": "other"}}).status_code == 400
    assert client.get("/api/bootstrap").json()["markets"]["chart"] == "tradingview"


def test_core_reports_its_build_and_can_be_asked_to_stop(client, st, monkeypatch):
    import os
    import signal

    health = client.get("/health", headers={"Authorization": ""}).json()
    assert "build" in health and health["build"] == client.get("/api/bootstrap").json()["build"]
    killed = []
    monkeypatch.setattr(os, "kill", lambda pid, sig: killed.append((pid, sig)))
    assert client.post("/api/system/shutdown").json() == {"stopping": True}
    import time

    for _ in range(40):
        if killed:
            break
        time.sleep(0.05)
    assert killed == [(os.getpid(), signal.SIGTERM)]
    # A paired phone can't stop the Mac's service.
    client.patch("/api/devices/remote", json={"enabled": True, "hostnames": ["mac.tail1.ts.net"]})
    code = client.post("/api/devices/pair").json()["code"]
    tok = client.post("/api/devices/claim", json={"code": code}).json()["token"]
    assert client.post("/api/system/shutdown", headers={"Authorization": f"Bearer {tok}", "Host": "mac.tail1.ts.net"}).status_code == 403

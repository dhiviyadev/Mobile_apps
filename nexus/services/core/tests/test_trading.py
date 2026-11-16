"""Trade ideas (analysis + back-test) and real-money orders through a faked Zerodha."""

import hashlib
import json
import math
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from conftest import arun, wait_task

from nexus_core.brokers import zerodha
from nexus_core.markets import analysis as ta

DAY = 86400


def series(closes, vol=1_000_000.0):
    out = []
    for i, c in enumerate(closes):
        prev = closes[i - 1] if i else c
        out.append({"t": 1_600_000_000 + i * DAY, "o": prev, "h": max(prev, c) * 1.004, "l": min(prev, c) * 0.996, "c": c, "v": vol})
    return out


def trend(n=400, start=100.0, drift=0.002, wobble=0.012):
    return [start * (1 + drift) ** i * (1 + wobble * math.sin(i / 4)) for i in range(n)]


# -- indicators -------------------------------------------------------------------------
def test_indicators_match_known_values():
    assert ta.sma([1, 2, 3, 4, 5], 3) == [None, None, 2, 3, 4]
    e = ta.ema([1, 2, 3, 4, 5, 6], 3)
    assert e[:2] == [None, None] and e[2] == 2 and e[3] == 3 and e[5] == 5  # EMA of a straight line is the line, lagged
    wilder = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03]
    r = ta.rsi(wilder, 14)
    assert r[13] is None and abs(r[14] - 70.46) < 0.2 and abs(r[15] - 66.25) < 0.2  # Wilder's published example
    a = ta.atr(series([10.0] * 30), 14)
    assert a[13] is None and abs(a[14] - 10 * 0.008) < 1e-9  # constant range → ATR equals that range
    line, signal, hist = ta.macd(trend(120, drift=0.004, wobble=0))
    assert line[24] is None and line[25] is not None and hist[33] is not None and line[-1] > 0  # steady rise → positive MACD


def test_view_follows_the_trend_and_levels_make_sense():
    up = ta.analyse(series(trend()))
    assert up["bias"] == "long" and up["score"] >= 30 and up["verdict"].startswith("Leaning long")
    lv = up["levels"]
    assert lv["stop"] < lv["entry"] < lv["target1"] < lv["target2"]
    assert abs((lv["target2"] - lv["entry"]) - 2 * (lv["entry"] - lv["stop"])) < 0.01  # second target is 2× the risk
    assert 0 < lv["risk_percent"] < 15 and any("50-day average" in r["text"] for r in up["reasons"])

    down = ta.analyse(series(trend(drift=-0.002)))
    assert down["bias"] == "short" and down["score"] <= -30
    lv = down["levels"]
    assert lv["stop"] > lv["entry"] > lv["target1"] > lv["target2"]

    flat = ta.analyse(series([100 + math.sin(i / 3) for i in range(400)]))
    assert flat["bias"] == "neutral" and flat["levels"] is None and "stay out" in flat["verdict"]
    assert up["confidence"] in ("low", "medium") and flat["confidence"] == "low"  # never "high"
    with pytest.raises(ValueError, match="Not enough price history"):
        ta.analyse(series([100.0] * 30))


def test_backtest_is_causal_and_reports_honestly():
    candles = series(trend(600))
    s = ta.Series(candles)
    full = ta.backtest(s)
    assert full["trades"] >= 1 and full["wins"] <= full["trades"] and "No costs" in full["assumptions"]
    assert full["long_trades"] + full["short_trades"] == full["trades"] and full["buy_and_hold_percent"] > 0
    # Causality: the score at bar 300 must not change when later bars are removed (no peeking at the future).
    assert ta.score_at(s, 300)[0] == ta.score_at(ta.Series(candles[:301]), 300)[0]
    # A choppy market that whipsaws these rules must be reported as a loser, not dressed up.
    chop = [100 + 6 * math.sin(i / 9) + (3 if i % 2 else -3) for i in range(700)]
    bad = ta.backtest(ta.Series(series(chop)))
    if bad["trades"] >= 10 and bad["total_r"] <= 0:
        assert "LOST money" in bad["verdict"]
    assert ta.backtest(ta.Series(series(trend(120))))["verdict"].startswith("Too few")


# -- analysis through the API and the Market Analyst --------------------------------------
class TrendYahoo:
    def __call__(self, request: httpx.Request) -> httpx.Response:
        sym = request.url.path.rsplit("/", 1)[-1].upper()
        closes = trend(520, drift=-0.002 if sym == "DOWN" else 0.002)
        c = series(closes)
        return httpx.Response(200, json={"chart": {"error": None, "result": [{
            "meta": {"currency": "INR" if sym.endswith(".NS") else "USD", "symbol": sym, "regularMarketPrice": closes[-1], "chartPreviousClose": closes[-2], "longName": sym},
            "timestamp": [x["t"] for x in c],
            "indicators": {"quote": [{k2: [x[k] for x in c] for k, k2 in (("o", "open"), ("h", "high"), ("l", "low"), ("c", "close"), ("v", "volume"))}]}}]}})


@pytest.fixture
def market(client, st):
    st.web.transport = httpx.MockTransport(TrendYahoo())

    async def resolver(host, port):
        return ["93.184.216.34"]

    st.web.resolver = resolver
    client.patch("/api/settings", json={"values": {"markets.enabled": True}})


def test_analysis_and_scan_endpoints(client, market):
    a = client.get("/api/markets/analysis/UP").json()
    assert a["bias"] == "long" and a["levels"]["entry"] == round(a["price"], 4) and a["backtest"]["trades"] >= 1 and len(a["caveats"]) == 3
    for s in ("UP", "DOWN"):
        client.post("/api/markets/watchlist", json={"symbol": s})
    scan = client.get("/api/markets/scan").json()
    assert [r["symbol"] for r in scan] == ["UP", "DOWN"] and scan[0]["bias"] == "long" and scan[1]["bias"] == "short"
    client.patch("/api/settings", json={"values": {"markets.enabled": False}})
    assert client.get("/api/markets/scan").status_code == 400


def test_market_analyst_gets_real_numbers_and_has_no_order_tool(client, st, market, fake_ollama):
    trader = st.agents.get("trader")
    assert trader["name"] == "Market Analyst" and "market_analysis" in trader["tools"]
    assert "never invent" in trader["system_prompt"] and "cannot place orders" in trader["system_prompt"]
    from nexus_core.agents.tools import TOOLS

    assert not any(w in name for name in TOOLS for w in ("order", "trade", "buy", "sell", "broker"))
    fake_ollama.script({"tool_calls": [{"function": {"name": "market_analysis", "arguments": {"symbol": "UP"}}}]},
                       {"content": "**View:** Go long."})
    t = wait_task(client, client.post("/api/agents/trader/tasks", json={"prompt": "Should I buy UP?", "runtime": "native"}).json()["id"])
    assert t["status"] == "completed"
    tool = json.loads([m for m in [r for r in fake_ollama.requests if r["path"] == "/api/chat"][-1]["body"]["messages"] if m["role"] == "tool"][0]["content"])
    assert tool["bias"] == "long" and tool["levels"]["stop"] < tool["levels"]["entry"] and "recent" not in tool["backtest"]


# -- real-money orders (Zerodha is faked at the HTTP layer) ---------------------------------
class FakeKeychain:
    available = True

    def __init__(self):
        self.items = {}

    def get(self, account):
        return self.items.get(account)

    def has(self, account):
        return account in self.items

    def set(self, account, secret):
        self.items[account] = secret
        return True

    def delete(self, account):
        self.items.pop(account, None)
        return True


class FakeZerodha:
    def __init__(self):
        self.orders = []
        self.requests = []
        self.reject = None
        self.expired = False
        self.quotes = True

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        ok = lambda data: httpx.Response(200, json={"status": "success", "data": data})  # noqa: E731
        assert request.headers["x-kite-version"] == "3"
        if path == "/session/token" and request.method == "POST":
            want = hashlib.sha256(b"key123" + form["request_token"].encode() + b"secret456").hexdigest()
            if form.get("checksum") != want or form.get("api_key") != "key123":
                return httpx.Response(403, json={"status": "error", "message": "Invalid checksum", "error_type": "TokenException"})
            return ok({"access_token": "tok789", "user_id": "AB1234", "user_shortname": "Asha"})
        if self.expired or request.headers.get("authorization") != "token key123:tok789":
            return httpx.Response(403, json={"status": "error", "message": "Incorrect api_key or access_token", "error_type": "TokenException"})
        if path == "/user/profile":
            return ok({"user_id": "AB1234", "user_shortname": "Asha", "exchanges": ["NSE", "BSE", "NFO"]})
        if path == "/user/margins":
            return ok({"equity": {"net": 50000.5, "available": {"cash": 50000.5, "live_balance": 48000.0}}})
        if path == "/portfolio/holdings":
            return ok([{"tradingsymbol": "INFY", "exchange": "NSE", "quantity": 10, "t1_quantity": 2, "average_price": 1400.0, "last_price": 1500.0, "pnl": 1200.0, "day_change_percentage": 0.8}])
        if path == "/portfolio/positions":
            return ok({"net": [{"tradingsymbol": "SBIN", "exchange": "NSE", "product": "MIS", "quantity": -5, "average_price": 800.0, "last_price": 795.0, "pnl": 25.0},
                               {"tradingsymbol": "TCS", "exchange": "NSE", "product": "MIS", "quantity": 0}], "day": []})
        if path == "/mf/holdings":
            return ok([{"fund": "Index Fund", "tradingsymbol": "INF000X01", "quantity": 12.5, "average_price": 100.0, "last_price": 110.0, "pnl": 125.0}])
        if path == "/quote/ltp":
            if not self.quotes:
                return httpx.Response(403, json={"status": "error", "message": "Insufficient permission for that call.", "error_type": "PermissionException"})
            return ok({i: {"instrument_token": 1, "last_price": 1500.0} for i in request.url.params.get_list("i")})
        if path == "/orders" and request.method == "GET":
            return ok(self.orders)
        if path.startswith("/orders/") and request.method == "POST":
            if self.reject:
                return httpx.Response(400, json={"status": "error", "message": self.reject, "error_type": "InputException"})
            oid = f"2611160000{len(self.orders) + 1:04d}"
            self.orders.append({"order_id": oid, "variety": path.rsplit("/", 1)[-1], "status": "OPEN", **form})
            return ok({"order_id": oid})
        if path.startswith("/orders/") and request.method == "DELETE":
            return ok({"order_id": path.rsplit("/", 1)[-1]})
        if path == "/session/token" and request.method == "DELETE":
            return ok(True)
        return httpx.Response(404, json={"status": "error", "message": "not found", "error_type": "GeneralException"})


ORDER = {"exchange": "nse", "tradingsymbol": "infy", "transaction_type": "buy", "quantity": 5, "product": "CNC", "order_type": "LIMIT", "price": 1490.5}


@pytest.fixture
def kite(client, st):
    fake = FakeZerodha()
    st.keychain = FakeKeychain()
    st.broker.transport = httpx.MockTransport(fake)
    return fake


def connect(client, st, live=True):
    st.keychain.set("broker.zerodha.api_key", "key123")
    st.keychain.set("broker.zerodha.api_secret", "secret456")
    url = client.post("/api/broker/zerodha/login").json()["url"]
    q = parse_qs(urlsplit(url).query)
    assert url.startswith("https://kite.zerodha.com/connect/login?") and q["api_key"] == ["key123"] and q["v"] == ["3"]
    state = parse_qs(q["redirect_params"][0])["state"][0]
    r = client.get(f"/api/broker/zerodha/callback?request_token=reqtok111&action=login&status=success&state={state}", headers={"Authorization": ""})
    assert r.status_code == 200 and "Zerodha is connected" in r.text and "Asha" in r.text
    if live:
        client.patch("/api/settings", json={"values": {"trading.live_enabled": True}})
    return state


def test_login_flow_checksum_and_state(client, st, kite):
    assert zerodha.checksum("a", "b", "c") == hashlib.sha256(b"abc").hexdigest()
    s = client.get("/api/broker").json()
    assert s["configured"] is False and s["connected"] is False and s["live_enabled"] is False
    assert s["redirect_url"].endswith("/api/broker/zerodha/callback") and [b["id"] for b in s["brokers"]] == ["zerodha", "zerodha-coin"]
    assert client.post("/api/broker/zerodha/login").status_code == 400  # no keys yet
    state = connect(client, st, live=False)
    # The callback only works once, only for a login NEXUS started, and only with a plausible code.
    assert client.get(f"/api/broker/zerodha/callback?request_token=reqtok111&state={state}").status_code == 400
    assert client.get("/api/broker/zerodha/callback?request_token=reqtok111&state=made-up").status_code == 400
    assert client.get("/api/broker/zerodha/callback?status=cancelled").status_code == 400
    s = client.get("/api/broker").json()
    assert s["connected"] is True and s["user"] == {"name": "Asha", "id": "AB1234", "exchanges": ["NSE", "BSE", "NFO"]}
    assert st.keychain.get("broker.zerodha.access_token") == "tok789"
    # Secrets never appear in API answers or the audit log.
    blob = client.get("/api/broker").text + client.get("/api/audit").text + client.get("/api/settings").text
    assert not any(x in blob for x in ("key123", "secret456", "tok789", "reqtok111"))
    acct = client.get("/api/broker/account").json()
    assert acct["funds"] == {"net": 50000.5, "cash": 48000.0} and acct["holdings"][0]["quantity"] == 12 and acct["holdings_value"] == 18000.0
    assert [p["tradingsymbol"] for p in acct["positions"]] == ["SBIN"] and acct["mutual_funds"][0]["fund"] == "Index Fund"
    kite.expired = True
    st.broker._profile = None
    assert "ended" in client.get("/api/broker").json()["session_note"]
    assert "Log in again" in client.get("/api/broker/account").json()["detail"]
    kite.expired = False
    client.post("/api/broker/disconnect", json={"forget_keys": True})
    assert st.keychain.items == {} and client.get("/api/broker").json()["configured"] is False


def test_real_order_needs_switch_review_and_matching_code(client, st, kite):
    connect(client, st, live=False)
    r = client.post("/api/broker/orders/preview", json=ORDER)
    assert r.status_code == 400 and "switched off" in r.json()["detail"]  # real trading is off by default
    client.patch("/api/settings", json={"values": {"trading.live_enabled": True}})

    pv = client.post("/api/broker/orders/preview", json=ORDER).json()
    assert pv["order"] == {"exchange": "NSE", "tradingsymbol": "INFY", "transaction_type": "BUY", "quantity": 5, "product": "CNC",
                           "order_type": "LIMIT", "variety": "regular", "validity": "DAY", "price": 1490.5, "trigger_price": None}
    assert pv["estimated_value"] == 7452.5 and pv["real_money"] is True and pv["price_source"] == "your limit price"
    placed_before = [q for q in kite.requests if q.method == "POST" and q.url.path.startswith("/orders/")]
    assert placed_before == []  # a preview never sends anything to the order endpoint

    # No code, a made-up code, or a code for a different order: refused.
    assert client.post("/api/broker/orders", json={**ORDER, "confirm_code": "x"}).status_code == 400
    r = client.post("/api/broker/orders", json={**ORDER, "quantity": 500, "confirm_code": pv["confirm_code"]})
    assert r.status_code == 400 and "isn't the order you reviewed" in r.json()["detail"]
    assert kite.orders == []

    done = client.post("/api/broker/orders", json={**ORDER, "confirm_code": pv["confirm_code"]}).json()
    assert done["order_id"] == "26111600000001" and "not “filled”" in done["note"]
    sent = kite.orders[0]
    assert sent["tradingsymbol"] == "INFY" and sent["quantity"] == "5" and sent["price"] == "1490.5" and sent["product"] == "CNC"
    assert sent["tag"] == "nexus" and sent["variety"] == "regular" and "market_protection" not in sent
    # The same review can't be used twice (no accidental double order).
    r = client.post("/api/broker/orders", json={**ORDER, "confirm_code": pv["confirm_code"]})
    assert r.status_code == 400 and "already sent" in r.json()["detail"] and len(kite.orders) == 1
    hist = client.get("/api/broker/history").json()
    assert hist[0]["status"] == "placed" and hist[0]["broker_order_id"] == "26111600000001" and hist[0]["estimated_value"] == 7452.5
    audit = [a for a in client.get("/api/audit").json() if a["action"] == "broker.order"]
    assert audit[0]["decision"] == "executed"
    assert client.get("/api/notifications").json()[0]["title"] == "Real order sent to Zerodha"
    assert client.delete("/api/broker/orders/26111600000001").json() == {"cancelled": "26111600000001"}


def test_market_orders_carry_protection_and_warnings(client, st, kite):
    connect(client, st)
    mkt = {**ORDER, "order_type": "MARKET", "price": None, "transaction_type": "SELL", "product": "MIS"}
    pv = client.post("/api/broker/orders/preview", json=mkt).json()
    assert pv["estimated_price"] == 1500.0 and pv["price_source"] == "Zerodha's last traded price"
    assert any("Market orders fill" in w for w in pv["warnings"]) and any("intraday" in w for w in pv["warnings"])
    client.post("/api/broker/orders", json={**mkt, "confirm_code": pv["confirm_code"]})
    assert kite.orders[-1]["market_protection"] == "-1" and "price" not in kite.orders[-1]
    cnc_sell = client.post("/api/broker/orders/preview", json={**ORDER, "transaction_type": "SELL"}).json()
    assert any("only works for shares you already hold" in w for w in cnc_sell["warnings"])
    fut = client.post("/api/broker/orders/preview", json={"exchange": "NFO", "tradingsymbol": "NIFTY26DECFUT", "transaction_type": "BUY",
                                                         "quantity": 75, "product": "NRML", "order_type": "LIMIT", "price": 100}).json()
    assert any("leveraged" in w for w in fut["warnings"])
    # Free plan: no Zerodha quotes and no public price → the order can't be valued, so the limit can't be checked → refused.
    kite.quotes = False
    r = client.post("/api/broker/orders/preview", json=mkt)
    assert r.status_code == 400 and "can't work out what this order is worth" in r.json()["detail"]


def test_guard_rails(client, st, kite):
    connect(client, st)
    bad = [({"exchange": "NYSE"}, "Exchange"), ({"tradingsymbol": "IN FY"}, "symbol"), ({"transaction_type": "HOLD"}, "Buy or Sell"),
           ({"quantity": 0}, "between 1"), ({"quantity": 2.5}, "whole number"), ({"product": "NRML"}, "futures and options"),
           ({"order_type": "LIMIT", "price": None}, "needs a price"), ({"order_type": "SL", "price": 10}, "trigger price"),
           ({"variety": "iceberg"}, "regular or amo"), ({"price": -5}, "above zero")]
    for patch, text in bad:
        r = client.post("/api/broker/orders/preview", json={**ORDER, **patch})
        assert r.status_code == 400 and text in r.json()["detail"], (patch, r.json())
    # Per-order value limit (default ₹25,000).
    r = client.post("/api/broker/orders/preview", json={**ORDER, "quantity": 100})
    assert r.status_code == 400 and "above your limit of ₹25,000" in r.json()["detail"]
    # Daily order limit.
    client.patch("/api/settings", json={"values": {"trading.max_orders_per_day": 1}})
    pv = client.post("/api/broker/orders/preview", json=ORDER).json()
    assert client.post("/api/broker/orders", json={**ORDER, "confirm_code": pv["confirm_code"]}).status_code == 200
    r = client.post("/api/broker/orders/preview", json=ORDER)
    assert r.status_code == 400 and "limit of 1 real orders today" in r.json()["detail"]
    assert client.patch("/api/settings", json={"values": {"trading.max_order_value": -1}}).status_code == 400
    # The limit is re-checked when placing, so lowering it after a review still protects you.
    client.patch("/api/settings", json={"values": {"trading.max_orders_per_day": 0, "trading.max_order_value": 25000}})
    pv = client.post("/api/broker/orders/preview", json=ORDER).json()
    client.patch("/api/settings", json={"values": {"trading.max_order_value": 1000}})
    assert client.post("/api/broker/orders", json={**ORDER, "confirm_code": pv["confirm_code"]}).status_code == 400
    client.patch("/api/settings", json={"values": {"trading.max_order_value": 25000}})
    # Emergency stop blocks real orders.
    pv = client.post("/api/broker/orders/preview", json=ORDER).json()
    client.post("/api/system/emergency-stop")
    r = client.post("/api/broker/orders", json={**ORDER, "confirm_code": pv["confirm_code"]})
    assert r.status_code == 403, r.json()
    assert client.post("/api/broker/orders/preview", json=ORDER).status_code == 403
    assert len(kite.orders) == 1


def test_broker_rejection_is_recorded_and_explained(client, st, kite):
    connect(client, st)
    pv = client.post("/api/broker/orders/preview", json=ORDER).json()
    kite.reject = "Order placement is allowed only from registered static IP"
    r = client.post("/api/broker/orders", json={**ORDER, "confirm_code": pv["confirm_code"]})
    assert r.status_code == 400 and "did not accept the order" in r.json()["detail"] and "static IP address registered" in r.json()["detail"]
    assert client.get("/api/broker/history").json()[0]["status"] == "failed" and kite.orders == []
    assert [a for a in client.get("/api/audit").json() if a["action"] == "broker.order"][0]["decision"] == "failed"
    # A failed attempt burns its review too: nothing can be re-sent without looking at it again.
    kite.reject = None
    assert client.post("/api/broker/orders", json={**ORDER, "confirm_code": pv["confirm_code"]}).status_code == 400


def test_confirmation_expires(client, st, kite, monkeypatch):
    connect(client, st)
    pv = client.post("/api/broker/orders/preview", json=ORDER).json()
    import nexus_core.brokers.service as svc

    real = svc.time.time
    monkeypatch.setattr(svc.time, "time", lambda: real() + 121)
    r = client.post("/api/broker/orders", json={**ORDER, "confirm_code": pv["confirm_code"]})
    assert r.status_code == 400 and "expired" in r.json()["detail"] and kite.orders == []


def test_phones_and_agents_cannot_touch_the_broker(client, st, kite):
    connect(client, st)
    client.patch("/api/devices/remote", json={"enabled": True, "hostnames": ["mac.tail1.ts.net"]})
    code = client.post("/api/devices/pair").json()["code"]
    tok = client.post("/api/devices/claim", json={"code": code}).json()["token"]
    h = {"Authorization": f"Bearer {tok}", "Host": "mac.tail1.ts.net"}
    for method, path in (("GET", "/api/broker"), ("GET", "/api/broker/account"), ("POST", "/api/broker/orders/preview"),
                         ("POST", "/api/broker/orders"), ("POST", "/api/broker/zerodha/login"), ("DELETE", "/api/broker/orders/1234")):
        assert client.request(method, path, json=ORDER, headers=h).status_code == 403, path
    assert client.patch("/api/settings", json={"values": {"trading.live_enabled": True}}, headers=h).status_code == 403
    assert client.post("/api/secrets", json={"account": "broker.zerodha.api_key", "value": "x"}, headers=h).status_code == 403
    # No module that agents or automations use refers to the broker at all.
    import pathlib

    import nexus_core

    root = pathlib.Path(nexus_core.__file__).parent
    for folder in ("agents", "automations"):
        for f in (root / folder).glob("*.py"):
            assert "broker" not in f.read_text().lower(), f

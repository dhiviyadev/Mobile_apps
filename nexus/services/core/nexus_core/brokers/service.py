"""Real-money trading through a broker (Zerodha Kite Connect).

Rules this module enforces — they are the point of it:
  1. A person places every order. There is no agent tool that reaches this code, automations cannot
     call it, and paired phones are refused at the API layer.
  2. Two steps, always: `preview` checks the order and returns a one-time confirmation code bound to
     exactly that order; `place` only accepts that code, within two minutes, once.
  3. Guard rails apply to every order: real trading must be switched on, the emergency stop blocks it,
     and there is a maximum value per order and a maximum number of orders per day.
  4. Credentials live in the macOS Keychain. Nothing here logs a key, secret or token.
  5. Every attempt — placed, refused or failed — is written to the audit log and to `broker_orders`.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from datetime import datetime
from typing import TYPE_CHECKING, Any

import httpx

from ..util import new_id, now_iso
from . import zerodha
from .zerodha import KiteClient, KiteError

if TYPE_CHECKING:
    from ..app_state import AppState

log = logging.getLogger(__name__)

K_KEY, K_SECRET, K_TOKEN = "broker.zerodha.api_key", "broker.zerodha.api_secret", "broker.zerodha.access_token"
CONFIRM_TTL_S = 120
LOGIN_TTL_S = 600
_SYMBOL = re.compile(r"^[A-Z0-9][A-Z0-9&\-_.]{0,39}$")

BROKERS = [
    {"id": "zerodha", "name": "Zerodha Kite", "what": "Shares, ETFs and derivatives on NSE, BSE and MCX", "trading": True},
    {"id": "zerodha-coin", "name": "Zerodha Coin", "what": "Mutual funds — holdings are shown; orders are placed in Coin itself", "trading": False},
]


class BrokerError(Exception):
    pass


class BrokerService:
    def __init__(self, state: "AppState"):
        self.state = state
        self.transport: httpx.AsyncBaseTransport | None = None  # tests inject a fake Zerodha here
        self._hmac_key = secrets.token_bytes(32)  # per run: confirmation codes die with the process
        self._used: dict[str, float] = {}
        self._login_states: dict[str, float] = {}
        self._profile: dict[str, Any] | None = None

    # -- configuration ------------------------------------------------------------
    def _kc(self, account: str) -> str | None:
        return self.state.keychain.get(account)

    def _client(self, need_token: bool = True) -> KiteClient:
        key = self._kc(K_KEY)
        if not key:
            raise BrokerError("Add your Zerodha API key and secret first (Settings → Brokers).")
        token = self._kc(K_TOKEN)
        if need_token and not token:
            raise BrokerError("Log in to Zerodha first (Settings → Brokers). Zerodha ends every session at 6 AM, so this is needed once a day.")
        return KiteClient(key, token, transport=self.transport)

    def limits(self) -> dict[str, Any]:
        p = self.state.prefs
        return {"live_enabled": bool(p.get("trading.live_enabled")), "max_order_value": float(p.get("trading.max_order_value") or 0),
                "max_orders_per_day": int(p.get("trading.max_orders_per_day") or 0), "orders_today": self.orders_today()}

    def orders_today(self) -> int:
        today = datetime.now().astimezone().date().isoformat()
        row = self.state.db.query_one("SELECT COUNT(*) AS n FROM broker_orders WHERE status = 'placed' AND substr(created_at, 1, 10) = ?", (today,))
        return int((row or {"n": 0})["n"])

    async def status(self) -> dict[str, Any]:
        has_keys = bool(self._kc(K_KEY) and self._kc(K_SECRET))
        out: dict[str, Any] = {"brokers": BROKERS, "broker": "zerodha", "keychain_available": self.state.keychain.available,
                               "configured": has_keys, "connected": False, "user": None, "session_note": None,
                               "redirect_url": f"http://127.0.0.1:{self.state.settings.port}/api/broker/zerodha/callback",
                               **self.limits()}
        if has_keys and self._kc(K_TOKEN):
            try:
                if self._profile is None:
                    self._profile = await self._client().profile()
                out["connected"] = True
                out["user"] = {"name": self._profile.get("user_shortname") or self._profile.get("user_name"),
                               "id": self._profile.get("user_id"), "exchanges": self._profile.get("exchanges") or []}
            except KiteError as exc:
                self._profile = None
                out["session_note"] = ("Your Zerodha session has ended (it does every morning at 6 AM). Log in again."
                                       if exc.session_expired else str(exc))
        return out

    # -- login --------------------------------------------------------------------
    def begin_login(self) -> str:
        key = self._kc(K_KEY)
        if not key or not self._kc(K_SECRET):
            raise BrokerError("Add your Zerodha API key and secret first.")
        now = time.time()
        self._login_states = {s: t for s, t in self._login_states.items() if now - t < LOGIN_TTL_S}
        state = secrets.token_urlsafe(24)
        self._login_states[state] = now
        self.state.audit.record("user", "broker.login_started", "zerodha", "started")
        return zerodha.login_url(key, state)

    async def complete_login(self, request_token: str, state: str) -> dict[str, Any]:
        started = self._login_states.pop(state, None)
        if started is None or time.time() - started > LOGIN_TTL_S:
            raise BrokerError("This login link wasn't started from NEXUS or has expired. Start again from Settings → Brokers.")
        if not re.fullmatch(r"[A-Za-z0-9]{6,64}", request_token or ""):
            raise BrokerError("Zerodha didn't send a valid login code.")
        client = self._client(need_token=False)
        try:
            data = await client.exchange(self._kc(K_SECRET) or "", request_token)
        except KiteError as exc:
            self.state.audit.record("user", "broker.login", "zerodha", "failed", error=exc.error_type or "error")
            raise BrokerError(f"Zerodha refused the login: {exc}") from exc
        if not self.state.keychain.set(K_TOKEN, data["access_token"]):
            raise BrokerError("Couldn't save the Zerodha session in the Keychain.")
        self._profile = None
        self.state.audit.record("user", "broker.login", "zerodha", "granted", user=data.get("user_id"))
        self.state.bus.publish("broker.changed", {"what": "session"})
        return {"connected": True, "user": data.get("user_shortname") or data.get("user_name") or data.get("user_id")}

    async def disconnect(self, forget_keys: bool = False) -> None:
        try:
            if self._kc(K_TOKEN):
                await self._client().logout()
        except (KiteError, BrokerError):
            pass  # the session may already be gone; forgetting it locally is what matters
        self.state.keychain.delete(K_TOKEN)
        if forget_keys:
            self.state.keychain.delete(K_KEY)
            self.state.keychain.delete(K_SECRET)
        self._profile = None
        self.state.audit.record("user", "broker.disconnect", "zerodha", "revoked", forgot_keys=forget_keys)
        self.state.bus.publish("broker.changed", {"what": "session"})

    async def _guard(self, coro: Any) -> Any:
        try:
            return await coro
        except KiteError as exc:
            if exc.session_expired:
                self._profile = None
                raise BrokerError("Your Zerodha session has ended. Log in again in Settings → Brokers.") from exc
            raise BrokerError(str(exc)) from exc

    # -- account ------------------------------------------------------------------
    async def account(self) -> dict[str, Any]:
        c = self._client()
        margins = await self._guard(c.margins())
        holdings = await self._guard(c.holdings())
        positions = await self._guard(c.positions())
        orders = await self._guard(c.orders())
        funds: list[dict[str, Any]] = []
        try:
            funds = await c.mf_holdings()
        except KiteError:
            funds = []  # Coin holdings are a bonus; never fail the page over them
        eq = (margins.get("equity") or {}) if isinstance(margins, dict) else {}
        available = eq.get("available") or {}
        hold = [{"tradingsymbol": h.get("tradingsymbol"), "exchange": h.get("exchange"),
                 "quantity": (h.get("quantity") or 0) + (h.get("t1_quantity") or 0), "average_price": h.get("average_price"),
                 "last_price": h.get("last_price"), "pnl": h.get("pnl"), "day_change_percentage": h.get("day_change_percentage")}
                for h in holdings if isinstance(h, dict)]
        net = positions.get("net") if isinstance(positions, dict) else []
        pos = [{"tradingsymbol": p.get("tradingsymbol"), "exchange": p.get("exchange"), "product": p.get("product"),
                "quantity": p.get("quantity"), "average_price": p.get("average_price"), "last_price": p.get("last_price"), "pnl": p.get("pnl")}
               for p in (net or []) if isinstance(p, dict) and p.get("quantity")]
        ords = [{"order_id": o.get("order_id"), "variety": o.get("variety"), "status": o.get("status"), "status_message": o.get("status_message"),
                 "tradingsymbol": o.get("tradingsymbol"), "exchange": o.get("exchange"), "transaction_type": o.get("transaction_type"),
                 "quantity": o.get("quantity"), "filled_quantity": o.get("filled_quantity"), "price": o.get("price"),
                 "average_price": o.get("average_price"), "product": o.get("product"), "order_type": o.get("order_type"),
                 "order_timestamp": o.get("order_timestamp")} for o in orders if isinstance(o, dict)]
        return {"currency": "INR", "funds": {"net": eq.get("net"), "cash": available.get("live_balance", available.get("cash"))},
                "holdings": hold, "positions": pos, "orders": list(reversed(ords))[:50],
                "mutual_funds": [{"fund": f.get("fund"), "tradingsymbol": f.get("tradingsymbol"), "quantity": f.get("quantity"),
                                  "average_price": f.get("average_price"), "last_price": f.get("last_price"), "pnl": f.get("pnl")}
                                 for f in funds if isinstance(f, dict)],
                "holdings_value": sum((h["quantity"] or 0) * (h["last_price"] or 0) for h in hold),
                "holdings_pnl": sum(h["pnl"] or 0 for h in hold)}

    # -- orders -------------------------------------------------------------------
    def normalise(self, o: dict[str, Any]) -> dict[str, Any]:
        """Validate an order and return it in Zerodha's own vocabulary. Raises BrokerError with a plain message."""
        ex = str(o.get("exchange") or "").upper().strip()
        sym = str(o.get("tradingsymbol") or "").upper().strip()
        side = str(o.get("transaction_type") or "").upper().strip()
        product = str(o.get("product") or "").upper().strip()
        otype = str(o.get("order_type") or "").upper().strip()
        variety = str(o.get("variety") or "regular").lower().strip()
        validity = str(o.get("validity") or "DAY").upper().strip()
        if ex not in zerodha.EXCHANGES:
            raise BrokerError(f"Exchange must be one of {', '.join(zerodha.EXCHANGES)}.")
        if not _SYMBOL.match(sym):
            raise BrokerError("Enter the symbol as Zerodha writes it, for example INFY or NIFTY26DECFUT.")
        if side not in ("BUY", "SELL"):
            raise BrokerError("Choose Buy or Sell.")
        if product not in zerodha.PRODUCTS:
            raise BrokerError(f"Product must be one of {', '.join(zerodha.PRODUCTS)}.")
        if otype not in zerodha.ORDER_TYPES:
            raise BrokerError(f"Order type must be one of {', '.join(zerodha.ORDER_TYPES)}.")
        if variety not in zerodha.VARIETIES:
            raise BrokerError("Order variety must be regular or amo (after-market).")
        if validity not in zerodha.VALIDITIES:
            raise BrokerError("Validity must be DAY or IOC.")
        try:
            qty = int(o.get("quantity"))
            if qty != float(o.get("quantity")):
                raise ValueError
        except (TypeError, ValueError):
            raise BrokerError("Quantity must be a whole number.") from None
        if not 1 <= qty <= 1_000_000:
            raise BrokerError("Quantity must be between 1 and 1,000,000.")

        def num(name: str) -> float | None:
            v = o.get(name)
            if v in (None, ""):
                return None
            try:
                f = float(v)
            except (TypeError, ValueError):
                raise BrokerError(f"{name.replace('_', ' ').capitalize()} must be a number.") from None
            if not 0 < f < 1e9:
                raise BrokerError(f"{name.replace('_', ' ').capitalize()} must be above zero.")
            return round(f, 4)

        price, trigger = num("price"), num("trigger_price")
        if otype in ("LIMIT", "SL") and price is None:
            raise BrokerError("A limit order needs a price.")
        if otype in ("SL", "SL-M") and trigger is None:
            raise BrokerError("A stop-loss order needs a trigger price.")
        if otype == "MARKET":
            price = None
        if otype in ("MARKET", "LIMIT"):
            trigger = None
        if otype == "SL-M":
            price = None
        if ex in ("NSE", "BSE") and product == "NRML":
            raise BrokerError("NRML is for futures and options. Use CNC (delivery) or MIS (intraday) for shares.")
        if ex in ("NFO", "BFO", "MCX", "CDS", "BCD") and product in ("CNC", "MTF"):
            raise BrokerError("Use NRML (carry forward) or MIS (intraday) for futures and options.")
        return {"exchange": ex, "tradingsymbol": sym, "transaction_type": side, "quantity": qty, "product": product,
                "order_type": otype, "variety": variety, "validity": validity, "price": price, "trigger_price": trigger}

    def _sign(self, order: dict[str, Any], expires: int, nonce: str) -> str:
        """A confirmation code bound to exactly this order, this expiry and a random nonce (so every review is unique)."""
        blob = json.dumps(order, sort_keys=True, separators=(",", ":")) + f"|{expires}|{nonce}"
        return f"{expires}.{nonce}.{hmac.new(self._hmac_key, blob.encode(), hashlib.sha256).hexdigest()}"

    async def _reference_price(self, order: dict[str, Any]) -> tuple[float | None, str]:
        if order["price"] is not None:
            return order["price"], "your limit price"
        if order["order_type"] == "SL-M" and order["trigger_price"] is not None:
            return order["trigger_price"], "your trigger price"
        inst = f"{order['exchange']}:{order['tradingsymbol']}"
        try:
            prices = await self._client().ltp([inst])
            if inst in prices:
                return prices[inst], "Zerodha's last traded price"
        except (KiteError, BrokerError):
            pass  # the free Personal plan has no quotes; fall back to the public delayed price
        suffix = {"NSE": ".NS", "BSE": ".BO"}.get(order["exchange"])
        if suffix and self.state.markets.enabled:
            try:
                q = await self.state.markets.quote(order["tradingsymbol"] + suffix, fresh=True)
                return float(q["price"]), "NSE's public price, which can lag a few minutes" if suffix == ".NS" else "a delayed public price"
            except Exception:  # noqa: BLE001 - an estimate is optional
                pass
        return None, ""

    def _check_limits(self, value: float | None, order: dict[str, Any]) -> None:
        lim = self.limits()
        self.state.approvals.ensure_not_halted()
        if not lim["live_enabled"]:
            raise BrokerError("Real orders are switched off. Turn on “Allow real orders” in Settings → Brokers.")
        if lim["max_orders_per_day"] and lim["orders_today"] >= lim["max_orders_per_day"]:
            raise BrokerError(f"You've reached your own limit of {lim['max_orders_per_day']} real orders today (Settings → Brokers).")
        if lim["max_order_value"]:
            if value is None:
                raise BrokerError("NEXUS can't work out what this order is worth, so it can't check it against your limit. "
                                  "Use a limit order with a price.")
            if value > lim["max_order_value"]:
                raise BrokerError(f"This order is worth about ₹{value:,.0f}, above your limit of ₹{lim['max_order_value']:,.0f} per order "
                                  "(Settings → Brokers).")

    async def preview(self, raw: dict[str, Any]) -> dict[str, Any]:
        order = self.normalise(raw)
        self._client()  # must be configured and logged in
        price, source = await self._reference_price(order)
        value = round(price * order["quantity"], 2) if price is not None else None
        self._check_limits(value, order)
        warnings: list[str] = []
        if order["order_type"] in ("MARKET", "SL-M"):
            warnings.append("Market orders fill at whatever price is available; in a fast or thin market that can differ from the estimate. "
                            "Zerodha's automatic market protection is applied.")
        if order["exchange"] in ("NFO", "BFO", "MCX", "CDS", "BCD"):
            warnings.append("Futures and options are leveraged: losses can exceed the amount shown, and quantity must be a multiple of the lot size.")
        if order["product"] == "MIS":
            warnings.append("MIS is intraday: Zerodha closes the position automatically before the market closes.")
        if order["product"] == "MTF":
            warnings.append("MTF borrows money from the broker and charges interest.")
        if order["transaction_type"] == "SELL" and order["product"] == "CNC":
            warnings.append("A CNC sell only works for shares you already hold. To short a share, use MIS (intraday) or derivatives.")
        if "public price" in source:
            warnings.append("The estimate uses a public price that can lag by a few minutes, not Zerodha's live price.")
        expires = int(time.time()) + CONFIRM_TTL_S
        return {"order": order, "estimated_price": price, "estimated_value": value, "price_source": source, "warnings": warnings,
                "confirm_code": self._sign(order, expires, secrets.token_hex(8)), "expires_in": CONFIRM_TTL_S, "limits": self.limits(), "real_money": True}

    async def place(self, raw: dict[str, Any], confirm_code: str, actor: str = "user") -> dict[str, Any]:
        order = self.normalise(raw)
        now = time.time()
        self._used = {c: t for c, t in self._used.items() if now - t < CONFIRM_TTL_S * 2}
        parts = str(confirm_code or "").split(".")
        try:
            expires, nonce = int(parts[0]), parts[1]
        except (ValueError, IndexError):
            expires, nonce = 0, ""
        if not confirm_code or not hmac.compare_digest(self._sign(order, expires, nonce), str(confirm_code)):
            raise BrokerError("This isn't the order you reviewed. Review it again before placing.")
        if now > expires:
            raise BrokerError("That review has expired. Review the order again.")
        if confirm_code in self._used:
            raise BrokerError("This order was already sent. Review a new one if you want to place another.")
        price, _ = await self._reference_price(order)
        value = round(price * order["quantity"], 2) if price is not None else None
        self._check_limits(value, order)
        self._used[confirm_code] = now  # burn the code before talking to the broker: never send twice

        fields: dict[str, Any] = {k: order[k] for k in ("exchange", "tradingsymbol", "transaction_type", "quantity", "product", "order_type", "validity")}
        if order["price"] is not None:
            fields["price"] = order["price"]
        if order["trigger_price"] is not None:
            fields["trigger_price"] = order["trigger_price"]
        if order["order_type"] in ("MARKET", "SL-M"):
            fields["market_protection"] = -1
        fields["tag"] = "nexus"
        rid = new_id("bro")
        record = (rid, "zerodha", None, order["exchange"], order["tradingsymbol"], order["transaction_type"], order["quantity"], order["product"],
                  order["order_type"], order["variety"], order["price"], order["trigger_price"], value)
        try:
            order_id = await self._client().place_order(order["variety"], fields)
        except KiteError as exc:
            self.state.db.execute(
                "INSERT INTO broker_orders(id, broker, broker_order_id, exchange, tradingsymbol, transaction_type, quantity, product, order_type, "
                "variety, price, trigger_price, estimated_value, status, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (*record, "failed", str(exc)[:300], now_iso()))
            self.state.audit.record(actor, "broker.order", f"{order['exchange']}:{order['tradingsymbol']}", "failed",
                                    side=order["transaction_type"], quantity=order["quantity"], error=exc.error_type or "error")
            if exc.session_expired:
                self._profile = None
                raise BrokerError("Your Zerodha session has ended. Log in again, then review the order again.") from exc
            hint = (" Since April 2026 Zerodha only accepts API orders from the static IP address registered for your API key."
                    if "ip" in str(exc).lower() else "")
            raise BrokerError(f"Zerodha did not accept the order: {exc}.{hint}") from exc
        self.state.db.execute(
            "INSERT INTO broker_orders(id, broker, broker_order_id, exchange, tradingsymbol, transaction_type, quantity, product, order_type, "
            "variety, price, trigger_price, estimated_value, status, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, "zerodha", order_id, *record[3:], "placed", None, now_iso()))
        self.state.audit.record(actor, "broker.order", f"{order['exchange']}:{order['tradingsymbol']}", "executed", order_id=order_id,
                                side=order["transaction_type"], quantity=order["quantity"], product=order["product"],
                                order_type=order["order_type"], estimated_value=value)
        self.state.bus.publish("broker.changed", {"what": "orders"})
        await self.state.notifications.notify(
            "Real order sent to Zerodha", f"{order['transaction_type']} {order['quantity']} {order['tradingsymbol']} · order {order_id}", level="warning")
        return {"order_id": order_id, "order": order, "estimated_value": value,
                "note": "Sent to Zerodha. “Sent” is not “filled” — check its status in the list below or in Kite."}

    async def cancel(self, order_id: str, variety: str = "regular", actor: str = "user") -> dict[str, Any]:
        if not re.fullmatch(r"[0-9A-Za-z]{4,40}", order_id or "") or variety not in zerodha.VARIETIES + ("co", "iceberg", "auction"):
            raise BrokerError("That doesn't look like a Zerodha order.")
        self.state.approvals.ensure_not_halted()
        await self._guard(self._client().cancel_order(variety, order_id))
        self.state.audit.record(actor, "broker.cancel", order_id, "executed")
        self.state.bus.publish("broker.changed", {"what": "orders"})
        return {"cancelled": order_id}

    def history(self, limit: int = 50) -> list[dict[str, Any]]:
        return self.state.db.query("SELECT * FROM broker_orders ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 200)),))

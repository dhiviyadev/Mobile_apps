"""Zerodha Kite Connect v3 client (https://kite.trade/docs/connect/v3/).

Only what NEXUS needs: the login handshake, account reads, last prices, and placing / cancelling
orders. Every call goes to api.kite.trade over HTTPS with the user's own API key. The transport is
injectable so the tests never touch the network.

Facts this client relies on (checked against Zerodha's documentation and support pages, Nov 2026):
  * Login: the user signs in at kite.zerodha.com/connect/login; Zerodha redirects to the app's
    registered redirect URL with a short-lived `request_token`, which is exchanged at
    POST /session/token using checksum = SHA-256(api_key + request_token + api_secret).
  * The access token expires at 6 AM the next day (a regulatory requirement), so login is daily.
  * Market and SL-M orders must carry `market_protection` (-1 = automatic) or they are rejected.
  * Since 1 April 2026 order placement is accepted only from the static IP registered for the API key.
  * The free "Personal" plan covers orders and portfolio but not market data (quotes fail with a
    permission error), so price lookups here are best-effort.
"""

from __future__ import annotations

import hashlib
from typing import Any
from urllib.parse import quote, urlencode

import httpx

API = "https://api.kite.trade"
LOGIN = "https://kite.zerodha.com/connect/login"
EXCHANGES = ("NSE", "BSE", "NFO", "BFO", "MCX", "CDS", "BCD")
PRODUCTS = ("CNC", "MIS", "NRML", "MTF")
ORDER_TYPES = ("MARKET", "LIMIT", "SL", "SL-M")
VARIETIES = ("regular", "amo")
VALIDITIES = ("DAY", "IOC")


class KiteError(Exception):
    def __init__(self, message: str, error_type: str = "", status: int = 0):
        super().__init__(message)
        self.error_type = error_type
        self.status = status

    @property
    def session_expired(self) -> bool:
        return self.error_type == "TokenException" or self.status == 403


def login_url(api_key: str, state: str) -> str:
    # redirect_params is echoed back on the redirect URL; we use it to tie the callback to this login attempt.
    return f"{LOGIN}?{urlencode({'v': 3, 'api_key': api_key, 'redirect_params': urlencode({'state': state})})}"


def checksum(api_key: str, request_token: str, api_secret: str) -> str:
    return hashlib.sha256(f"{api_key}{request_token}{api_secret}".encode()).hexdigest()


class KiteClient:
    def __init__(self, api_key: str, access_token: str | None = None, transport: httpx.AsyncBaseTransport | None = None):
        self.api_key = api_key
        self.access_token = access_token
        self.transport = transport

    async def _call(self, method: str, path: str, *, data: dict[str, Any] | None = None, params: Any = None, auth: bool = True) -> Any:
        headers = {"X-Kite-Version": "3"}
        if auth:
            if not self.access_token:
                raise KiteError("Not logged in to Zerodha.", "TokenException", 403)
            headers["Authorization"] = f"token {self.api_key}:{self.access_token}"
        try:
            async with httpx.AsyncClient(base_url=API, transport=self.transport, timeout=httpx.Timeout(20, connect=10), trust_env=True) as client:
                resp = await client.request(method, path, data=data, params=params, headers=headers)
        except httpx.HTTPError as exc:
            raise KiteError("Couldn't reach Zerodha. Check the internet connection.", "NetworkException") from exc
        try:
            body = resp.json()
        except ValueError:
            body = {}
        if resp.status_code >= 400 or body.get("status") == "error":
            raise KiteError(str(body.get("message") or f"Zerodha answered with an error ({resp.status_code})."),
                            str(body.get("error_type") or ""), resp.status_code)
        return body.get("data")

    # -- session ------------------------------------------------------------------
    async def exchange(self, api_secret: str, request_token: str) -> dict[str, Any]:
        data = await self._call("POST", "/session/token", auth=False, data={
            "api_key": self.api_key, "request_token": request_token, "checksum": checksum(self.api_key, request_token, api_secret)})
        if not isinstance(data, dict) or not data.get("access_token"):
            raise KiteError("Zerodha didn't return a session. Try logging in again.")
        self.access_token = data["access_token"]
        return data

    async def logout(self) -> None:
        await self._call("DELETE", "/session/token", params={"api_key": self.api_key, "access_token": self.access_token})

    # -- reads --------------------------------------------------------------------
    async def profile(self) -> dict[str, Any]:
        return await self._call("GET", "/user/profile") or {}

    async def margins(self) -> dict[str, Any]:
        return await self._call("GET", "/user/margins") or {}

    async def holdings(self) -> list[dict[str, Any]]:
        return await self._call("GET", "/portfolio/holdings") or []

    async def positions(self) -> dict[str, Any]:
        return await self._call("GET", "/portfolio/positions") or {}

    async def orders(self) -> list[dict[str, Any]]:
        return await self._call("GET", "/orders") or []

    async def mf_holdings(self) -> list[dict[str, Any]]:
        return await self._call("GET", "/mf/holdings") or []

    async def ltp(self, instruments: list[str]) -> dict[str, float]:
        """Last traded prices for e.g. ["NSE:INFY"]. Needs the paid data plan; callers must cope with KiteError."""
        data = await self._call("GET", "/quote/ltp", params=[("i", i) for i in instruments]) or {}
        return {k: float(v["last_price"]) for k, v in data.items() if isinstance(v, dict) and v.get("last_price") is not None}

    # -- orders -------------------------------------------------------------------
    async def place_order(self, variety: str, fields: dict[str, Any]) -> str:
        data = await self._call("POST", f"/orders/{quote(variety, safe='')}", data=fields)
        order_id = (data or {}).get("order_id") if isinstance(data, dict) else None
        if not order_id:
            raise KiteError("Zerodha accepted the request but returned no order number. Check the order book in Kite before trying again.")
        return str(order_id)

    async def cancel_order(self, variety: str, order_id: str) -> str:
        data = await self._call("DELETE", f"/orders/{quote(variety, safe='')}/{quote(order_id, safe='')}")
        return str((data or {}).get("order_id") or order_id)

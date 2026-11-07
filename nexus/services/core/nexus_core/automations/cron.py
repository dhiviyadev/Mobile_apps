"""Minimal 5-field cron parser (minute hour day-of-month month day-of-week), local time.

Supports *, lists (1,2), ranges (1-5), steps (*/15, 1-10/2) and day names
(mon..sun). Day-of-month and day-of-week follow Vixie-cron OR semantics when
both are restricted. Kept dependency-free on purpose.
"""

from __future__ import annotations

from datetime import datetime, timedelta

_NAMES = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}
_BOUNDS = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]


class CronError(ValueError):
    pass


def _parse_field(field: str, lo: int, hi: int, names: bool = False) -> set[int]:
    values: set[int] = set()
    for part in field.lower().split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/", 1)
            if not s.isdigit() or int(s) < 1:
                raise CronError(f"bad step in '{field}'")
            step = int(s)
        if part in ("*", ""):
            start, end = lo, hi
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = _val(a, names), _val(b, names)
        else:
            start = _val(part, names)
            end = hi if step > 1 else start
        if not (lo <= start <= hi and lo <= end <= hi and start <= end):
            raise CronError(f"value out of range in '{field}'")
        values.update(range(start, end + 1, step))
    if names:  # weekday: both 0 and 7 mean Sunday
        values = {v % 7 for v in values}
    return values


def _val(token: str, names: bool) -> int:
    if names and token in _NAMES:
        return _NAMES[token]
    if not token.isdigit():
        raise CronError(f"bad value '{token}'")
    return int(token)


class Cron:
    def __init__(self, expr: str):
        parts = expr.split()
        if len(parts) != 5:
            raise CronError("cron expression needs 5 fields: minute hour day month weekday")
        self.expr = expr
        self.minutes = _parse_field(parts[0], *_BOUNDS[0])
        self.hours = _parse_field(parts[1], *_BOUNDS[1])
        self.days = _parse_field(parts[2], *_BOUNDS[2])
        self.months = _parse_field(parts[3], *_BOUNDS[3])
        self.weekdays = _parse_field(parts[4], 0, 7, names=True)
        self._dom_star = parts[2] == "*"
        self._dow_star = parts[4] == "*"

    def matches(self, dt: datetime) -> bool:
        if dt.minute not in self.minutes or dt.hour not in self.hours or dt.month not in self.months:
            return False
        dow = (dt.weekday() + 1) % 7  # python Monday=0 -> cron Sunday=0
        dom_ok, dow_ok = dt.day in self.days, dow in self.weekdays
        if self._dom_star or self._dow_star:
            return dom_ok and dow_ok
        return dom_ok or dow_ok

    def next_after(self, dt: datetime) -> datetime:
        t = dt.replace(second=0, microsecond=0) + timedelta(minutes=1)
        limit = t + timedelta(days=366 * 2)
        while t < limit:
            if t.month not in self.months:
                t = (t.replace(day=1, hour=0, minute=0) + timedelta(days=32)).replace(day=1)
                continue
            if t.hour not in self.hours:
                t = t.replace(minute=0) + timedelta(hours=1)
                continue
            if self.matches(t):
                return t
            t += timedelta(minutes=1)
        raise CronError("no matching time in the next two years")


def describe(expr: str) -> str:
    try:
        c = Cron(expr)
    except CronError as exc:
        return f"invalid: {exc}"
    parts = expr.split()
    if parts[2:] == ["*", "*", "*"] and len(c.minutes) == 1 and len(c.hours) == 1:
        return f"Every day at {min(c.hours):02d}:{min(c.minutes):02d}"
    if parts[2:4] == ["*", "*"] and len(c.minutes) == 1 and len(c.hours) == 1:
        days = ",".join(k.title() for k, v in _NAMES.items() if v in c.weekdays)
        return f"{days} at {min(c.hours):02d}:{min(c.minutes):02d}"
    return expr

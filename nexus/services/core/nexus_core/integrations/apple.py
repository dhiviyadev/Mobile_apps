"""Calendar, Reminders and Mail — read your day, add reminders, prepare email drafts.

Each one is off until the user turns it on in Settings, and macOS asks for its
own permission the first time. Reading stays on the Mac. The two actions that
change something (creating a reminder, opening an email draft) need the user's
approval each time, and NEXUS never sends email: it only opens a draft in Mail.

Calendar events are read with the `nexus-cal` EventKit helper when it can be
built (it expands repeating events correctly). Otherwise AppleScript is used,
which only sees repeating events on their first date.

User text is always passed to AppleScript as arguments, never pasted into the
script source.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from typing import Any

from ..config import IS_MACOS
from ..native import helpers
from ..permissions.approvals import ApprovalService
from ..permissions.audit import AuditLog
from ..permissions.policy import PermissionDenied
from ..settings_store import SettingsStore

_ISO_HELPERS = '''
on iso(d)
	return ((year of d) as string) & "-" & my pad((month of d) as integer) & "-" & my pad(day of d) & "T" & my pad(hours of d) & ":" & my pad(minutes of d)
end iso

on pad(n)
	if n < 10 then return "0" & (n as string)
	return n as string
end pad

on parseIso(s)
	set d to current date
	set day of d to 1
	set year of d to (text 1 thru 4 of s) as integer
	set month of d to (text 6 thru 7 of s) as integer
	set day of d to (text 9 thru 10 of s) as integer
	set time of d to ((text 12 thru 13 of s) as integer) * hours + ((text 15 thru 16 of s) as integer) * minutes
	return d
end parseIso
'''

CALENDAR_SCRIPT = '''
on run argv
	set dayCount to (item 1 of argv) as integer
	set startDate to current date
	set time of startDate to 0
	set endDate to startDate + (dayCount * days)
	set out to ""
	tell application "Calendar"
		repeat with c in calendars
			set calName to name of c
			set evs to (every event of c whose start date >= startDate and start date < endDate)
			repeat with e in evs
				set loc to ""
				try
					set loc to location of e
					if loc is missing value then set loc to ""
				end try
				set out to out & (summary of e) & tab & my iso(start date of e) & tab & my iso(end date of e) & tab & ((allday event of e) as string) & tab & calName & tab & loc & linefeed
			end repeat
		end repeat
	end tell
	return out
end run
''' + _ISO_HELPERS

REMINDERS_SCRIPT = '''
on run argv
	set out to ""
	tell application "Reminders"
		repeat with r in (reminders whose completed is false)
			set dueText to ""
			try
				set d to due date of r
				if d is not missing value then set dueText to my iso(d)
			end try
			set listName to ""
			try
				set listName to name of container of r
			end try
			set out to out & (name of r) & tab & dueText & tab & listName & linefeed
		end repeat
	end tell
	return out
end run
''' + _ISO_HELPERS

CREATE_REMINDER_SCRIPT = '''
on run argv
	set theTitle to item 1 of argv
	set theNotes to item 2 of argv
	set dueText to item 3 of argv
	tell application "Reminders"
		set r to make new reminder with properties {name:theTitle, body:theNotes}
		if dueText is not "" then set due date of r to my parseIso(dueText)
	end tell
	return "ok"
end run
''' + _ISO_HELPERS

DRAFT_EMAIL_SCRIPT = '''
on run argv
	set theTo to item 1 of argv
	set theSubject to item 2 of argv
	set theBody to item 3 of argv
	tell application "Mail"
		set m to make new outgoing message with properties {subject:theSubject, content:theBody, visible:true}
		if theTo is not "" then
			tell m to make new to recipient at end of to recipients with properties {address:theTo}
		end if
		activate
	end tell
	return "ok"
end run
'''

_DUE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
_EMAIL = re.compile(r"^[^@\s,;<>\"]+@[^@\s,;<>\"]+\.[^@\s,;<>\"]+$")
_PERMISSION_HINTS = ("-1743", "not authorized", "not allowed", "-10004", "access denied")

Runner = Callable[[list[str], float], Awaitable[dict[str, Any]]]


class AppleUnavailable(Exception):
    pass


async def _exec(argv: list[str], timeout: float) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                stdin=asyncio.subprocess.DEVNULL)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise AppleUnavailable("The app took too long to answer.") from None
    return {"returncode": proc.returncode, "stdout": out.decode(errors="replace"), "stderr": err.decode(errors="replace")}


def _clean(value: str, limit: int) -> str:
    return " ".join(str(value or "").replace("\t", " ").split())[:limit]


class AppleService:
    APPS = {"calendar": "Calendar", "reminders": "Reminders", "mail": "Mail"}

    def __init__(self, prefs: SettingsStore, approvals: ApprovalService, audit: AuditLog):
        self.prefs = prefs
        self.approvals = approvals
        self.audit = audit
        self.available = IS_MACOS
        self.run: Runner = _exec  # tests replace this
        self.cal_helper: Callable[[], str | None] = lambda: helpers.helper("nexus-cal")

    def status(self) -> dict[str, Any]:
        return {"available": self.available,
                **{k: bool(self.prefs.get(f"integrations.{k}")) for k in self.APPS}}

    def _require(self, which: str) -> None:
        if not self.prefs.get(f"integrations.{which}"):
            raise AppleUnavailable(f"{self.APPS[which]} access is turned off. The user can turn it on in Settings → Web & apps.")
        if not self.available:
            raise AppleUnavailable(f"{self.APPS[which]} is only available on macOS.")

    async def _osascript(self, which: str, script: str, args: list[str], timeout: float = 60) -> str:
        out = await self.run(["/usr/bin/osascript", "-e", script, *args], timeout)
        if out["returncode"] != 0:
            err = out["stderr"].strip()
            if any(h in err.lower() for h in _PERMISSION_HINTS):
                raise AppleUnavailable(
                    f"macOS hasn't allowed NEXUS to use {self.APPS[which]}. Open System Settings → Privacy & Security → "
                    f"Automation and allow it, then try again.")
            raise AppleUnavailable(f"{self.APPS[which]} returned an error: {err[:200]}")
        return out["stdout"]

    # -- calendar ---------------------------------------------------------------------
    async def events(self, days: int = 1, actor: str = "user") -> dict[str, Any]:
        self._require("calendar")
        days = max(1, min(int(days or 1), 14))
        events: list[dict[str, Any]] | None = None
        source = "eventkit"
        binary = self.cal_helper()
        if binary:
            out = await self.run([binary, str(days)], 30)
            if out["returncode"] == 0:
                try:
                    events = json.loads(out["stdout"] or "{}").get("events", [])
                except ValueError:
                    events = None
            elif out["returncode"] == 2:
                raise AppleUnavailable("macOS hasn't allowed NEXUS to read your calendar. Open System Settings → "
                                       "Privacy & Security → Calendars and allow it, then try again.")
        if events is None:
            source = "applescript"
            raw = await self._osascript("calendar", CALENDAR_SCRIPT, [str(days)], timeout=90)
            events = []
            for line in raw.splitlines():
                f = line.split("\t")
                if len(f) >= 5 and f[0].strip():
                    events.append({"title": f[0].strip(), "start": f[1], "end": f[2], "all_day": f[3].strip().lower() == "true",
                                   "calendar": f[4], "location": f[5].strip() if len(f) > 5 else ""})
            events.sort(key=lambda e: e["start"])
        self.audit.record(actor, "calendar.read", f"{days} day(s)", "executed", events=len(events))
        return {"days": days, "events": events[:200], "source": source}

    # -- reminders --------------------------------------------------------------------
    async def reminders(self, actor: str = "user") -> dict[str, Any]:
        self._require("reminders")
        raw = await self._osascript("reminders", REMINDERS_SCRIPT, [], timeout=120)
        items = []
        for line in raw.splitlines():
            f = line.split("\t")
            if f and f[0].strip():
                items.append({"title": f[0].strip(), "due": (f[1].strip() if len(f) > 1 else "") or None,
                              "list": f[2].strip() if len(f) > 2 else ""})
        items.sort(key=lambda r: (r["due"] is None, r["due"] or ""))
        self.audit.record(actor, "reminders.read", None, "executed", reminders=len(items))
        return {"reminders": items[:200]}

    async def create_reminder(self, title: str, notes: str = "", due: str | None = None, actor: str = "agent",
                              task_id: str | None = None, require_approval: bool = True) -> dict[str, Any]:
        self.approvals.ensure_not_halted()
        self._require("reminders")
        title = _clean(title, 200)
        if not title:
            raise ValueError("A reminder needs a title")
        due = (due or "").strip()[:16]
        if due and not _DUE.match(due):
            raise ValueError("due must look like 2026-03-01T09:00")
        notes = str(notes or "")[:2000]
        if require_approval and not await self.approvals.request(
            "reminder.create", f"Add reminder “{title}”", f"{actor} wants to add a reminder" + (f" due {due.replace('T', ' ')}" if due else ""),
            {"title": title, "due": due or None, "notes": notes[:500]}, task_id=task_id,
        ):
            self.audit.record(actor, "reminder.create", title, "denied")
            raise PermissionDenied("Adding the reminder was not approved")
        await self._osascript("reminders", CREATE_REMINDER_SCRIPT, [title, notes, due])
        self.audit.record(actor, "reminder.create", title, "executed", due=due or None)
        return {"created": True, "title": title, "due": due or None}

    # -- mail -------------------------------------------------------------------------
    async def draft_email(self, to: str, subject: str, body: str, actor: str = "agent", task_id: str | None = None,
                          require_approval: bool = True) -> dict[str, Any]:
        self.approvals.ensure_not_halted()
        self._require("mail")
        to = (to or "").strip()
        if to and not _EMAIL.match(to):
            raise ValueError("to must be a single email address")
        subject = _clean(subject, 200)
        body = str(body or "")[:20000]
        if require_approval and not await self.approvals.request(
            "mail.draft", f"Open email draft “{subject or '(no subject)'}”",
            f"{actor} wants to open a draft in Mail" + (f" to {to}" if to else "") + ". NEXUS never sends email; you review and send it yourself.",
            {"to": to, "subject": subject, "body": body[:1500]}, task_id=task_id,
        ):
            self.audit.record(actor, "mail.draft", subject, "denied")
            raise PermissionDenied("Opening the email draft was not approved")
        await self._osascript("mail", DRAFT_EMAIL_SCRIPT, [to, subject, body])
        self.audit.record(actor, "mail.draft", subject, "executed", to=to or None)
        return {"drafted": True, "sent": False, "note": "A draft is open in Mail. The user must review and send it."}

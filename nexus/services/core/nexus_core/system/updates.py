"""In-app updates from the git checkout NEXUS runs from.

* Checking is read-only: `git fetch` + compare HEAD with its upstream, listing only commits that
  touch the NEXUS folder. It runs ~1 minute after start and then every 6 hours (Settings → Updates
  can turn this off), plus on demand.
* Applying never happens automatically. When the user clicks *Update & restart*, a detached
  `scripts/update.sh` pulls (fast-forward only), refreshes dependencies, rebuilds the phone app and,
  when NEXUS runs as the installed app, rebuilds and reopens NEXUS.app. It runs in its own session
  so it survives the app quitting during the reinstall. Output goes to data/logs/update.log.
* Updates are refused if tracked files in the checkout were modified locally.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..app_state import AppState

log = logging.getLogger(__name__)

CHECK_INTERVAL_S = 6 * 3600
FIRST_CHECK_DELAY_S = 60


class UpdateError(Exception):
    pass


class UpdateService:
    def __init__(self, state: "AppState", nexus_root: Path):
        self.state = state
        self.nexus_root = nexus_root
        self.status: dict[str, Any] = {"supported": None, "checked_at": None}
        self._notified_sha: str | None = None
        self.applying = False
        self.result: str | None = None

    @property
    def log_path(self) -> Path:
        return self.state.settings.logs_dir / "update.log"

    async def _git(self, *args: str, timeout: float = 60) -> str:
        proc = await asyncio.create_subprocess_exec(
            "git", *args, cwd=str(self.nexus_root), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise UpdateError(f"git {args[0]} timed out") from None
        if proc.returncode != 0:
            raise UpdateError(err.decode(errors="replace").strip()[:300] or f"git {args[0]} failed")
        return out.decode(errors="replace").strip()

    async def check(self, fetch: bool = True) -> dict[str, Any]:
        st: dict[str, Any] = {"supported": False, "checked_at": time.time(), "applying": self.applying,
                              "launched_by_app": self.state.settings.launched_by_app}
        try:
            await self._git("rev-parse", "--is-inside-work-tree", timeout=10)
        except (UpdateError, OSError) as exc:
            st["error"] = f"Updates need the git checkout NEXUS was installed from ({exc})"
            self.status = st
            return st
        try:
            branch = await self._git("rev-parse", "--abbrev-ref", "HEAD", timeout=10)
            try:
                upstream = await self._git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", timeout=10)
            except UpdateError:
                upstream = f"origin/{branch}"
            if fetch:
                remote = upstream.split("/", 1)[0]
                await self._git("fetch", "--quiet", remote, timeout=60)
            head = await self._git("log", "-1", "--format=%H%x1f%h%x1f%cI%x1f%s", timeout=10)
            h_full, h_short, h_date, h_subj = head.split("\x1f")
            raw = await self._git("log", "--format=%h%x1f%cI%x1f%s", f"HEAD..{upstream}", "--", ".", timeout=20)
            commits = [dict(zip(("sha", "date", "subject"), line.split("\x1f"), strict=False)) for line in raw.splitlines() if line]
            latest = (await self._git("rev-parse", upstream, timeout=10)) if commits else h_full
            dirty = [ln[3:] for ln in (await self._git("status", "--porcelain", "--untracked-files=no", "--", ".", timeout=20)).splitlines() if ln]
            st.update({
                "supported": True, "branch": branch, "upstream": upstream,
                "current": {"sha": h_short, "date": h_date, "subject": h_subj},
                "available": bool(commits), "behind": len(commits), "commits": commits[:30], "latest_sha": latest,
                "dirty_files": dirty[:20],
            })
        except (UpdateError, OSError, ValueError) as exc:
            st["supported"] = True
            st["error"] = f"Couldn't check for updates: {exc}"
        self.status = st
        self.state.bus.publish("system.update", {"available": st.get("available", False), "behind": st.get("behind", 0)})
        if st.get("available") and st.get("latest_sha") != self._notified_sha:
            self._notified_sha = st["latest_sha"]
            n = st["behind"]
            await self.state.notifications.notify(
                "NEXUS update available",
                f"{n} change{'s' if n != 1 else ''} ready — Settings → Updates.", level="info", link="settings:updates",
            )
        return st

    def apply(self) -> dict[str, Any]:
        if self.applying:
            raise UpdateError("An update is already running.")
        st = self.status
        if not st.get("supported"):
            raise UpdateError(st.get("error") or "Updates aren't available for this installation.")
        if st.get("dirty_files"):
            raise UpdateError("NEXUS's files were changed locally (" + ", ".join(st["dirty_files"][:5]) +
                              "). Commit or discard those changes, then try again.")
        if not st.get("available"):
            raise UpdateError("NEXUS is already up to date.")
        script = self.nexus_root / "scripts" / "update.sh"
        if not script.is_file():
            raise UpdateError("scripts/update.sh is missing from this checkout.")
        mode = "--app" if self.state.settings.launched_by_app else "--dev"
        self.state.settings.logs_dir.mkdir(parents=True, exist_ok=True)
        logf = open(self.log_path, "w", encoding="utf-8")  # noqa: SIM115 - handed to the child process
        # start_new_session: the updater survives NEXUS quitting while the new app is installed.
        subprocess.Popen(["/bin/bash", str(script), mode], cwd=str(self.nexus_root), stdout=logf, stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, start_new_session=True,
                         env={**os.environ, "NEXUS_DATA_DIR": str(self.state.settings.data_dir), "GIT_TERMINAL_PROMPT": "0"})
        logf.close()
        self.applying = True
        self.result = None
        self.state.audit.record("user", "system.update", st.get("latest_sha"), "executed", mode=mode, behind=st.get("behind"))
        self.state.bus.publish("system.update", {"applying": True})
        asyncio.get_running_loop().create_task(self._watch(), name="update-watch")
        return {"started": True, "mode": mode}

    async def _watch(self) -> None:
        """Follow the updater from the core, so the UI updates wherever the user is."""
        for _ in range(3600):  # up to ~2 hours
            await asyncio.sleep(2)
            self.log_tail(5)
            if not self.applying:
                break
        else:
            self.applying = False
            self.result = "failed"
        try:
            await self.check(fetch=False)
        except Exception:  # noqa: BLE001
            log.exception("post-update check failed")
        if self.result == "done" and not self.state.settings.launched_by_app:
            await self.state.notifications.notify("NEXUS updated", "Restart ./scripts/dev.sh to use the new version.",
                                                  link="settings:updates")
        elif self.result == "failed":
            await self.state.notifications.notify("NEXUS update failed", "See Settings → Updates for details.",
                                                  level="error", link="settings:updates")
        self.state.bus.publish("system.update", {"applying": False, "result": self.result})

    def log_tail(self, lines: int = 40) -> list[str]:
        try:
            text = self.log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return []
        all_lines = text.splitlines()
        if self.applying and any(m in all_lines[-5:] for m in ("NEXUS_UPDATE_DONE", "NEXUS_UPDATE_FAILED")):
            self.applying = False
            self.result = "done" if "NEXUS_UPDATE_DONE" in all_lines[-5:] else "failed"
        return [ln for ln in all_lines[-lines:] if not ln.startswith("NEXUS_UPDATE_")]

    async def run_checker(self) -> None:
        await asyncio.sleep(FIRST_CHECK_DELAY_S)
        while True:
            if self.state.prefs.get("updates.auto_check"):
                try:
                    await self.check(fetch=True)
                except Exception:  # noqa: BLE001
                    log.exception("update check failed")
            await asyncio.sleep(CHECK_INTERVAL_S)

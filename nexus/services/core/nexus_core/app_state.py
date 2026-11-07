"""Wires all services together. One instance per running core."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .agents.hermes import HermesAdapter
from .agents.profiles import seed_agents
from .agents.service import AgentService
from .automations.service import AutomationService
from .config import Settings
from .conversations.service import ConversationService
from .db.database import Database
from .events import EventBus
from .integrations.files import FileService
from .integrations.macos import MacOSService
from .integrations.notifications import NotificationService
from .knowledge.service import KnowledgeService
from .memory.service import MemoryService
from .models.cloud import CloudAdapter
from .models.ollama import OllamaClient
from .models.router import ModelRouter
from .permissions.approvals import ApprovalService
from .permissions.audit import AuditLog
from .permissions.policy import PermissionService
from .security import Keychain, load_or_create_token
from .settings_store import SettingsStore
from .system.monitor import SystemMonitor
from .tasks.manager import TaskManager
from .voice.service import VoiceService

log = logging.getLogger(__name__)


class AppState:
    def __init__(self, settings: Settings):
        settings.ensure_dirs()
        self.settings = settings
        self.token = load_or_create_token(settings.secrets_dir)
        self.db = Database(settings.db_path)
        self.migrations_applied = self.db.migrate()
        self.bus = EventBus()
        self.prefs = SettingsStore(self.db)
        self.keychain = Keychain()
        self.audit = AuditLog(self.db, self.bus)
        self.permissions = PermissionService(self.db, self.audit, settings.workspace_dir)
        self.approvals = ApprovalService(self.db, self.bus, self.audit)
        self.tasks = TaskManager(self.db, self.bus, max_parallel=int(self.prefs.get("agents.max_parallel") or 1))
        self.ollama = OllamaClient(settings.ollama_url)
        self.router = ModelRouter(self.ollama, self.prefs, self.db)
        self.cloud = CloudAdapter(self.prefs, self.keychain)
        self.hermes = HermesAdapter(settings, self.keychain)
        self.files = FileService(self.permissions, self.approvals, self.audit, settings.trash_dir)
        self.macos = MacOSService(self.db, self.permissions, self.approvals, self.audit, settings.scripts_dir, settings.workspace_dir)
        self.notifications = NotificationService(self.db, self.bus, self.prefs, self.macos)
        self.knowledge = KnowledgeService(self.db, self.bus, self.permissions, float(self.prefs.get("knowledge.max_file_mb") or 25))
        self.memory = MemoryService(self.db, self.bus)
        self.voice = VoiceService(self.prefs, settings.data_dir / "voice")
        self.agents = AgentService(self)
        self.conversations = ConversationService(self)
        self.automations = AutomationService(self)
        self.monitor = SystemMonitor(self)
        self._background: list[asyncio.Task[Any]] = []

        seed_agents(self.db)
        recovered = self.tasks.recover()
        if recovered:
            log.warning("marked %d orphaned tasks as interrupted", recovered)
        self.approvals.expire_stale()

    def start_background(self) -> None:
        self._background = [
            asyncio.create_task(self.automations.run_scheduler(), name="scheduler"),
            asyncio.create_task(self.monitor.run_sampler(), name="sampler"),
        ]

    async def emergency_stop(self) -> dict[str, Any]:
        denied = self.approvals.halt()
        cancelled = await self.tasks.cancel_all()
        self.audit.record("user", "emergency.stop", None, "executed", cancelled=cancelled, denied=denied)
        await self.notifications.notify("Emergency stop", f"Cancelled {cancelled} tasks, denied {denied} pending approvals.", level="warning")
        return {"halted": True, "cancelled_tasks": cancelled, "denied_approvals": denied}

    async def shutdown(self) -> None:
        for t in self._background:
            t.cancel()
        await self.tasks.shutdown()
        await self.ollama.close()
        self.db.close()

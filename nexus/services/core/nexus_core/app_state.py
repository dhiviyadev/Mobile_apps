"""Wires all services together. One instance per running core."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .agents.hermes import HermesAdapter
from .agents.profiles import seed_agents
from .agents.service import AgentService
from .automations.service import AutomationService
from .brokers.service import BrokerService
from .config import Settings
from .conversations.service import ConversationService
from .db.database import Database
from .events import EventBus
from .integrations.apple import AppleService
from .integrations.files import FileService
from .integrations.macos import MacOSService
from .integrations.notifications import NotificationService
from .integrations.web import WebService
from .knowledge import ocr
from .knowledge.service import KnowledgeService
from .markets.service import MarketService
from .memory.service import MemoryService
from .models.cloud import CloudAdapter
from .native import helpers as native_helpers
from .models.manager import ModelManager
from .models.ollama import OllamaClient
from .models.router import ModelRouter
from .permissions.approvals import ApprovalService
from .permissions.audit import AuditLog
from .permissions.policy import PermissionService
from .projects.service import ProjectService
from .remote.push import PushService
from .remote.service import DeviceService
from .security import Keychain, load_or_create_token
from .settings_store import SettingsStore
from .system.monitor import SystemMonitor
from .system.updates import UpdateService
from .tasks.manager import TaskManager
from .voice.service import VoiceService

log = logging.getLogger(__name__)


class AppState:
    def __init__(self, settings: Settings):
        settings.ensure_dirs()
        self.settings = settings
        self.token = load_or_create_token(settings.secrets_dir)
        native_helpers.configure(settings.data_dir / "bin")
        self.db = Database(settings.db_path)
        self.migrations_applied = self.db.migrate()
        self.bus = EventBus()
        self.prefs = SettingsStore(self.db)
        self.keychain = Keychain()
        self.audit = AuditLog(self.db, self.bus)
        self.permissions = PermissionService(self.db, self.audit, settings.workspace_dir)
        self.approvals = ApprovalService(self.db, self.bus, self.audit)
        self.devices = DeviceService(self.db, self.prefs, self.audit)
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
        self.projects = ProjectService(self.db, self.bus)
        self.web = WebService(self.prefs, self.audit)
        self.apple = AppleService(self.prefs, self.approvals, self.audit)
        self.push = PushService(self.db, self.prefs, self.audit, settings.secrets_dir)
        ocr.enabled = bool(self.prefs.get("knowledge.ocr"))
        self.voice = VoiceService(self.prefs, settings.data_dir / "voice")
        self.model_manager = ModelManager(self)
        self.markets = MarketService(self)
        self.broker = BrokerService(self)
        self.agents = AgentService(self)
        self.conversations = ConversationService(self)
        self.automations = AutomationService(self)
        self.monitor = SystemMonitor(self)
        self.updates = UpdateService(self, settings.nexus_root)
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
            asyncio.create_task(self.updates.run_checker(), name="update-checker"),
            asyncio.create_task(self.push.run_forwarder(self.bus), name="push-forwarder"),
            asyncio.create_task(self.markets.run_alerts(), name="price-alerts"),
        ]

    async def emergency_stop(self, actor: str = "user") -> dict[str, Any]:
        denied = self.approvals.halt()
        cancelled = await self.tasks.cancel_all()
        self.audit.record(actor, "emergency.stop", None, "executed", cancelled=cancelled, denied=denied)
        await self.notifications.notify("Emergency stop", f"Cancelled {cancelled} tasks, denied {denied} pending approvals.", level="warning")
        return {"halted": True, "cancelled_tasks": cancelled, "denied_approvals": denied}

    async def shutdown(self) -> None:
        for t in self._background:
            t.cancel()
        await self.tasks.shutdown()
        await self.ollama.close()
        self.db.close()

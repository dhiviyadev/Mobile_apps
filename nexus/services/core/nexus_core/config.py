"""Static configuration, read from environment variables.

Static settings are things needed before the database opens (paths, ports,
service URLs). Runtime preferences that the user edits in the UI (model
assignments, voice, cloud consent...) live in the `settings` table and are
managed by `nexus_core.settings_store`.
"""

from __future__ import annotations

import os
import platform
import shutil
from dataclasses import dataclass, field
from pathlib import Path

IS_MACOS = platform.system() == "Darwin"


def _default_data_dir() -> Path:
    # Running from a source checkout: keep data in <repo>/data (gitignored).
    repo_root = Path(__file__).resolve().parents[3]
    if (repo_root / "apps").is_dir() and (repo_root / "services").is_dir():
        return repo_root / "data"
    if IS_MACOS:
        return Path.home() / "Library" / "Application Support" / "NEXUS"
    return Path.home() / ".local" / "share" / "nexus"


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("NEXUS_DATA_DIR") or _default_data_dir()))
    host: str = field(default_factory=lambda: os.environ.get("NEXUS_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.environ.get("NEXUS_PORT", "8765")))
    log_level: str = field(default_factory=lambda: os.environ.get("NEXUS_LOG_LEVEL", "info"))

    ollama_url: str = field(default_factory=lambda: os.environ.get("NEXUS_OLLAMA_URL", "http://127.0.0.1:11434"))

    # Hermes: NEXUS never writes Hermes configuration. These only tell NEXUS how to reach it.
    hermes_mode: str = field(default_factory=lambda: os.environ.get("NEXUS_HERMES_MODE", "auto"))  # auto|api|cli|off
    hermes_api_url: str = field(default_factory=lambda: os.environ.get("NEXUS_HERMES_API_URL", "http://127.0.0.1:8642"))
    hermes_bin: str | None = field(default_factory=lambda: os.environ.get("NEXUS_HERMES_BIN") or shutil.which("hermes"))
    hermes_home: Path = field(default_factory=lambda: Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes"))

    # Allowed browser origins for the desktop webview / dev server.
    cors_origins: list[str] = field(
        default_factory=lambda: [
            o.strip()
            for o in os.environ.get(
                "NEXUS_CORS_ORIGINS",
                "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://127.0.0.1:1420,http://localhost:1421,http://127.0.0.1:1421",
            ).split(",")
            if o.strip()
        ]
    )

    # Built phone app (served at /m). Built by `npm run build:mobile`.
    mobile_dist: Path = field(default_factory=lambda: Path(os.environ.get("NEXUS_MOBILE_DIST") or Path(__file__).resolve().parents[3] / "apps" / "desktop" / "dist-mobile"))

    # Disabled only by tests; never disable in normal operation.
    require_auth: bool = field(default_factory=lambda: _env_bool("NEXUS_REQUIRE_AUTH", True))
    start_background: bool = field(default_factory=lambda: _env_bool("NEXUS_BACKGROUND", True))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "database" / "nexus.db"

    @property
    def workspace_dir(self) -> Path:
        return self.data_dir / "workspace"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def secrets_dir(self) -> Path:
        return self.data_dir / "secrets"

    @property
    def uploads_dir(self) -> Path:
        return self.workspace_dir / "uploads"

    @property
    def trash_dir(self) -> Path:
        return self.data_dir / "trash"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def scripts_dir(self) -> Path:
        """Approved scripts live here. Agents can only run scripts registered from this folder."""
        return self.data_dir / "scripts"

    def ensure_dirs(self) -> None:
        for d in (
            self.data_dir,
            self.db_path.parent,
            self.workspace_dir,
            self.uploads_dir,
            self.logs_dir,
            self.trash_dir,
            self.backups_dir,
            self.scripts_dir,
            self.data_dir / "knowledge",
            self.data_dir / "voice",
        ):
            d.mkdir(parents=True, exist_ok=True)
        self.secrets_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.secrets_dir, 0o700)

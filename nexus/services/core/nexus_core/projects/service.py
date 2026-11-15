"""Projects: a named workspace that groups conversations, memories, automations and
approved folders, and carries its own instructions for the assistant.

A project links to folders by name: any approved folder whose "project" label
equals the project's name belongs to it, so knowledge search inside a project
only looks at that project's documents (when it has any).
"""

from __future__ import annotations

from typing import Any

from ..db.database import Database
from ..events import EventBus
from ..util import new_id, now_iso

COLORS = ["blue", "violet", "pink", "amber", "green", "cyan"]


class ProjectService:
    def __init__(self, db: Database, bus: EventBus):
        self.db = db
        self.bus = bus

    def _decorate(self, p: dict[str, Any]) -> dict[str, Any]:
        p["archived"] = bool(p["archived"])
        c = self.db.query_one(
            "SELECT (SELECT COUNT(*) FROM conversations WHERE project_id = :id AND archived = 0) AS conversations, "
            "(SELECT COUNT(*) FROM memories WHERE project_id = :id AND status != 'archived') AS memories, "
            "(SELECT COUNT(*) FROM automations WHERE project_id = :id) AS automations, "
            "(SELECT COUNT(*) FROM folders WHERE project = :name) AS folders, "
            "(SELECT COUNT(*) FROM documents WHERE project = :name) AS documents",
            {"id": p["id"], "name": p["name"]})
        p["counts"] = c or {}
        return p

    def list(self, include_archived: bool = False) -> list[dict[str, Any]]:
        where = "" if include_archived else "WHERE archived = 0"
        return [self._decorate(p) for p in self.db.query(f"SELECT * FROM projects {where} ORDER BY name COLLATE NOCASE")]

    def get(self, project_id: str | None) -> dict[str, Any] | None:
        if not project_id:
            return None
        row = self.db.query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
        return self._decorate(row) if row else None

    def create(self, name: str, description: str = "", instructions: str = "", color: str | None = None) -> dict[str, Any]:
        name = " ".join(name.split())[:60]
        if not name:
            raise ValueError("A project needs a name")
        if self.db.query_one("SELECT id FROM projects WHERE lower(name) = lower(?)", (name,)):
            raise ValueError(f"A project called “{name}” already exists")
        pid = new_id("prj")
        ts = now_iso()
        count = self.db.query_one("SELECT COUNT(*) AS n FROM projects") or {"n": 0}
        self.db.execute(
            "INSERT INTO projects(id, name, description, instructions, color, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (pid, name, description.strip()[:500], instructions.strip()[:8000], color if color in COLORS else COLORS[count["n"] % len(COLORS)], 0, ts, ts))
        project = self.get(pid)
        self.bus.publish("project.changed", {"id": pid, "action": "created"})
        return project  # type: ignore[return-value]

    def update(self, project_id: str, **fields: Any) -> dict[str, Any]:
        current = self.get(project_id)
        if not current:
            raise KeyError(project_id)
        sets: dict[str, Any] = {}
        if fields.get("name") is not None:
            name = " ".join(str(fields["name"]).split())[:60]
            if not name:
                raise ValueError("A project needs a name")
            clash = self.db.query_one("SELECT id FROM projects WHERE lower(name) = lower(?) AND id != ?", (name, project_id))
            if clash:
                raise ValueError(f"A project called “{name}” already exists")
            sets["name"] = name
        if fields.get("description") is not None:
            sets["description"] = str(fields["description"]).strip()[:500]
        if fields.get("instructions") is not None:
            sets["instructions"] = str(fields["instructions"]).strip()[:8000]
        if fields.get("color") in COLORS:
            sets["color"] = fields["color"]
        if fields.get("archived") is not None:
            sets["archived"] = int(bool(fields["archived"]))
        if sets:
            sets["updated_at"] = now_iso()
            cols = ", ".join(f"{k} = ?" for k in sets)
            with self.db.transaction():
                self.db.execute(f"UPDATE projects SET {cols} WHERE id = ?", (*sets.values(), project_id))
                if "name" in sets and sets["name"] != current["name"]:
                    # Keep linked folders and their documents attached when the project is renamed.
                    self.db.execute("UPDATE folders SET project = ? WHERE project = ?", (sets["name"], current["name"]))
                    self.db.execute("UPDATE documents SET project = ? WHERE project = ?", (sets["name"], current["name"]))
        self.bus.publish("project.changed", {"id": project_id, "action": "updated"})
        return self.get(project_id)  # type: ignore[return-value]

    def delete(self, project_id: str) -> None:
        """Remove the project. Its conversations, memories and automations are kept and become unfiled."""
        current = self.get(project_id)
        if not current:
            raise KeyError(project_id)
        with self.db.transaction():
            for table in ("conversations", "memories", "automations"):
                self.db.execute(f"UPDATE {table} SET project_id = NULL WHERE project_id = ?", (project_id,))
            self.db.execute("UPDATE folders SET project = NULL WHERE project = ?", (current["name"],))
            self.db.execute("UPDATE documents SET project = NULL WHERE project = ?", (current["name"],))
            self.db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        self.bus.publish("project.changed", {"id": project_id, "action": "deleted"})

    # -- context for chat and agents -------------------------------------------------
    def knowledge_scope(self, project: dict[str, Any] | None) -> str | None:
        """Project name to filter knowledge search by, or None when the project has no documents of its own."""
        if not project:
            return None
        row = self.db.query_one("SELECT 1 AS x FROM documents WHERE project = ? LIMIT 1", (project["name"],))
        return project["name"] if row else None

    def prompt_block(self, project: dict[str, Any] | None) -> str:
        if not project:
            return ""
        text = f"\n\nYou are working inside the user's project “{project['name']}”."
        if project.get("description"):
            text += f" About it: {project['description']}"
        if project.get("instructions"):
            text += f"\nProject instructions from the user:\n{project['instructions']}"
        return text

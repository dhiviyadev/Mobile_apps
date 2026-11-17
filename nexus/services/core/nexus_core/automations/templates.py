"""Starter automations. All are created DISABLED and require approval until the user changes that."""

from __future__ import annotations

from typing import Any

TEMPLATES: list[dict[str, Any]] = [
    {
        "template": "market_close_briefing",
        "name": "Market close briefing",
        "description": "Each weekday after the Indian market closes: how the indices did, the biggest movers, and a fresh read of your watchlist.",
        "trigger": {"type": "schedule", "cron": "50 15 * * 1-5"},
        "conditions": [],
        "actions": [
            {"type": "agent_task", "agent_id": "trader",
             "prompt": "Write my market close briefing for {{date}}. Call market_overview, then market_scan. Give: 1) one line on how the Nifty 50 "
                       "and Bank Nifty closed, 2) the two biggest gainers and losers, 3) for my watchlist, which symbols lean long, which lean short "
                       "and which to stay out of, with the key level for each. Under 220 words. Information, not advice."},
            {"type": "write_file", "path": "markets/{{date}}-close.md", "content": "{{previous.output}}"},
            {"type": "notify", "title": "Market close briefing", "body": "{{previous.output|truncate:180}}"},
        ],
        "requires_approval": False,
    },
    {
        "template": "morning_briefing",
        "name": "Morning briefing",
        "description": "Each weekday morning, summarise open tasks, recent activity and what needs attention today.",
        "trigger": {"type": "schedule", "cron": "30 8 * * 1-5"},
        "conditions": [],
        "actions": [
            {"type": "agent_task", "agent_id": "chief",
             "prompt": "Prepare my morning briefing for {{date}}. Review my recent tasks and reviewed memories (projects, open tasks, decisions). "
                       "If the calendar and reminders tools work, include today's events and reminders that are due; if they are turned off, skip them silently. "
                       "Give: 1) top 3 priorities, 2) anything blocked or failed, 3) a suggested plan for the day. Keep it under 250 words."},
            {"type": "write_file", "path": "briefings/{{date}}-morning.md", "content": "{{previous.output}}"},
            {"type": "notify", "title": "Morning briefing ready", "body": "{{previous.output|truncate:180}}"},
        ],
        "requires_approval": False,
    },
    {
        "template": "weekly_summary",
        "name": "Weekly work summary",
        "description": "Friday afternoon summary of what was done this week.",
        "trigger": {"type": "schedule", "cron": "0 17 * * 5"},
        "conditions": [],
        "actions": [
            {"type": "agent_task", "agent_id": "chief",
             "prompt": "Write my weekly work summary for the week ending {{date}} from my NEXUS task history and memories: "
                       "accomplishments, decisions made, open items for next week."},
            {"type": "write_file", "path": "summaries/week-{{date}}.md", "content": "{{previous.output}}"},
        ],
        "requires_approval": False,
    },
    {
        "template": "classify_new_documents",
        "name": "Classify new documents",
        "description": "When a new document appears in a watched folder, classify it and log a one-line summary.",
        "trigger": {"type": "file", "folder_id": "", "events": ["created"], "patterns": ["*.pdf", "*.docx", "*.md", "*.txt"]},
        "conditions": [],
        "actions": [
            {"type": "agent_task", "agent_id": "automation",
             "prompt": "Read the new file {{trigger.path}} and reply with exactly one line: <category> | <one-sentence summary>. "
                       "Categories: invoice, contract, proposal, report, correspondence, notes, other."},
            {"type": "append_file", "path": "logs/document-classification.md", "content": "- {{trigger.name}}: {{previous.output}}"},
        ],
        "requires_approval": False,
    },
    {
        "template": "invoice_extraction",
        "name": "Invoice extraction",
        "description": "Extract supplier, date, number and total from new invoice PDFs into a CSV in the workspace.",
        "trigger": {"type": "file", "folder_id": "", "events": ["created"], "patterns": ["*.pdf"]},
        "conditions": [{"type": "name_contains", "value": "invoice"}],
        "actions": [
            {"type": "agent_task", "agent_id": "analyst",
             "prompt": "Read the invoice at {{trigger.path}}. Reply with ONE CSV line only, no header: "
                       "supplier,invoice_number,invoice_date(YYYY-MM-DD),currency,total. Use empty fields if unknown."},
            {"type": "append_file", "path": "invoices/invoices.csv", "content": "{{previous.output}},{{trigger.name}}"},
            {"type": "notify", "title": "Invoice extracted", "body": "{{trigger.name}}"},
        ],
        "requires_approval": True,
    },
    {
        "template": "folder_reindex",
        "name": "Nightly re-index",
        "description": "Re-index all approved knowledge folders every night.",
        "trigger": {"type": "schedule", "cron": "15 2 * * *"},
        "conditions": [],
        "actions": [{"type": "reindex_all"}],
        "requires_approval": False,
    },
    {
        "template": "project_status",
        "name": "Project status update",
        "description": "On demand: produce a status update for a project from the knowledge base.",
        "trigger": {"type": "manual"},
        "conditions": [],
        "actions": [
            {"type": "agent_task", "agent_id": "knowledge",
             "prompt": "Using the knowledge base, write a project status update: progress, risks, next steps. Cite sources."},
            {"type": "write_file", "path": "reports/project-status-{{date}}.md", "content": "{{previous.output}}"},
        ],
        "requires_approval": False,
    },
]

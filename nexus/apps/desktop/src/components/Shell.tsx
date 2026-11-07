import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity, Bell, Bot, BookOpen, Command, Home, MessageSquare, OctagonX, Play, Search, Settings, Sparkles, Workflow,
} from "lucide-react";
import { useCore, activeTasks, EMPTY } from "@/stores/core";
import { useChat } from "@/stores/chat";
import { shell } from "@/lib/tauri";
import type { Workspace } from "@/lib/types";
import { cls, relTime } from "@/lib/format";
import { Badge, Button, Dot, IconButton, Kbd } from "./ui";
import { Orb, useOrbState } from "./Orb";

export const NAV: { id: Workspace; label: string; icon: typeof Home; key: string }[] = [
  { id: "home", label: "Home", icon: Home, key: "1" },
  { id: "chat", label: "Chat", icon: MessageSquare, key: "2" },
  { id: "agents", label: "Agents", icon: Bot, key: "3" },
  { id: "knowledge", label: "Knowledge", icon: BookOpen, key: "4" },
  { id: "automations", label: "Automations", icon: Workflow, key: "5" },
  { id: "system", label: "System", icon: Activity, key: "6" },
];

export function Sidebar() {
  const workspace = useCore((s) => s.workspace);
  const setWorkspace = useCore((s) => s.setWorkspace);
  const boot = useCore((s) => s.boot);
  const tasks = useCore((s) => s.tasks);
  const status = useCore((s) => s.status);
  const orb = useOrbState();
  const running = activeTasks(tasks).length;
  const proposed = boot?.memory.proposed ?? 0;

  return (
    <aside className="flex w-[216px] flex-none flex-col border-r border-line-soft bg-sidebar">
      <div className="drag h-[46px] flex-none" />
      <div className="flex items-center gap-2.5 px-4 pb-4">
        <Orb state={orb} size={26} />
        <div className="leading-tight">
          <p className="font-[family-name:var(--font-display)] text-[14px] font-semibold tracking-[0.18em] text-fg">NEXUS</p>
          <p className="text-[10.5px] text-muted">{status === "online" ? "Local · private" : status}</p>
        </div>
      </div>
      <nav className="flex flex-col gap-0.5 px-2.5">
        {NAV.map((n) => {
          const Icon = n.icon;
          const active = workspace === n.id;
          return (
            <button
              key={n.id}
              onClick={() => setWorkspace(n.id)}
              className={cls(
                "focus-ring group flex h-8 items-center gap-2.5 rounded-[9px] px-2.5 text-[13px] transition-colors",
                active ? "bg-white/[0.07] text-fg" : "text-fg-2 hover:bg-white/[0.035] hover:text-fg",
              )}
            >
              <Icon size={15} strokeWidth={active ? 2.1 : 1.8} className={active ? "text-accent-strong" : "text-muted group-hover:text-fg-2"} />
              <span className="flex-1 text-left">{n.label}</span>
              {n.id === "agents" && running > 0 && <span className="text-[11px] text-accent">{running}</span>}
              {n.id === "knowledge" && proposed > 0 && <span className="h-1.5 w-1.5 rounded-full bg-warn" title={`${proposed} memories to review`} />}
              <span className="text-[10.5px] text-muted/0 group-hover:text-muted">⌘{n.key}</span>
            </button>
          );
        })}
      </nav>
      <RecentChats />
      <div className="mt-auto space-y-1 border-t border-line-soft p-2.5">
        <button
          onClick={() => setWorkspace("settings")}
          className={cls("flex h-8 w-full items-center gap-2.5 rounded-[9px] px-2.5 text-[13px]", workspace === "settings" ? "bg-white/[0.07] text-fg" : "text-fg-2 hover:bg-white/[0.035] hover:text-fg")}
        >
          <Settings size={15} className="text-muted" /> Settings
        </button>
        <ServiceLine />
      </div>
    </aside>
  );
}

function RecentChats() {
  const conversations = useChat((s) => s.conversations);
  const open = useChat((s) => s.open);
  const activeId = useChat((s) => s.activeId);
  const setWorkspace = useCore((s) => s.setWorkspace);
  const workspace = useCore((s) => s.workspace);
  if (!conversations.length) return null;
  return (
    <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2.5">
      <p className="px-2.5 pb-1.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted">Recent</p>
      {conversations.slice(0, 12).map((c) => (
        <button
          key={c.id}
          onClick={() => {
            void open(c.id);
            setWorkspace("chat");
          }}
          className={cls(
            "flex h-7 w-full items-center rounded-[8px] px-2.5 text-left text-[12.5px] transition-colors",
            workspace === "chat" && activeId === c.id ? "bg-white/[0.06] text-fg" : "text-fg-2 hover:bg-white/[0.03] hover:text-fg",
          )}
        >
          <span className="truncate">{c.title}</span>
        </button>
      ))}
    </div>
  );
}

function ServiceLine() {
  const boot = useCore((s) => s.boot);
  const ws = useCore((s) => s.ws);
  const items: [string, "ok" | "warn" | "danger" | "neutral"][] = [
    ["Core", ws === "open" ? "ok" : "danger"],
    ["Ollama", boot?.ollama.online ? "ok" : "danger"],
    ["Hermes", boot?.hermes.status === "ready" ? "ok" : boot?.hermes.status === "installed" ? "warn" : "neutral"],
  ];
  return (
    <div className="flex items-center gap-3 px-2.5 pt-1.5 text-[10.5px] text-muted">
      {items.map(([name, tone]) => (
        <span key={name} className="flex items-center gap-1.5">
          <Dot tone={tone} /> {name}
        </span>
      ))}
    </div>
  );
}

export function TitleBar({ title }: { title: string }) {
  const halted = useCore((s) => s.halted);
  const emergencyStop = useCore((s) => s.emergencyStop);
  const resume = useCore((s) => s.resume);
  const setPalette = useCore((s) => s.setPalette);
  const notifications = useCore((s) => s.notifications);
  const [notifOpen, setNotifOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <header className="drag relative flex h-[46px] flex-none items-center justify-between gap-3 border-b border-line-soft px-4">
      <p className="text-[12.5px] font-medium text-fg-2">{title}</p>
      <div className="no-drag flex items-center gap-1.5">
        <button
          onClick={() => setPalette(true)}
          className="flex h-7 w-[260px] items-center gap-2 rounded-[9px] border border-line-soft bg-white/[0.025] px-2.5 text-[12px] text-muted transition-colors hover:border-line hover:text-fg-2"
        >
          <Search size={13} /> Search or run a command
          <span className="ml-auto flex gap-0.5">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <div className="relative">
          <IconButton label="Notifications" onClick={() => setNotifOpen(!notifOpen)}>
            <Bell size={15} />
            {unread > 0 && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent" />}
          </IconButton>
          <AnimatePresence>
            {notifOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="surface-elevated absolute right-0 top-9 z-50 w-80 p-2"
              >
                {notifications.length === 0 ? (
                  <p className="p-3 text-[12px] text-muted">No notifications</p>
                ) : (
                  notifications.slice(0, 8).map((n) => (
                    <div key={n.id} className="rounded-lg p-2.5 hover:bg-white/[0.03]">
                      <p className="text-[12.5px] text-fg">{n.title}</p>
                      {n.body && <p className="line-clamp-2 text-[12px] text-fg-2">{n.body}</p>}
                      <p className="mt-0.5 text-[10.5px] text-muted">{relTime(n.created_at)}</p>
                    </div>
                  ))
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {halted ? (
          <Button size="sm" variant="secondary" icon={<Play size={12} />} onClick={() => void resume()}>
            Resume NEXUS
          </Button>
        ) : confirm ? (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="danger" onClick={() => void emergencyStop().then(() => setConfirm(false))}>
              Stop everything
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <IconButton label="Emergency stop — cancel all tasks and deny pending actions" onClick={() => setConfirm(true)}>
            <OctagonX size={15} className="text-danger/80" />
          </IconButton>
        )}
      </div>
    </header>
  );
}

export function HaltedBanner() {
  const halted = useCore((s) => s.halted);
  if (!halted) return null;
  return (
    <div className="flex items-center justify-center gap-2 border-b border-[#5a3337] bg-[#2a1a1c] py-1.5 text-[12px] text-[#f0c4c4]">
      <OctagonX size={13} /> Emergency stop is active. All agent actions, automations and generations are blocked until you resume.
    </div>
  );
}

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  icon: typeof Home;
  run: () => void;
}

export function CommandPalette() {
  const open = useCore((s) => s.paletteOpen);
  const setPalette = useCore((s) => s.setPalette);
  const setWorkspace = useCore((s) => s.setWorkspace);
  const emergencyStop = useCore((s) => s.emergencyStop);
  const agents = useCore((s) => s.boot?.agents ?? EMPTY);
  const conversations = useChat((s) => s.conversations);
  const openConv = useChat((s) => s.open);
  const newConv = useChat((s) => s.newConversation);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const commands = useMemo<Cmd[]>(() => {
    const nav: Cmd[] = NAV.map((n) => ({ id: `nav-${n.id}`, label: `Go to ${n.label}`, hint: `⌘${n.key}`, icon: n.icon, run: () => setWorkspace(n.id) }));
    const actions: Cmd[] = [
      { id: "new-chat", label: "New conversation", hint: "⌘N", icon: MessageSquare, run: () => void newConv().then(() => setWorkspace("chat")) },
      { id: "mini", label: "Toggle floating assistant", hint: "⌥Space", icon: Sparkles, run: () => void shell.toggleMini() },
      { id: "search", label: "Search knowledge", icon: Search, run: () => setWorkspace("knowledge") },
      { id: "settings", label: "Open settings", hint: "⌘,", icon: Settings, run: () => setWorkspace("settings") },
      { id: "stop", label: "Emergency stop", icon: OctagonX, run: () => void emergencyStop() },
    ];
    const agentCmds: Cmd[] = agents.map((a) => ({ id: `agent-${a.id}`, label: `Agent: ${a.name}`, hint: a.role, icon: Bot, run: () => setWorkspace("agents") }));
    const convs: Cmd[] = conversations.slice(0, 20).map((c) => ({
      id: `conv-${c.id}`, label: c.title, hint: relTime(c.updated_at), icon: MessageSquare,
      run: () => {
        void openConv(c.id);
        setWorkspace("chat");
      },
    }));
    return [...actions, ...nav, ...agentCmds, ...convs];
  }, [agents, conversations, emergencyStop, newConv, openConv, setWorkspace]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands.slice(0, 14);
    return commands.filter((c) => c.label.toLowerCase().includes(s) || c.hint?.toLowerCase().includes(s)).slice(0, 14);
  }, [q, commands]);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);

  const exec = (c: Cmd | undefined) => {
    if (!c) return;
    setPalette(false);
    c.run();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[14vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => setPalette(false)}>
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            onMouseDown={(e) => e.stopPropagation()}
            className="surface-elevated silver-edge glass w-[600px] overflow-hidden"
          >
            <div className="flex items-center gap-2.5 border-b border-line-soft px-4">
              <Command size={15} className="text-muted" />
              <input
                ref={input}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setIdx(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") setIdx((i) => Math.min(i + 1, filtered.length - 1));
                  else if (e.key === "ArrowUp") setIdx((i) => Math.max(i - 1, 0));
                  else if (e.key === "Enter") exec(filtered[idx]);
                  else if (e.key === "Escape") setPalette(false);
                  else return;
                  e.preventDefault();
                }}
                placeholder="Type a command or search…"
                className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-muted"
              />
              <Badge>esc</Badge>
            </div>
            <ul className="max-h-[380px] overflow-y-auto p-1.5">
              {filtered.map((c, i) => {
                const Icon = c.icon;
                return (
                  <li key={c.id}>
                    <button
                      onMouseEnter={() => setIdx(i)}
                      onClick={() => exec(c)}
                      className={cls("flex h-9 w-full items-center gap-3 rounded-[9px] px-3 text-left text-[13px]", i === idx ? "bg-white/[0.07] text-fg" : "text-fg-2")}
                    >
                      <Icon size={14} className="text-muted" />
                      <span className="flex-1 truncate">{c.label}</span>
                      {c.hint && <span className="text-[11px] text-muted">{c.hint}</span>}
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && <li className="p-4 text-[12.5px] text-muted">No matching commands</li>}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

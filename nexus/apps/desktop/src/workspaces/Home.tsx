import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, BookOpen, Bot, Calendar, CheckCircle2, CircleAlert, Clock, FolderOpen, Loader2, MessageSquare, Sun, XCircle } from "lucide-react";
import { useCore, activeTasks } from "@/stores/core";
import { useChat } from "@/stores/chat";
import { Composer } from "@/components/Composer";
import { Orb, useOrbState } from "@/components/Orb";
import { Badge, Dot, Empty } from "@/components/ui";
import { api } from "@/lib/api";
import type { SystemSnapshot, Task } from "@/lib/types";
import { bytes, clock, cls, greeting, longDate, relTime } from "@/lib/format";

function useNow(intervalMs = 15000): Date {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function TaskRow({ task, onClick }: { task: Task; onClick?: () => void }) {
  const icon =
    task.status === "completed" ? <CheckCircle2 size={14} className="text-ok" /> :
    task.status === "failed" ? <XCircle size={14} className="text-danger" /> :
    task.status === "cancelled" ? <XCircle size={14} className="text-muted" /> :
    task.status === "waiting_approval" ? <CircleAlert size={14} className="text-warn" /> :
    <Loader2 size={14} className="animate-spin text-accent" />;
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.03]">
      {icon}
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{task.title}</span>
      <span className="flex-none text-[11px] text-muted">{relTime(task.created_at)}</span>
    </button>
  );
}

export function Home() {
  const now = useNow();
  const boot = useCore((s) => s.boot);
  const tasks = useCore((s) => s.tasks);
  const setWorkspace = useCore((s) => s.setWorkspace);
  const focusTask = useCore((s) => s.focusTask);
  const send = useChat((s) => s.send);
  const open = useChat((s) => s.open);
  const orb = useOrbState();
  const [level, setLevel] = useState(0);
  const [wave, setWave] = useState<Uint8Array | null>(null);
  const [sys, setSys] = useState<SystemSnapshot | null>(null);

  useEffect(() => {
    void api.get<SystemSnapshot>("/api/system/status").then(setSys).catch(() => undefined);
  }, [boot]);

  const recent = Object.values(tasks).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6);
  const active = activeTasks(tasks);
  const busyAgents = boot?.agents.filter((a) => a.status === "busy") ?? [];
  const model = boot?.ollama.running[0] ?? boot?.ollama.default_model;
  const pressure = sys?.memory.pressure;

  const quick = [
    { label: "Plan my day", prompt: "Plan my day: review my open tasks and memories and propose a focused schedule.", agent: "chief", icon: Sun },
    { label: "Summarise recent work", prompt: "Summarise what I worked on recently from my NEXUS task history.", agent: "chief", icon: Calendar },
    { label: "Search my documents", workspace: "knowledge" as const, icon: BookOpen },
    { label: "Review a folder", prompt: "List my approved folders and summarise what's in the most recently indexed one.", agent: "knowledge", icon: FolderOpen },
  ];

  return (
    <div className="mx-auto flex max-w-[980px] flex-col px-8 pb-14 pt-10">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="flex flex-col items-center text-center">
        <Orb state={orb} size={132} level={level} waveform={wave} />
        <p className="mt-6 text-[12px] uppercase tracking-[0.2em] text-muted">
          {longDate(now)} · {clock(now)}
        </p>
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-[30px] font-semibold tracking-tight text-fg">
          {greeting(now, boot?.profile.name || undefined)}
        </h1>
        <p className="mt-1.5 text-[13.5px] text-fg-2">
          {active.length
            ? `${active.length} task${active.length > 1 ? "s" : ""} in progress.`
            : boot?.approvals.length
              ? `${boot.approvals.length} action${boot.approvals.length > 1 ? "s" : ""} waiting for your approval.`
              : "Everything is quiet. What would you like to work on?"}
        </p>
      </motion.div>

      <div className="mx-auto mt-8 w-full max-w-[720px]">
        <Composer
          autoFocus
          onVoiceLevel={(l, w) => {
            setLevel(l);
            setWave(w);
          }}
          onSend={async (text, opts) => {
            await open(null);
            setWorkspace("chat");
            await send(text, opts);
          }}
        />
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {quick.map((q) => {
            const Icon = q.icon;
            return (
              <button
                key={q.label}
                onClick={() => {
                  if (q.workspace) return setWorkspace(q.workspace);
                  void api.post<Task>(`/api/agents/${q.agent}/tasks`, { prompt: q.prompt }).then((t) => focusTask(t.id));
                }}
                className="flex h-8 items-center gap-1.5 rounded-full border border-line-soft bg-white/[0.02] px-3 text-[12px] text-fg-2 transition-colors hover:border-line hover:text-fg"
              >
                <Icon size={13} className="text-muted" /> {q.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[12px] text-fg-2">
        <span className="flex items-center gap-2">
          <Dot tone={boot?.ollama.online ? "ok" : "danger"} /> {boot?.ollama.online ? model ?? "No model selected" : "Ollama offline"}
        </span>
        <span className="flex items-center gap-2">
          <Dot tone={boot?.hermes.status === "ready" ? "ok" : "neutral"} /> Hermes {boot?.hermes.status === "ready" ? `via ${boot.hermes.transport}` : (boot?.hermes.status ?? "…").replace("_", " ")}
        </span>
        {sys && (
          <span className="flex items-center gap-2">
            <Dot tone={pressure?.label === "critical" ? "danger" : pressure?.label === "warning" ? "warn" : "ok"} /> Memory {bytes(sys.memory.used, 0)} / {bytes(sys.memory.total, 0)}
            {pressure?.available && <span className="text-muted">· pressure {pressure.label}</span>}
          </span>
        )}
        <span className="flex items-center gap-2 text-muted">
          <BookOpen size={12} /> {boot?.knowledge.documents ?? 0} documents indexed
        </span>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-8 md:grid-cols-2">
        <section>
          <Header title="Recent tasks" onMore={() => setWorkspace("agents")} />
          {recent.length ? recent.map((t) => <TaskRow key={t.id} task={t} onClick={() => focusTask(t.id)} />) : <Empty title="No tasks yet" body="Ask an agent to do something and its execution timeline appears here." />}
        </section>

        <section>
          <Header title="Active agents" onMore={() => setWorkspace("agents")} />
          {busyAgents.length ? (
            busyAgents.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2">
                <Bot size={14} className="text-accent" />
                <span className="text-[13px] text-fg">{a.name}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{a.current_task?.title}</span>
              </div>
            ))
          ) : (
            <p className="px-2.5 py-2 text-[12.5px] text-muted">
              No agents running. {boot?.agents.length ?? 0} specialists ready — they start only when given a task.
            </p>
          )}
          <Header title="Scheduled" onMore={() => setWorkspace("automations")} className="mt-6" />
          {boot?.automations.upcoming.length ? (
            boot.automations.upcoming.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2">
                <Clock size={14} className="text-muted" />
                <span className="flex-1 truncate text-[13px] text-fg">{a.name}</span>
                <span className="text-[11px] text-muted">{relTime(a.next_run_at)}</span>
              </div>
            ))
          ) : (
            <p className="px-2.5 py-2 text-[12.5px] text-muted">No scheduled automations enabled.</p>
          )}
        </section>

        <section>
          <Header title="Conversations" onMore={() => setWorkspace("chat")} />
          {boot?.conversations.length ? (
            boot.conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  void open(c.id);
                  setWorkspace("chat");
                }}
                className="flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left hover:bg-white/[0.03]"
              >
                <MessageSquare size={14} className="text-muted" />
                <span className="flex-1 truncate text-[13px] text-fg">{c.title}</span>
                <span className="text-[11px] text-muted">{relTime(c.updated_at)}</span>
              </button>
            ))
          ) : (
            <p className="px-2.5 py-2 text-[12.5px] text-muted">Your conversations will appear here.</p>
          )}
        </section>

        <section>
          <Header title="Projects & folders" onMore={() => setWorkspace("knowledge")} />
          {boot?.folders.length ? (
            boot.folders.slice(0, 6).map((f) => (
              <div key={f.id} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2">
                <FolderOpen size={14} className="text-muted" />
                <span className="truncate text-[13px] text-fg">{f.label}</span>
                {f.project && <Badge>{f.project}</Badge>}
                <span className="ml-auto text-[11px] text-muted">{f.last_indexed_at ? `indexed ${relTime(f.last_indexed_at)}` : "not indexed"}</span>
              </div>
            ))
          ) : (
            <button onClick={() => setWorkspace("knowledge")} className="flex items-center gap-1.5 px-2.5 py-2 text-[12.5px] text-fg-2 hover:text-fg">
              Approve a folder to give NEXUS access to your documents <ArrowRight size={12} />
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function Header({ title, onMore, className }: { title: string; onMore?: () => void; className?: string }) {
  return (
    <div className={cls("mb-1.5 flex items-center justify-between px-2.5", className)}>
      <h2 className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted">{title}</h2>
      {onMore && (
        <button onClick={onMore} className="text-[11.5px] text-muted hover:text-fg-2">
          View all
        </button>
      )}
    </div>
  );
}

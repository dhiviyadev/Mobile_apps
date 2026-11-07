import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen, Bot, Brain, Calendar, Check, ChevronLeft, ChevronRight, CircleAlert, Clock, Code2, Cpu, Database, FileText,
  FolderSearch, Hand, Library, Loader2, LogOut, MessageSquarePlus, OctagonX, Play, Search, ShieldQuestion, Sun, Workflow, X, XCircle,
  CheckCircle2,
} from "lucide-react";
import { useCore, activeTasks, EMPTY } from "@/stores/core";
import { useChat } from "@/stores/chat";
import { api, setDeviceToken } from "@/lib/api";
import { bus } from "@/lib/events";
import { Composer } from "@/components/Composer";
import { Markdown } from "@/components/Markdown";
import { Timeline } from "@/components/Timeline";
import { Orb, useOrbState } from "@/components/Orb";
import { Badge, Button, Dot, Empty, Meter, Segmented, Sparkline, Textarea, Toggle } from "@/components/ui";
import { applyAppearance, type Motion } from "@/components/Ambient";
import type { Automation, Memory, SearchResult, SystemSnapshot, Task } from "@/lib/types";
import { bytes, cls, greeting, highlightSegments, longDate, relTime } from "@/lib/format";
import { Sheet, type Tab } from "./MobileApp";

const AGENT_ICONS: Record<string, typeof Bot> = { chief: Bot, researcher: Search, developer: Code2, analyst: Database, knowledge: Library, automation: Workflow };

function Section({ title, children, action, i = 0 }: { title?: string; children: React.ReactNode; action?: React.ReactNode; i?: number }) {
  return (
    <section className="surface rise p-4" style={{ ["--i" as string]: i }}>
      {(title || action) && (
        <div className="mb-2 flex items-center justify-between">
          {title && <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.1em] text-muted">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function TaskLine({ t, onClick }: { t: Task; onClick: () => void }) {
  const icon =
    t.status === "completed" ? <CheckCircle2 size={17} className="text-ok" /> :
    t.status === "failed" ? <XCircle size={17} className="text-danger" /> :
    t.status === "cancelled" ? <XCircle size={17} className="text-muted" /> :
    t.status === "waiting_approval" ? <CircleAlert size={17} className="text-warn" /> :
    <Loader2 size={17} className="animate-spin text-accent" />;
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl px-1 py-2.5 text-left active:bg-white/[0.06]">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14.5px] text-fg">{t.title}</span>
        <span className="text-[12px] text-muted">{t.runtime ?? t.kind} · {relTime(t.created_at)}</span>
      </span>
      <ChevronRight size={16} className="text-muted" />
    </button>
  );
}

function TaskSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const task = useCore((s) => (id ? s.tasks[id] : undefined));
  const text = useCore((s) => (id ? s.taskText[id] : undefined));
  return (
    <Sheet open={Boolean(id)} onClose={onClose} title={task?.title}>
      {id && (
        <div className="space-y-3">
          <Timeline taskId={id} />
          {(task?.result || text) && (
            <div className="surface p-4">
              <Markdown text={task?.result ?? text ?? ""} streaming={!task?.result} />
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

/** Pending approvals as large, deliberate cards. */
function Approvals() {
  const approvals = useCore((s) => s.approvals);
  const decide = useCore((s) => s.decide);
  if (!approvals.length) return null;
  return (
    <div className="space-y-3">
      <AnimatePresence initial={false}>
        {approvals.map((a) => (
          <motion.div
            key={a.id}
            layout
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 60, transition: { duration: 0.2 } }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            className="surface-elevated silver-edge p-4"
          >
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 flex-none place-items-center rounded-full bg-warn/15 text-warn shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]">
                <ShieldQuestion size={19} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium leading-snug text-fg">{a.title}</p>
                {a.detail && <p className="selectable mt-1 line-clamp-5 whitespace-pre-wrap text-[13px] leading-snug text-fg-2">{a.detail}</p>}
                <p className="mt-1.5 text-[11.5px] text-muted">
                  {a.source === "hermes" ? "Hermes · " : ""}
                  {a.kind} · {relTime(a.created_at)}
                </p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2.5">
              <Button variant="secondary" className="h-11 text-[14px]" icon={<X size={15} />} onClick={() => void decide(a.id, false)}>
                Deny
              </Button>
              <Button variant="primary" className="h-11 text-[14px]" icon={<Check size={15} />} onClick={() => void decide(a.id, true)}>
                Approve
              </Button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// -- Home --------------------------------------------------------------------------------
export function MHome({ go }: { go: (t: Tab) => void }) {
  const boot = useCore((s) => s.boot);
  const tasks = useCore((s) => s.tasks);
  const orb = useOrbState();
  const send = useChat((s) => s.send);
  const open = useChat((s) => s.open);
  const [sheet, setSheet] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [wave, setWave] = useState<Uint8Array | null>(null);
  const now = new Date();
  const active = activeTasks(tasks);
  const recent = Object.values(tasks).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 4);

  const quick = [
    { label: "Plan my day", icon: Sun, prompt: "Plan my day: review my open tasks and memories and propose a focused schedule." },
    { label: "What changed?", icon: Calendar, prompt: "Summarise what I worked on recently from my NEXUS task history." },
  ];

  return (
    <div className="m-scroll m-bottom-pad h-full px-4 pt-6">
      <motion.div initial={{ opacity: 0, scale: 0.95, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ type: "spring", stiffness: 170, damping: 22 }} className="flex flex-col items-center text-center">
        <Orb state={orb} size={128} level={level} waveform={wave} />
        <p className="mt-5 text-[11.5px] uppercase tracking-[0.2em] text-muted">{longDate(now)}</p>
        <h1 className="mt-1.5 bg-[linear-gradient(180deg,#ffffff_20%,#b9c0cb_100%)] bg-clip-text font-[family-name:var(--font-display)] text-[27px] font-semibold tracking-tight text-transparent">
          {greeting(now, boot?.profile.name || undefined)}
        </h1>
        <p className="mt-1 text-[14px] text-fg-2">
          {boot?.approvals.length ? boot.approvals.length === 1 ? "1 action needs your OK" : `${boot.approvals.length} actions need your OK` : active.length ? `${active.length} task${active.length > 1 ? "s" : ""} running on your Mac` : "Your Mac is ready."}
        </p>
      </motion.div>

      <div className="mt-5">
        <Approvals />
      </div>

      <div className="rise mt-5" style={{ ["--i" as string]: 2 }}>
        <Composer
          autoSendVoice
          onVoiceLevel={(l, w) => {
            setLevel(l);
            setWave(w);
          }}
          onSend={async (text, opts) => {
            await open(null);
            go("chat");
            await send(text, opts);
          }}
        />
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {quick.map((q) => {
            const Icon = q.icon;
            return (
              <button
                key={q.label}
                onClick={() => void api.post<Task>("/api/agents/chief/tasks", { prompt: q.prompt }).then((t) => setSheet(t.id))}
                className="flex h-9 flex-none items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-3.5 text-[13px] text-fg-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] backdrop-blur-xl"
              >
                <Icon size={14} className="text-muted" /> {q.label}
              </button>
            );
          })}
          <button onClick={() => go("knowledge")} className="flex h-9 flex-none items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-3.5 text-[13px] text-fg-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] backdrop-blur-xl">
            <BookOpen size={14} className="text-muted" /> Search documents
          </button>
        </div>
      </div>

      <div className="mt-5 space-y-3">
        {active.length > 0 && (
          <Section title="Running now" i={3}>
            {active.map((t) => <TaskLine key={t.id} t={t} onClick={() => setSheet(t.id)} />)}
          </Section>
        )}
        <Section title="Your Mac" i={4}>
          <div className="grid grid-cols-2 gap-y-2.5 text-[13px]">
            <span className="flex items-center gap-2 text-fg-2"><Dot tone={boot?.ollama.online ? "ok" : "danger"} /> {boot?.ollama.online ? boot.ollama.running[0] ?? boot.ollama.default_model ?? "No model" : "Ollama offline"}</span>
            <span className="flex items-center gap-2 text-fg-2"><Dot tone={boot?.hermes.status === "ready" ? "ok" : "neutral"} /> Hermes {boot?.hermes.status === "ready" ? "ready" : "off"}</span>
            <span className="flex items-center gap-2 text-fg-2"><FileText size={13} className="text-muted" /> {boot?.knowledge.documents ?? 0} documents</span>
            <span className="flex items-center gap-2 text-fg-2"><Clock size={13} className="text-muted" /> {boot?.automations.upcoming.length ?? 0} scheduled</span>
          </div>
        </Section>
        {recent.length > 0 && (
          <Section title="Recent" i={5} action={<button onClick={() => go("tasks")} className="text-[12.5px] text-muted">All tasks</button>}>
            {recent.map((t) => <TaskLine key={t.id} t={t} onClick={() => setSheet(t.id)} />)}
          </Section>
        )}
      </div>
      <TaskSheet id={sheet} onClose={() => setSheet(null)} />
    </div>
  );
}

// -- Chat ----------------------------------------------------------------------------------
export function MChat() {
  const { conversations, activeId, messages, streaming, pendingTask, loadList, open, newConversation, send, stop, error } = useChat();
  useEffect(() => void loadList(), [loadList]);
  const list = activeId ? messages[activeId] ?? [] : [];
  const live = streaming && streaming.conversationId === activeId ? streaming : null;
  const pending = activeId ? pendingTask[activeId] : undefined;
  const conv = conversations.find((c) => c.id === activeId);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: live ? "auto" : "smooth" });
  }, [list.length, live?.text, pending]);

  return (
    <div className="relative h-full overflow-hidden">
      <AnimatePresence initial={false} mode="popLayout">
        {!activeId ? (
          <motion.div key="list" initial={{ x: "-25%", opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: "-25%", opacity: 0 }} transition={{ type: "spring", stiffness: 380, damping: 38 }} className="m-scroll m-bottom-pad absolute inset-0 px-4 pt-4">
            <Button variant="primary" className="h-11 w-full text-[14.5px]" icon={<MessageSquarePlus size={16} />} onClick={() => void newConversation()}>
              New conversation
            </Button>
            <div className="mt-4 space-y-2">
              {conversations.map((c, i) => (
                <button key={c.id} onClick={() => void open(c.id)} style={{ ["--i" as string]: i }} className="surface rise flex w-full items-center gap-3 p-3.5 text-left">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] text-fg">{c.title}</p>
                    <p className="text-[12px] text-muted">{relTime(c.updated_at)} · {c.message_count ?? 0} messages</p>
                  </div>
                  <ChevronRight size={16} className="text-muted" />
                </button>
              ))}
              {conversations.length === 0 && <Empty title="No conversations yet" body="Start one — it runs on your Mac and appears there too." />}
            </div>
          </motion.div>
        ) : (
          <motion.div key="thread" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", stiffness: 380, damping: 38 }} className="absolute inset-0 flex flex-col">
            <div className="glass-chrome relative z-10 flex h-12 flex-none items-center gap-2 border-b border-white/[0.06] px-2">
              <button onClick={() => void open(null)} className="flex h-10 items-center gap-0.5 rounded-full px-2 text-[15px] text-accent-strong">
                <ChevronLeft size={20} /> Chats
              </button>
              <p className="min-w-0 flex-1 truncate text-center text-[14px] font-medium text-fg">{conv?.title ?? "New conversation"}</p>
              <span className="w-[70px]" />
            </div>
            <div ref={scroller} className="m-scroll min-h-0 flex-1 px-4 py-4">
              {list.map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="rise mb-4 flex justify-end">
                    <div className="selectable max-w-[85%] whitespace-pre-wrap rounded-[22px] rounded-br-[7px] border border-white/[0.12] bg-[linear-gradient(180deg,rgba(255,255,255,0.14),rgba(255,255,255,0.06))] px-4 py-2.5 text-[15px] leading-relaxed text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-xl">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="rise mb-5">
                    {m.metadata.sources && m.metadata.sources.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {m.metadata.sources.map((s, i) => (
                          <span key={i} className="inline-flex h-6 items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-2.5 text-[11px] text-fg-2">
                            <span className="text-muted">[{i + 1}]</span> {s.title}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="text-[15px]">
                      <Markdown text={m.content || "_(empty response)_"} />
                    </div>
                    {m.metadata.metrics?.tokens_per_s && <p className="mt-1 text-[11px] text-muted">{m.model} · {m.metadata.metrics.tokens_per_s} tok/s</p>}
                  </div>
                ),
              )}
              {live && (
                <>
                  {live.userText && (
                    <div className="mb-4 flex justify-end">
                      <div className="max-w-[85%] whitespace-pre-wrap rounded-[22px] rounded-br-[7px] border border-white/[0.12] bg-white/[0.1] px-4 py-2.5 text-[15px] text-fg">{live.userText}</div>
                    </div>
                  )}
                  <div className="mb-5 text-[15px]">
                    {live.text ? <Markdown text={live.text} streaming /> : <p className="shimmer text-[14px]">{live.status === "loading_model" ? "Loading model on your Mac…" : "Thinking…"}</p>}
                  </div>
                </>
              )}
              {pending && <Timeline taskId={pending} compact />}
              {error && <p className="text-[13px] text-danger">{error}</p>}
              <div className="h-[calc(var(--tabbar-h)+max(var(--safe-bottom),8px)+96px)]" />
            </div>
            <div className="absolute inset-x-0 bottom-[calc(var(--tabbar-h)+max(var(--safe-bottom),8px)+8px)] z-20 px-3">
              <Composer compact busy={Boolean(live || pending)} onStop={() => void stop()} onSend={(t, o) => send(t, o)} autoSendVoice={false} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// -- Tasks / agents ------------------------------------------------------------------------
export function MTasks() {
  const agents = useCore((s) => s.boot?.agents ?? EMPTY);
  const tasksMap = useCore((s) => s.tasks);
  const [agent, setAgent] = useState("chief");
  const [prompt, setPrompt] = useState("");
  const [view, setView] = useState<"active" | "recent">("active");
  const [sheet, setSheet] = useState<string | null>(null);
  const [recent, setRecent] = useState<Task[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => void api.get<Task[]>("/api/tasks?limit=40").then(setRecent), [tasksMap]);
  const active = activeTasks(tasksMap);
  const shown = view === "active" ? active : recent;

  const run = async () => {
    setErr(null);
    try {
      const t = await api.post<Task>(`/api/agents/${agent}/tasks`, { prompt });
      setPrompt("");
      setSheet(t.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="m-scroll m-bottom-pad h-full space-y-3 px-4 pt-4">
      <Section title="Ask an agent">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
          {agents.filter((a) => a.enabled).map((a) => {
            const Icon = AGENT_ICONS[a.id] ?? Bot;
            const on = agent === a.id;
            return (
              <button
                key={a.id}
                onClick={() => setAgent(a.id)}
                className={cls("relative flex h-[74px] w-[86px] flex-none flex-col items-center justify-center gap-1.5 rounded-2xl border text-[11.5px]", on ? "border-white/25 text-fg" : "border-white/[0.07] text-fg-2")}
              >
                {on && <motion.span layoutId="m-agent" transition={{ type: "spring", stiffness: 480, damping: 36 }} className="absolute inset-0 rounded-2xl bg-white/[0.1] shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]" />}
                <Icon size={19} className={cls("relative", on && "text-accent-strong")} />
                <span className="relative leading-tight">{a.name.replace(" Agent", "")}</span>
                {a.status === "busy" && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-ok" />}
              </button>
            );
          })}
        </div>
        <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should it do on your Mac?" className="rounded-2xl" />
        <Button variant="primary" className="mt-2.5 h-11 w-full text-[14.5px]" icon={<Play size={14} />} disabled={!prompt.trim()} onClick={() => void run()}>
          Run on my Mac
        </Button>
        {err && <p className="mt-2 text-[13px] text-danger">{err}</p>}
      </Section>
      <div className="flex justify-center">
        <Segmented value={view} onChange={setView} options={[{ value: "active", label: `Running (${active.length})` }, { value: "recent", label: "History" }]} />
      </div>
      <Section>
        {shown.length ? shown.map((t) => <TaskLine key={t.id} t={t} onClick={() => setSheet(t.id)} />) : <Empty title={view === "active" ? "Nothing running" : "No tasks yet"} />}
      </Section>
      <TaskSheet id={sheet} onClose={() => setSheet(null)} />
    </div>
  );
}

// -- Knowledge & memory --------------------------------------------------------------------
export function MKnowledge() {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ results: SearchResult[]; mode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [mems, setMems] = useState<Memory[]>([]);
  const refresh = useCore((s) => s.refresh);
  const loadMems = () => void api.get<Memory[]>("/api/memories?status=proposed").then(setMems);
  useEffect(loadMems, []);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      setRes(await api.post("/api/knowledge/search", { query: q, limit: 12 }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-scroll m-bottom-pad h-full space-y-3 px-4 pt-4">
      <div className="surface flex items-center gap-2 p-2 pl-4">
        <Search size={17} className="text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          enterKeyHint="search"
          placeholder="Search your documents"
          className="h-10 min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted"
        />
        {busy && <Loader2 size={16} className="animate-spin text-muted" />}
      </div>
      {res && <p className="px-1 text-[12px] text-muted">{res.results.length} result{res.results.length === 1 ? "" : "s"} · {res.mode}</p>}
      {res?.results.map((r, i) => (
        <div key={r.chunk_id} className="surface rise p-4" style={{ ["--i" as string]: i }}>
          <p className="flex items-center gap-2 text-[14.5px] font-medium text-fg">
            <FileText size={14} className="text-muted" /> <span className="truncate">{r.title}</span> <Badge>{r.ext.replace(".", "")}</Badge>
          </p>
          {r.location && <p className="text-[12px] text-muted">{r.location}</p>}
          <p className="selectable mt-1.5 text-[13.5px] leading-relaxed text-fg-2">
            {highlightSegments(r.snippet).map((s, k) => (s.hit ? <mark key={k} className="rounded bg-accent/25 px-0.5 text-fg">{s.text}</mark> : <span key={k}>{s.text}</span>))}
          </p>
        </div>
      ))}
      {!res && (
        <Section title="Memory to review" i={1} action={<Brain size={15} className="text-muted" />}>
          {mems.length === 0 ? (
            <p className="text-[13.5px] text-muted">Nothing waiting. Suggested memories appear here for your OK before NEXUS uses them.</p>
          ) : (
            <AnimatePresence initial={false}>
              {mems.map((m) => (
                <motion.div key={m.id} layout exit={{ opacity: 0, x: 50 }} className="flex items-start gap-3 border-b border-white/[0.06] py-3 last:border-0">
                  <Badge tone="warn">{m.category}</Badge>
                  <p className="min-w-0 flex-1 text-[14px] text-fg">{m.content}</p>
                  <button aria-label="Approve" onClick={() => void api.patch(`/api/memories/${m.id}`, { status: "active" }).then(() => { loadMems(); void refresh(); })} className="grid h-9 w-9 place-items-center rounded-full bg-ok/15 text-ok">
                    <Check size={16} />
                  </button>
                  <button aria-label="Reject" onClick={() => void api.del(`/api/memories/${m.id}`).then(() => { loadMems(); void refresh(); })} className="grid h-9 w-9 place-items-center rounded-full bg-white/[0.06] text-fg-2">
                    <X size={16} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </Section>
      )}
    </div>
  );
}

// -- Your Mac: system, automations, controls -----------------------------------------------
export function MMore() {
  const [snap, setSnap] = useState<SystemSnapshot | null>(null);
  const [hist, setHist] = useState<number[]>([]);
  const [autos, setAutos] = useState<Automation[]>([]);
  const halted = useCore((s) => s.halted);
  const emergencyStop = useCore((s) => s.emergencyStop);
  const resume = useCore((s) => s.resume);
  const [confirm, setConfirm] = useState(false);
  const [motion_, setMotion] = useState<Motion>((document.documentElement.dataset.motion as Motion) ?? "full");

  const load = () => {
    void api.get<SystemSnapshot>("/api/system/status").then((s) => {
      setSnap(s);
      setHist(s.history.map((h) => h.memory_percent));
    });
    void api.get<Automation[]>("/api/automations").then(setAutos);
  };
  useEffect(() => {
    load();
    const off = bus.on<{ memory_percent: number }>("system.sample", (e) => setHist((h) => [...h.slice(-59), e.data.memory_percent]));
    const t = setInterval(load, 20000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  const hw = (snap?.hardware ?? {}) as Record<string, string | number | null>;
  const model = snap?.services.ollama.loaded_models[0];

  return (
    <div className="m-scroll m-bottom-pad h-full space-y-3 px-4 pt-4">
      <Section title={String(hw.chip ?? hw.model ?? "Your Mac")} i={0}>
        {snap ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="CPU" value={`${Math.round(snap.cpu.percent)}%`} />
              <Stat label="Memory" value={`${Math.round(snap.memory.percent)}%`} />
              <Stat label="Pressure" value={snap.memory.pressure.available ? snap.memory.pressure.label : "—"} />
            </div>
            <div className="mt-3"><Sparkline values={hist} height={42} /></div>
            <div className="mt-3 space-y-1.5 text-[13px] text-fg-2">
              <p className="flex items-center gap-2"><Cpu size={14} className="text-muted" /> {model ? `${model.name} · ${bytes(model.size)} in memory` : "No model loaded"}</p>
              {snap.inference.avg_tokens_per_s && <p className="flex items-center gap-2"><Play size={14} className="text-muted" /> {snap.inference.avg_tokens_per_s} tok/s average</p>}
              <p className="flex items-center gap-2"><Database size={14} className="text-muted" /> {bytes(snap.disk.free)} free</p>
            </div>
            <div className="mt-3"><Meter value={snap.memory.percent} /></div>
          </>
        ) : (
          <Loader2 size={16} className="animate-spin text-muted" />
        )}
      </Section>

      <Section title="Automations" i={1}>
        {autos.length === 0 && <p className="text-[13.5px] text-muted">None yet — create them on your Mac.</p>}
        {autos.map((a) => (
          <div key={a.id} className="flex items-center gap-3 border-b border-white/[0.06] py-3 last:border-0">
            <div className="grid h-9 w-9 flex-none place-items-center rounded-full border border-white/10 bg-white/[0.06]">
              {a.trigger.type === "schedule" ? <Clock size={15} /> : a.trigger.type === "file" ? <FolderSearch size={15} /> : <Hand size={15} />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14.5px] text-fg">{a.name}</p>
              <p className="truncate text-[12px] text-muted">{a.enabled && a.next_run_at ? `next ${relTime(a.next_run_at)}` : a.trigger.type}{a.last_run ? ` · last ${a.last_run.status}` : ""}</p>
            </div>
            <button aria-label={`Run ${a.name}`} onClick={() => void api.post(`/api/automations/${a.id}/run`).then(load)} className="grid h-9 w-9 place-items-center rounded-full bg-white/[0.08] text-fg">
              <Play size={14} />
            </button>
            <Toggle checked={a.enabled} onChange={(v) => void api.patch(`/api/automations/${a.id}`, { enabled: v }).then(load)} label="Enabled" />
          </div>
        ))}
      </Section>

      <Section title="Controls" i={2}>
        {halted ? (
          <Button variant="primary" className="h-12 w-full text-[15px]" icon={<Play size={15} />} onClick={() => void resume()}>
            Resume NEXUS
          </Button>
        ) : confirm ? (
          <div className="grid grid-cols-2 gap-2.5">
            <Button variant="secondary" className="h-12 text-[14.5px]" onClick={() => setConfirm(false)}>Cancel</Button>
            <button onClick={() => void emergencyStop().then(() => setConfirm(false))} className="m-stop h-12 rounded-full text-[14.5px] font-semibold text-[#ffd9d9]">
              Stop everything
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirm(true)} className="m-stop flex h-12 w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold text-[#ffd9d9]">
            <OctagonX size={17} /> Emergency stop
          </button>
        )}
        <p className="mt-2 text-[12px] leading-snug text-muted">Cancels every running task on your Mac and denies all pending actions.</p>
        <div className="mt-4 flex items-center justify-between border-t border-white/[0.06] pt-4">
          <div>
            <p className="text-[14.5px] text-fg">Calm motion</p>
            <p className="text-[12px] text-muted">Freeze the background light on this phone</p>
          </div>
          <Toggle
            checked={motion_ === "calm"}
            onChange={(v) => {
              const m: Motion = v ? "calm" : "full";
              setMotion(m);
              applyAppearance((document.documentElement.dataset.material as "ambient") ?? "ambient", m);
            }}
          />
        </div>
        <button
          onClick={() => {
            setDeviceToken(null);
            window.location.reload();
          }}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-full border border-white/10 py-3 text-[14px] text-fg-2"
        >
          <LogOut size={15} /> Unpair this phone
        </button>
      </Section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-black/20 p-3 text-center">
      <p className="text-[10.5px] uppercase tracking-[0.1em] text-muted">{label}</p>
      <p className="mt-0.5 truncate font-[family-name:var(--font-display)] text-[19px] font-semibold capitalize text-fg">{value}</p>
    </div>
  );
}


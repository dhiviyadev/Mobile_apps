import { useEffect, useState } from "react";
import { Bot, Code2, Cpu, Database, Library, Loader2, Play, Search, ShieldCheck, Workflow } from "lucide-react";
import { useCore, EMPTY } from "@/stores/core";
import { api } from "@/lib/api";
import type { Agent, HermesStatus, Task } from "@/lib/types";
import { Badge, Button, Card, Dot, Empty, SectionTitle, Segmented, Select, Textarea, Toggle } from "@/components/ui";
import { Timeline } from "@/components/Timeline";
import { TaskRow } from "./Home";
import { cls, relTime } from "@/lib/format";

const ICONS: Record<string, typeof Bot> = { chief: Bot, researcher: Search, developer: Code2, analyst: Database, knowledge: Library, automation: Workflow };

interface Tool {
  name: string;
  description: string;
  access: string;
}

interface AgentDetail extends Agent {
  history: Task[];
  tool_usage: { tool: string; completed: number; failed: number; denied: number }[];
}

export function Agents() {
  const agents = useCore((s) => s.boot?.agents ?? EMPTY);
  const refresh = useCore((s) => s.refresh);
  const focusTask = useCore((s) => s.focusTask);
  const [sel, setSel] = useState<string>("chief");
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [hermes, setHermes] = useState<HermesStatus | null>(null);
  const [prompt, setPrompt] = useState("");
  const [runtime, setRuntime] = useState<"auto" | "hermes" | "native">("auto");
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);

  const load = (id: string) => void api.get<AgentDetail>(`/api/agents/${id}`).then(setDetail);
  useEffect(() => {
    void api.get<Tool[]>("/api/tools").then(setTools);
    void api.get<HermesStatus>("/api/hermes/status").then(setHermes).catch(() => undefined);
    void api.get<{ categories: string[] }>("/api/models").then((m) => setCategories(m.categories)).catch(() => undefined);
  }, []);
  useEffect(() => load(sel), [sel, agents]);

  const patch = async (body: Partial<Agent>) => {
    const a = await api.patch<Agent>(`/api/agents/${sel}`, body);
    setDetail((d) => (d ? { ...d, ...a } : d));
    void refresh();
  };

  const run = async () => {
    setErr(null);
    try {
      const t = await api.post<Task>(`/api/agents/${sel}/tasks`, { prompt, runtime: runtime === "auto" ? null : runtime });
      setPrompt("");
      setOpenTask(t.id);
      focusTask(null);
      load(sel);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-[1180px] px-8 py-8">
      <SectionTitle title="Agents" sub="Specialist configurations. They run one at a time, only when given a task — nothing sits idle in memory." />

      <HermesCard st={hermes} />

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
        {agents.map((a) => {
          const Icon = ICONS[a.id] ?? Bot;
          return (
            <button
              key={a.id}
              onClick={() => setSel(a.id)}
              className={cls("surface silver-edge p-4 text-left transition-colors", sel === a.id ? "border-[#3d424d] bg-elevated" : "hover:bg-[#21242b]")}
            >
              <div className="flex items-center justify-between">
                <div className="grid h-8 w-8 place-items-center rounded-[10px] border border-line bg-white/[0.03]">
                  <Icon size={15} className="text-accent" />
                </div>
                <span className="flex items-center gap-1.5 text-[11px] text-muted">
                  <Dot tone={a.status === "busy" ? "ok" : a.status === "disabled" ? "danger" : "neutral"} pulse={a.status === "busy"} />
                  {a.status}
                </span>
              </div>
              <p className="mt-3 text-[13.5px] font-medium text-fg">{a.name}</p>
              <p className="text-[12px] text-muted">{a.role}</p>
              <p className="mt-2 line-clamp-2 text-[12px] leading-snug text-fg-2">{a.current_task ? `Working on: ${a.current_task.title}` : a.description}</p>
              <p className="mt-3 text-[11px] text-muted">
                {a.stats.runs} runs · {a.stats.failed} failed{a.stats.last_run_at ? ` · last ${relTime(a.stats.last_run_at)}` : ""}
              </p>
            </button>
          );
        })}
      </div>

      {detail && (
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[1.25fr_1fr]">
          <div className="space-y-4">
            <Card title={`Give ${detail.name} a task`}>
              <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={`e.g. ${placeholderFor(detail.id)}`} />
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <Segmented
                  value={runtime}
                  onChange={setRuntime}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "hermes", label: "Hermes" },
                    { value: "native", label: "NEXUS native" },
                  ]}
                />
                <Button variant="primary" icon={<Play size={12} />} disabled={!prompt.trim() || !detail.enabled} onClick={() => void run()}>
                  Run task
                </Button>
              </div>
              {err && <p className="mt-2 text-[12px] text-danger">{err}</p>}
            </Card>
            {openTask && <Timeline taskId={openTask} />}
            <Card title="Execution history" pad>
              {detail.history.length ? (
                <div className="-mx-2">
                  {detail.history.map((t) => (
                    <TaskRow key={t.id} task={t} onClick={() => setOpenTask(t.id)} />
                  ))}
                </div>
              ) : (
                <Empty title="No runs yet" />
              )}
            </Card>
          </div>

          <div className="space-y-4">
            <Card title="Configuration" action={<Toggle checked={detail.enabled} onChange={(v) => void patch({ enabled: v })} label="Enabled" />}>
              <div className="space-y-3">
                <Row label="Runtime preference">
                  <Select
                    value={detail.runtime_pref}
                    onChange={(v) => void patch({ runtime_pref: v as Agent["runtime_pref"] })}
                    options={[
                      { value: "auto", label: "Auto (Hermes, fall back to native)" },
                      { value: "hermes", label: "Hermes only" },
                      { value: "native", label: "NEXUS native only" },
                    ]}
                  />
                </Row>
                <Row label="Model category">
                  <Select value={detail.model_category} onChange={(v) => void patch({ model_category: v })} options={categories.filter((c) => c !== "embeddings").map((c) => ({ value: c, label: c }))} />
                </Row>
                <div>
                  <p className="mb-1.5 text-[12px] text-fg-2">System prompt</p>
                  <PromptEditor key={detail.id} value={detail.system_prompt} onSave={(v) => void patch({ system_prompt: v })} />
                </div>
              </div>
            </Card>

            <Card title={<span className="flex items-center gap-1.5"><ShieldCheck size={12} /> Permissions — NEXUS native tools</span>}>
              <div className="space-y-1.5">
                {tools.map((t) => {
                  const on = detail.tools.includes(t.name);
                  return (
                    <div key={t.name} className="flex items-center gap-3">
                      <Toggle checked={on} onChange={(v) => void patch({ tools: v ? [...detail.tools, t.name] : detail.tools.filter((x) => x !== t.name) })} label={t.name} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] text-fg">{t.name}</p>
                        <p className="truncate text-[11px] text-muted">{t.description}</p>
                      </div>
                      <Badge tone={t.access === "execute" ? "warn" : t.access === "write" ? "accent" : "neutral"}>{t.access}</Badge>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[11.5px] leading-snug text-muted">
                Write and execute tools still require your approval for overwrites, deletions, scripts and app launches. Access is limited to approved folders.
              </p>
              <div className="mt-3 border-t border-line-soft pt-3">
                <p className="text-[12px] text-fg-2">Hermes toolsets</p>
                <p className="mt-0.5 text-[11.5px] text-muted">
                  {detail.hermes_toolsets.length ? detail.hermes_toolsets.join(", ") : "Hermes defaults"} — when an agent runs on Hermes, Hermes' own tool approvals apply and are relayed here.
                </p>
              </div>
            </Card>

            {detail.tool_usage.length > 0 && (
              <Card title="Tool usage">
                {detail.tool_usage.map((u) => (
                  <div key={u.tool} className="flex items-center justify-between py-1 text-[12.5px]">
                    <span className="text-fg-2">{u.tool}</span>
                    <span className="text-muted">
                      {u.completed} ok · {u.failed} failed · {u.denied} denied
                    </span>
                  </div>
                ))}
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function placeholderFor(id: string): string {
  return (
    {
      chief: "Plan my week around the Falcon launch",
      researcher: "Compare the three vendor proposals in my REstack folder",
      developer: "Explain how authentication works in my api project",
      analyst: "Summarise revenue by region from sales-2026.xlsx",
      knowledge: "What did we decide about pricing in the Q3 notes?",
      automation: "Rename every invoice PDF in Inbox to supplier-date.pdf",
    }[id] ?? "Describe the task"
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-fg-2">{label}</span>
      {children}
    </div>
  );
}

function PromptEditor({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <div>
      <Textarea rows={5} value={v} onChange={(e) => setV(e.target.value)} className="font-mono text-[12px]" />
      {v !== value && (
        <div className="mt-1.5 flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setV(value)}>
            Revert
          </Button>
          <Button size="sm" variant="primary" onClick={() => onSave(v)}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

export function HermesCard({ st }: { st: HermesStatus | null }) {
  if (!st) {
    return (
      <div className="surface flex items-center gap-2 p-4 text-[12.5px] text-muted">
        <Loader2 size={13} className="animate-spin" /> Checking Hermes…
      </div>
    );
  }
  const tone = st.status === "ready" ? "ok" : st.status === "installed" ? "warn" : "neutral";
  return (
    <div className="surface silver-edge flex flex-wrap items-center gap-x-8 gap-y-3 p-4">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-[10px] border border-line bg-white/[0.03]">
          <Cpu size={16} className="text-accent" />
        </div>
        <div>
          <p className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
            Hermes Agent <Badge tone={tone === "ok" ? "ok" : tone === "warn" ? "warn" : "neutral"}>{st.status.replace("_", " ")}</Badge>
          </p>
          <p className="text-[12px] text-muted">{st.version ?? (st.cli_path ? "version unknown" : "CLI not found on PATH")}</p>
        </div>
      </div>
      <Info label="Transport" value={st.transport ? (st.transport === "api" ? "API server (runs + SSE)" : "CLI stream-json") : "—"} />
      <Info label="API server" value={st.api_reachable ? (st.api_authenticated ? "connected" : st.has_api_key ? "key rejected" : "running · no key in NEXUS") : "not running"} />
      <Info label="Model" value={st.config?.model ? `${st.config.model.provider ?? ""} ${st.config.model.default ?? ""}`.trim() || "—" : "—"} />
      {st.status !== "ready" && (
        <p className="basis-full text-[11.5px] text-muted">
          Agents fall back to the NEXUS native runtime (Ollama tool-calling). To use Hermes, enable its API server (see SETUP.md) and add the API key in Settings → Hermes. NEXUS never edits ~/.hermes.
        </p>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10.5px] uppercase tracking-[0.1em] text-muted">{label}</p>
      <p className="text-[12.5px] text-fg-2">{value}</p>
    </div>
  );
}

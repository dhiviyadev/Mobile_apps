import { useEffect, useState } from "react";
import { ArrowDown, Clock, FolderSearch, Hand, Play, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { bus } from "@/lib/events";
import { useCore, EMPTY } from "@/stores/core";
import type { Automation, AutomationRun, Folder } from "@/lib/types";
import { Badge, Button, Card, Empty, IconButton, Input, SectionTitle, Select, Textarea, Toggle } from "@/components/ui";
import { Timeline } from "@/components/Timeline";
import { cls, duration, relTime } from "@/lib/format";

type Template = Omit<Automation, "id" | "enabled" | "last_run_at" | "next_run_at"> & { template: string };

const ACTION_TYPES: { value: string; label: string }[] = [
  { value: "agent_task", label: "Run an agent task" },
  { value: "prompt", label: "Ask the local model" },
  { value: "write_file", label: "Write a file (workspace)" },
  { value: "append_file", label: "Append to a file (workspace)" },
  { value: "notify", label: "Send a notification" },
  { value: "reindex_folder", label: "Re-index a folder" },
  { value: "reindex_all", label: "Re-index all folders" },
  { value: "run_script", label: "Run an approved script" },
];

function triggerText(a: Pick<Automation, "trigger" | "schedule_text">, folders: Folder[]): string {
  if (a.trigger.type === "manual") return "Manual";
  if (a.trigger.type === "schedule") return a.schedule_text ?? a.trigger.cron ?? "Schedule";
  const f = folders.find((x) => x.id === a.trigger.folder_id);
  return `New files in ${f?.label ?? "folder"}${a.trigger.patterns?.length ? ` (${a.trigger.patterns.join(", ")})` : ""}`;
}

export function Automations() {
  const [items, setItems] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Partial<Automation> | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const folders = useCore((s) => s.boot?.folders ?? EMPTY);

  const load = () => {
    void api.get<Automation[]>("/api/automations").then(setItems);
    void api.get<AutomationRun[]>("/api/automations/runs?limit=30").then(setRuns);
  };
  useEffect(() => {
    load();
    void api.get<Template[]>("/api/automations/templates").then(setTemplates);
    const off = bus.on("automation", () => load());
    return () => off();
  }, []);

  return (
    <div className="mx-auto max-w-[1120px] px-8 py-8">
      <SectionTitle
        title="Automations"
        sub="Repeatable workflows with manual, scheduled and folder triggers. New automations start disabled; steps that change things still ask for approval."
        action={<Button variant="primary" icon={<Plus size={13} />} onClick={() => setEditing({ name: "", description: "", trigger: { type: "manual" }, actions: [{ type: "agent_task", agent_id: "chief", prompt: "" }], requires_approval: true, conditions: [], failure_policy: { retries: 0, notify: true } })}>New automation</Button>}
      />

      {editing && <Editor initial={editing} folders={folders} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-2">
          {items.length === 0 && <div className="surface"><Empty icon={<Clock size={22} />} title="No automations yet" body="Start from a template on the right, or create your own." /></div>}
          {items.map((a) => (
            <div key={a.id} className="surface group p-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 grid h-8 w-8 flex-none place-items-center rounded-[10px] border border-line bg-white/[0.03]">
                  {a.trigger.type === "schedule" ? <Clock size={14} className="text-accent" /> : a.trigger.type === "file" ? <FolderSearch size={14} className="text-accent" /> : <Hand size={14} className="text-accent" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
                    {a.name}
                    {a.requires_approval && <Badge><ShieldCheck size={10} /> approval</Badge>}
                    {a.last_run && <Badge tone={a.last_run.status === "completed" ? "ok" : a.last_run.status === "failed" ? "danger" : "neutral"}>{a.last_run.status}</Badge>}
                  </p>
                  <p className="text-[12px] text-fg-2">{a.description}</p>
                  <p className="mt-1.5 text-[11.5px] text-muted">
                    {triggerText(a, folders)} · {a.actions.length} step{a.actions.length > 1 ? "s" : ""}
                    {a.enabled && a.next_run_at ? ` · next ${relTime(a.next_run_at)}` : ""}
                    {a.last_run_at ? ` · last ran ${relTime(a.last_run_at)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" icon={<Play size={11} />} onClick={() => void api.post<{ task_id: string }>(`/api/automations/${a.id}/run`).then((r) => { setOpenRun(r.task_id); load(); })}>
                    Run
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>
                    Edit
                  </Button>
                  <Toggle checked={a.enabled} onChange={(v) => void api.patch(`/api/automations/${a.id}`, { enabled: v }).then(load)} label="Enabled" />
                </div>
              </div>
            </div>
          ))}
          {openRun && (
            <div className="relative">
              <IconButton label="Close" className="absolute right-2 top-2 z-10" onClick={() => setOpenRun(null)}>
                <X size={13} />
              </IconButton>
              <Timeline taskId={openRun} />
            </div>
          )}
          <Card title="Execution history" className="mt-4">
            {runs.length === 0 ? (
              <p className="text-[12.5px] text-muted">No runs yet.</p>
            ) : (
              <div className="-mx-1">
                {runs.map((r) => (
                  <button key={r.id} onClick={() => r.task_id && setOpenRun(r.task_id)} className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.03]">
                    <Badge tone={r.status === "completed" ? "ok" : r.status === "failed" ? "danger" : r.status === "running" ? "accent" : "neutral"}>{r.status}</Badge>
                    <span className="flex-1 truncate text-[12.5px] text-fg">{r.automation_name}</span>
                    <span className="text-[11px] text-muted">{r.trigger_reason}</span>
                    <span className="w-16 text-right text-[11px] text-muted">{duration(r.started_at, r.finished_at)}</span>
                    <span className="w-16 text-right text-[11px] text-muted">{relTime(r.started_at)}</span>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div>
          <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-[0.1em] text-muted">Templates</p>
          <div className="space-y-2">
            {templates.map((t) => (
              <button key={t.template} onClick={() => setEditing({ ...t, conditions: t.conditions ?? [] })} className="surface w-full p-3.5 text-left transition-colors hover:bg-[#21242b]">
                <p className="text-[13px] font-medium text-fg">{t.name}</p>
                <p className="mt-0.5 text-[12px] leading-snug text-fg-2">{t.description}</p>
                <p className="mt-1.5 text-[11px] text-muted">{t.trigger.type === "schedule" ? t.trigger.cron : t.trigger.type} · {t.actions.map((x) => x.type.replace("_", " ")).join(" → ")}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Editor({ initial, folders, onClose, onSaved }: { initial: Partial<Automation>; folders: Folder[]; onClose: () => void; onSaved: () => void }) {
  const [a, setA] = useState<Partial<Automation>>(initial);
  const [err, setErr] = useState<string | null>(null);
  const agents = useCore((s) => s.boot?.agents ?? EMPTY);
  const trig = a.trigger ?? { type: "manual" };
  const actions = a.actions ?? [];
  const setAction = (i: number, patch: Record<string, unknown>) => setA({ ...a, actions: actions.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  const save = async () => {
    setErr(null);
    try {
      const body = { name: a.name, description: a.description, trigger: a.trigger, conditions: a.conditions ?? [], actions, requires_approval: a.requires_approval, failure_policy: a.failure_policy, template: a.template ?? null };
      if (a.id) await api.patch(`/api/automations/${a.id}`, body);
      else await api.post("/api/automations", body);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="surface-elevated silver-edge mb-6 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[14px] font-medium text-fg">{a.id ? "Edit automation" : "New automation"}</h3>
        <IconButton label="Close" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input value={a.name ?? ""} onChange={(e) => setA({ ...a, name: e.target.value })} placeholder="Name" />
        <Input value={a.description ?? ""} onChange={(e) => setA({ ...a, description: e.target.value })} placeholder="Description" />
      </div>

      <p className="mb-1.5 mt-4 text-[11px] font-medium uppercase tracking-[0.1em] text-muted">Trigger</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={trig.type} onChange={(v) => setA({ ...a, trigger: v === "schedule" ? { type: "schedule", cron: "30 8 * * 1-5" } : v === "file" ? { type: "file", folder_id: folders[0]?.id ?? "", events: ["created"], patterns: ["*.pdf"] } : { type: "manual" } })}
          options={[{ value: "manual", label: "Manual" }, { value: "schedule", label: "Schedule (cron)" }, { value: "file", label: "New files in a folder" }]} />
        {trig.type === "schedule" && (
          <>
            <Input value={trig.cron ?? ""} onChange={(e) => setA({ ...a, trigger: { ...trig, cron: e.target.value } })} className="w-44 font-mono text-[12px]" placeholder="m h dom mon dow" />
            <span className="text-[11.5px] text-muted">minute hour day month weekday · local time · e.g. “30 8 * * 1-5” = weekdays 08:30</span>
          </>
        )}
        {trig.type === "file" && (
          <>
            <Select value={trig.folder_id ?? ""} onChange={(v) => setA({ ...a, trigger: { ...trig, folder_id: v } })} placeholder="Choose approved folder" options={folders.map((f) => ({ value: f.id, label: f.label }))} />
            <Input value={(trig.patterns ?? []).join(", ")} onChange={(e) => setA({ ...a, trigger: { ...trig, patterns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } })} className="w-48 font-mono text-[12px]" placeholder="*.pdf, *.docx" />
          </>
        )}
      </div>

      <p className="mb-1.5 mt-4 text-[11px] font-medium uppercase tracking-[0.1em] text-muted">Steps</p>
      <div className="space-y-2">
        {actions.map((act, i) => (
          <div key={i}>
            {i > 0 && <ArrowDown size={12} className="mx-auto mb-2 text-muted" />}
            <div className="rounded-xl border border-line bg-[#191b20] p-3">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted">{i + 1}</span>
                <Select value={act.type} onChange={(v) => setA({ ...a, actions: actions.map((x, j) => (j === i ? { type: v } : x)) })} options={ACTION_TYPES} />
                {act.type === "agent_task" && <Select value={String(act.agent_id ?? "chief")} onChange={(v) => setAction(i, { agent_id: v })} options={agents.map((g) => ({ value: g.id, label: g.name }))} />}
                {act.type === "reindex_folder" && <Select value={String(act.folder_id ?? "")} onChange={(v) => setAction(i, { folder_id: v })} placeholder="Folder" options={folders.map((f) => ({ value: f.id, label: f.label }))} />}
                {act.type === "run_script" && <Input value={String(act.name ?? "")} onChange={(e) => setAction(i, { name: e.target.value })} placeholder="Script name" className="w-48" />}
                <IconButton label="Remove step" className="ml-auto" onClick={() => setA({ ...a, actions: actions.filter((_, j) => j !== i) })}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
              {(act.type === "agent_task" || act.type === "prompt") && <Textarea rows={2} className="mt-2" value={String(act.prompt ?? "")} onChange={(e) => setAction(i, { prompt: e.target.value })} placeholder="Instructions. Variables: {{date}}, {{trigger.path}}, {{previous.output}}" />}
              {(act.type === "write_file" || act.type === "append_file") && (
                <div className="mt-2 grid grid-cols-[1fr_2fr] gap-2">
                  <Input value={String(act.path ?? "")} onChange={(e) => setAction(i, { path: e.target.value })} placeholder="reports/{{date}}.md" className="font-mono text-[12px]" />
                  <Input value={String(act.content ?? "{{previous.output}}")} onChange={(e) => setAction(i, { content: e.target.value })} className="font-mono text-[12px]" />
                </div>
              )}
              {act.type === "notify" && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Input value={String(act.title ?? "")} onChange={(e) => setAction(i, { title: e.target.value })} placeholder="Title" />
                  <Input value={String(act.body ?? "")} onChange={(e) => setAction(i, { body: e.target.value })} placeholder="Body, e.g. {{previous.output|truncate:120}}" />
                </div>
              )}
            </div>
          </div>
        ))}
        <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => setA({ ...a, actions: [...actions, { type: "notify", title: "", body: "" }] })}>
          Add step
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-6 border-t border-line-soft pt-4">
        <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
          <Toggle checked={a.requires_approval ?? true} onChange={(v) => setA({ ...a, requires_approval: v })} label="Requires approval" /> Ask me before each run
        </label>
        <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
          Retries on failure
          <Select value={String(a.failure_policy?.retries ?? 0)} onChange={(v) => setA({ ...a, failure_policy: { ...a.failure_policy, retries: Number(v) } })} options={[0, 1, 2, 3].map((n) => ({ value: String(n), label: String(n) }))} />
        </label>
        <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
          <Toggle checked={a.failure_policy?.notify ?? true} onChange={(v) => setA({ ...a, failure_policy: { ...a.failure_policy, notify: v } })} label="Notify on failure" /> Notify on failure
        </label>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {a.id && <Button variant="danger" onClick={() => void api.del(`/api/automations/${a.id}`).then(onSaved)}>Delete</Button>}
          <Button variant="primary" onClick={() => void save()} disabled={!a.name?.trim() || actions.length === 0}>Save</Button>
        </div>
      </div>
      {err && <p className={cls("mt-2 text-[12px] text-danger")}>{err}</p>}
    </div>
  );
}

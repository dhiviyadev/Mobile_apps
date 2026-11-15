import { useState, type ReactNode } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { Bell, Bot, FilePlus2, FileText, FolderSync, GripVertical, MessageSquareText, RefreshCw, TerminalSquare, Trash2, Zap } from "lucide-react";
import type { Agent, Folder } from "@/lib/types";
import { cls } from "@/lib/format";
import { IconButton, Input, Select, Textarea } from "./ui";

export type FlowAction = { type: string; _key: string; [k: string]: unknown };

const KINDS: { type: string; label: string; icon: typeof Bot; defaults: Record<string, unknown>; hint: string }[] = [
  { type: "agent_task", label: "Agent task", icon: Bot, defaults: { agent_id: "chief", prompt: "" }, hint: "An agent works on it with its tools" },
  { type: "prompt", label: "Ask the model", icon: MessageSquareText, defaults: { prompt: "" }, hint: "A plain question, no tools" },
  { type: "write_file", label: "Write a file", icon: FilePlus2, defaults: { path: "reports/{{date}}.md", content: "{{previous.output}}" }, hint: "Saved in the NEXUS workspace" },
  { type: "append_file", label: "Append to a file", icon: FileText, defaults: { path: "log.md", content: "{{previous.output}}" }, hint: "Adds to the end of a file" },
  { type: "notify", label: "Notify me", icon: Bell, defaults: { title: "", body: "{{previous.output|truncate:120}}" }, hint: "Shows a notification" },
  { type: "reindex_folder", label: "Re-read a folder", icon: FolderSync, defaults: { folder_id: "" }, hint: "Refreshes one folder's documents" },
  { type: "reindex_all", label: "Re-read all folders", icon: RefreshCw, defaults: {}, hint: "Refreshes every approved folder" },
  { type: "run_script", label: "Run a script", icon: TerminalSquare, defaults: { name: "" }, hint: "One of your approved scripts" },
];
const kind = (type: string) => KINDS.find((k) => k.type === type) ?? KINDS[0]!;

let seq = 0;
export const withKeys = (actions: { type: string; [k: string]: unknown }[]): FlowAction[] =>
  actions.map((a) => ({ ...a, _key: (a._key as string | undefined) ?? `s${++seq}` }));
export const stripKeys = (actions: FlowAction[]): { type: string; [k: string]: unknown }[] => actions.map(({ _key: _k, ...rest }) => rest as { type: string });

function summary(a: FlowAction, agents: Agent[], folders: Folder[]): string {
  switch (a.type) {
    case "agent_task":
      return `${agents.find((g) => g.id === a.agent_id)?.name ?? "Agent"}: ${String(a.prompt || "no instructions yet")}`;
    case "prompt":
      return String(a.prompt || "no question yet");
    case "write_file":
    case "append_file":
      return String(a.path || "no file chosen");
    case "notify":
      return String(a.title || a.body || "no message yet");
    case "reindex_folder":
      return folders.find((f) => f.id === a.folder_id)?.label ?? "no folder chosen";
    case "run_script":
      return String(a.name || "no script chosen");
    default:
      return "";
  }
}

/** A visual flow: trigger on top, steps as draggable nodes joined by a line, and a palette to add more. */
export function FlowBuilder({ trigger, actions, onChange, agents, folders }: {
  trigger: ReactNode;
  actions: FlowAction[];
  onChange: (next: FlowAction[]) => void;
  agents: Agent[];
  folders: Folder[];
}) {
  const [open, setOpen] = useState<string | null>(actions[0]?._key ?? null);
  const patch = (key: string, p: Record<string, unknown>) => onChange(actions.map((a) => (a._key === key ? { ...a, ...p } : a)));
  const add = (type: string) => {
    const node: FlowAction = { type, ...kind(type).defaults, _key: `s${++seq}` };
    onChange([...actions, node]);
    setOpen(node._key);
  };

  return (
    <div className="flow relative rounded-2xl border border-white/[0.07] bg-black/20 p-4">
      <div className="flow-node mx-auto flex w-fit items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-3.5 py-1.5 text-[12.5px] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
        <Zap size={13} className="text-accent" /> {trigger}
      </div>
      <Reorder.Group axis="y" values={actions} onReorder={onChange} className="mt-0">
        {actions.map((a, i) => (
          <Node
            key={a._key}
            action={a}
            index={i}
            open={open === a._key}
            onToggle={() => setOpen(open === a._key ? null : a._key)}
            onPatch={(p) => patch(a._key, p)}
            onRetype={(type) => onChange(actions.map((x) => (x._key === a._key ? { type, ...kind(type).defaults, _key: a._key } : x)))}
            onRemove={() => onChange(actions.filter((x) => x._key !== a._key))}
            agents={agents}
            folders={folders}
          />
        ))}
      </Reorder.Group>
      <div className="flow-line mx-auto h-5 w-px" />
      <p className="mb-2 text-center text-[11px] font-medium uppercase tracking-[0.1em] text-muted">Add a step</p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {KINDS.map((k) => (
          <button key={k.type} type="button" title={k.hint} onClick={() => add(k.type)} className="press glass-inset inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] text-fg-2 hover:text-fg">
            <k.icon size={13} /> {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Node({ action: a, index, open, onToggle, onPatch, onRetype, onRemove, agents, folders }: {
  action: FlowAction;
  index: number;
  open: boolean;
  onToggle: () => void;
  onPatch: (p: Record<string, unknown>) => void;
  onRetype: (type: string) => void;
  onRemove: () => void;
  agents: Agent[];
  folders: Folder[];
}) {
  const controls = useDragControls();
  const k = kind(a.type);
  return (
    <Reorder.Item value={a} dragListener={false} dragControls={controls} className="relative list-none" whileDrag={{ scale: 1.02, zIndex: 5 }}>
      <div className="flow-line mx-auto h-5 w-px" />
      <div className={cls("flow-node mx-auto max-w-[640px] rounded-2xl border bg-[rgba(22,24,30,0.72)] backdrop-blur-xl transition-colors", open ? "border-white/25 shadow-[0_18px_40px_-22px_rgba(0,0,0,0.9)]" : "border-white/[0.1] hover:border-white/20")}>
        <div className="flex items-center gap-2 p-2.5">
          <button type="button" aria-label="Drag to reorder" className="grid h-7 w-5 cursor-grab touch-none place-items-center text-muted hover:text-fg-2 active:cursor-grabbing" onPointerDown={(e) => controls.start(e)}>
            <GripVertical size={14} />
          </button>
          <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
            <span className="grid h-8 w-8 flex-none place-items-center rounded-full border border-white/15 bg-[radial-gradient(circle_at_35%_25%,rgba(255,255,255,0.22),rgba(255,255,255,0.04)_60%)]">
              <k.icon size={14} className="text-accent" />
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-fg">
                <span className="mr-1.5 text-muted">{index + 1}</span>
                {k.label}
              </span>
              <span className="block truncate text-[11.5px] text-muted">{summary(a, agents, folders)}</span>
            </span>
          </button>
          <IconButton label="Remove step" onClick={onRemove}>
            <Trash2 size={13} />
          </IconButton>
        </div>
        {open && (
          <div className="space-y-2 border-t border-white/[0.07] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={a.type} onChange={onRetype} options={KINDS.map((x) => ({ value: x.type, label: x.label }))} />
              {a.type === "agent_task" && <Select value={String(a.agent_id ?? "chief")} onChange={(v) => onPatch({ agent_id: v })} options={agents.map((g) => ({ value: g.id, label: g.name }))} />}
              {a.type === "reindex_folder" && <Select value={String(a.folder_id ?? "")} onChange={(v) => onPatch({ folder_id: v })} placeholder="Folder" options={folders.map((f) => ({ value: f.id, label: f.label }))} />}
              {a.type === "run_script" && <Input value={String(a.name ?? "")} onChange={(e) => onPatch({ name: e.target.value })} placeholder="Script name" className="w-48" />}
            </div>
            {(a.type === "agent_task" || a.type === "prompt") && (
              <Textarea rows={3} value={String(a.prompt ?? "")} onChange={(e) => onPatch({ prompt: e.target.value })} placeholder="What should happen in this step? You can use {{date}}, {{trigger.path}} and {{previous.output}}." />
            )}
            {(a.type === "write_file" || a.type === "append_file") && (
              <div className="grid grid-cols-[1fr_2fr] gap-2">
                <Input value={String(a.path ?? "")} onChange={(e) => onPatch({ path: e.target.value })} placeholder="reports/{{date}}.md" className="font-mono text-[12px]" />
                <Input value={String(a.content ?? "{{previous.output}}")} onChange={(e) => onPatch({ content: e.target.value })} className="font-mono text-[12px]" />
              </div>
            )}
            {a.type === "notify" && (
              <div className="grid grid-cols-2 gap-2">
                <Input value={String(a.title ?? "")} onChange={(e) => onPatch({ title: e.target.value })} placeholder="Title" />
                <Input value={String(a.body ?? "")} onChange={(e) => onPatch({ body: e.target.value })} placeholder="Message, e.g. {{previous.output|truncate:120}}" />
              </div>
            )}
            <p className="text-[11px] text-muted">{k.hint}. Each step can use the result of the one before it as {"{{previous.output}}"}.</p>
          </div>
        )}
      </div>
    </Reorder.Item>
  );
}

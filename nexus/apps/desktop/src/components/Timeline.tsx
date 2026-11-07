import { useEffect } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Ban, Check, CircleDot, Cpu, FileText, Loader2, ShieldAlert, Square, Wrench, X } from "lucide-react";
import { useCore } from "@/stores/core";
import { api } from "@/lib/api";
import type { TaskEvent } from "@/lib/types";
import { cls, duration } from "@/lib/format";
import { Badge, Button } from "./ui";

function iconFor(type: string) {
  if (type === "task.completed") return <Check size={12} />;
  if (type === "task.failed" || type === "tool.failed") return <X size={12} />;
  if (type === "task.cancelled") return <Square size={10} />;
  if (type === "tool.denied" || type === "tool.rejected") return <ShieldAlert size={12} />;
  if (type.startsWith("tool.")) return <Wrench size={12} />;
  if (type.startsWith("model.")) return <Cpu size={12} />;
  if (type.startsWith("approval") || type === "automation.denied") return <Ban size={12} />;
  if (type.includes("fallback")) return <AlertTriangle size={12} />;
  if (type.includes("file")) return <FileText size={12} />;
  return <CircleDot size={11} />;
}

function tone(type: string): string {
  if (type === "task.completed" || type === "tool.completed") return "text-ok";
  if (type.includes("failed") || type.includes("denied") || type.includes("rejected")) return "text-danger";
  if (type.includes("fallback") || type.startsWith("approval")) return "text-warn";
  return "text-fg-2";
}

/** Live execution timeline for one task — every row is a persisted event emitted by the backend. */
export function Timeline({ taskId, compact }: { taskId: string; compact?: boolean }) {
  const task = useCore((s) => s.tasks[taskId]);
  const events = useCore((s) => s.taskEvents[taskId]);
  const loadTask = useCore((s) => s.loadTask);

  useEffect(() => {
    if (!events) void loadTask(taskId).catch(() => undefined);
  }, [taskId, events, loadTask]);

  if (!task) return null;
  const live = task.status === "running" || task.status === "queued" || task.status === "waiting_approval";
  const rows: TaskEvent[] = (events ?? []).filter((e) => e.type !== "model.thinking" || e === events?.at(-1));

  return (
    <div className={cls("rounded-xl border border-line-soft bg-[#16181d]", compact ? "p-3" : "p-4")}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {live ? <Loader2 size={13} className="animate-spin text-accent" /> : task.status === "completed" ? <Check size={13} className="text-ok" /> : <X size={13} className="text-danger" />}
          <span className="truncate text-[12.5px] font-medium text-fg">{task.title}</span>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          {task.runtime && <Badge>{task.runtime}</Badge>}
          <span className="text-[11px] text-muted">{duration(task.started_at ?? task.created_at, task.finished_at)}</span>
          {live && (
            <Button size="sm" variant="ghost" onClick={() => void api.post(`/api/tasks/${taskId}/cancel`)}>
              Cancel
            </Button>
          )}
        </div>
      </div>
      <ol className="relative ml-1.5 space-y-1.5 border-l border-line-soft pl-4">
        {rows.map((e, i) => (
          <motion.li key={e.seq} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.18 }} className="relative">
            <span className={cls("absolute -left-[23px] top-[3px] grid h-[14px] w-[14px] place-items-center rounded-full bg-[#16181d]", tone(e.type))}>
              {live && i === rows.length - 1 && !e.type.startsWith("task.") ? <Loader2 size={11} className="animate-spin" /> : iconFor(e.type)}
            </span>
            <p className={cls("text-[12px] leading-5", live && i === rows.length - 1 ? "text-fg" : "text-fg-2")}>{e.title}</p>
            {e.detail && !compact && <p className="selectable line-clamp-3 font-mono text-[11px] leading-4 text-muted">{e.detail}</p>}
          </motion.li>
        ))}
        {rows.length === 0 && <li className="text-[12px] text-muted">Waiting for the first event…</li>}
      </ol>
      {task.status === "failed" && task.error && <p className="selectable mt-2 text-[12px] text-danger">{task.error}</p>}
    </div>
  );
}

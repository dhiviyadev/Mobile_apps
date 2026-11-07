import { create } from "zustand";
import { api, ApiError, connection } from "@/lib/api";
import { bus, type ConnState } from "@/lib/events";
import type { Approval, Bootstrap, Notification, Task, TaskEvent, Workspace } from "@/lib/types";

type CoreStatus = "connecting" | "online" | "offline" | "unauthorized";

interface CoreState {
  status: CoreStatus;
  ws: ConnState;
  error: string | null;
  boot: Bootstrap | null;
  halted: boolean;
  approvals: Approval[];
  notifications: Notification[];
  tasks: Record<string, Task>;
  taskEvents: Record<string, TaskEvent[]>;
  taskText: Record<string, string>;
  workspace: Workspace;
  focusTaskId: string | null;
  paletteOpen: boolean;
  listening: boolean;
  speaking: boolean;
  setWorkspace: (w: Workspace) => void;
  setPalette: (open: boolean) => void;
  setListening: (v: boolean) => void;
  setSpeaking: (v: boolean) => void;
  focusTask: (id: string | null) => void;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  loadTask: (id: string) => Promise<void>;
  decide: (id: string, approve: boolean) => Promise<void>;
  emergencyStop: () => Promise<void>;
  resume: () => Promise<void>;
}

let initialised = false;

export const useCore = create<CoreState>((set, get) => ({
  status: "connecting",
  ws: "closed",
  error: null,
  boot: null,
  halted: false,
  approvals: [],
  notifications: [],
  tasks: {},
  taskEvents: {},
  taskText: {},
  workspace: "home",
  focusTaskId: null,
  paletteOpen: false,
  listening: false,
  speaking: false,
  setWorkspace: (workspace) => set({ workspace }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setListening: (listening) => set({ listening }),
  setSpeaking: (speaking) => set({ speaking }),
  focusTask: (focusTaskId) => {
    set({ focusTaskId });
    if (focusTaskId) void get().loadTask(focusTaskId);
  },

  init: async () => {
    if (initialised) return;
    initialised = true;
    bus.onState((ws) => {
      set({ ws });
      if (ws === "open") void get().refresh();
    });
    bus.on<{ halted: boolean }>("hello", (e) => set({ halted: e.data.halted }));
    bus.on<Task>("task.updated", (e) => {
      const t = e.data;
      set((s) => ({ tasks: { ...s.tasks, [t.id]: t } }));
      if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") scheduleRefresh(get);
    });
    bus.on<TaskEvent>("task.event", (e) => {
      const ev = e.data;
      set((s) => {
        const list = s.taskEvents[ev.task_id] ?? [];
        if (list.some((x) => x.seq === ev.seq)) return s;
        return { taskEvents: { ...s.taskEvents, [ev.task_id]: [...list, ev] } };
      });
    });
    bus.on<{ task_id: string; text: string }>("task.delta", (e) =>
      set((s) => ({ taskText: { ...s.taskText, [e.data.task_id]: (s.taskText[e.data.task_id] ?? "") + e.data.text } })),
    );
    bus.on<Approval>("approval.requested", (e) => set((s) => ({ approvals: [...s.approvals.filter((a) => a.id !== e.data.id), e.data] })));
    bus.on<Approval>("approval.decided", (e) => set((s) => ({ approvals: s.approvals.filter((a) => a.id !== e.data.id) })));
    bus.on<Notification>("notification.created", (e) => set((s) => ({ notifications: [e.data, ...s.notifications].slice(0, 30) })));
    bus.on<{ halted: boolean }>("system.halted", (e) => set({ halted: e.data.halted }));
    for (const t of ["automation", "agent", "conversation", "knowledge", "memory", "settings"]) bus.on(t, () => scheduleRefresh(get));
    await get().refresh();
    void bus.connect();
  },

  refresh: async () => {
    try {
      const boot = await api.get<Bootstrap>("/api/bootstrap");
      const tasks: Record<string, Task> = { ...get().tasks };
      for (const t of [...boot.tasks.recent, ...boot.tasks.active]) tasks[t.id] = t;
      set({ boot, status: "online", error: null, halted: boot.halted, approvals: boot.approvals, notifications: boot.notifications, tasks });
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) set({ status: "unauthorized", error: "The local API token was rejected." });
      else set({ status: "offline", error: err.message });
      if (err.status === 0) await connection(true);
    }
  },

  loadTask: async (id) => {
    const t = await api.get<Task & { events: TaskEvent[] }>(`/api/tasks/${id}`);
    const { events, ...task } = t;
    set((s) => ({ tasks: { ...s.tasks, [id]: task }, taskEvents: { ...s.taskEvents, [id]: events } }));
  },

  decide: async (id, approve) => {
    await api.post(`/api/approvals/${id}`, { approve });
    set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }));
  },

  emergencyStop: async () => {
    await api.post("/api/system/emergency-stop");
    set({ halted: true, approvals: [] });
    void get().refresh();
  },

  resume: async () => {
    await api.post("/api/system/resume");
    set({ halted: false });
  },
}));

let refreshTimer: number | null = null;
function scheduleRefresh(get: () => CoreState): void {
  if (refreshTimer) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void get().refresh();
  }, 400);
}

export function activeTasks(tasks: Record<string, Task>): Task[] {
  return Object.values(tasks)
    .filter((t) => t.status === "queued" || t.status === "running" || t.status === "waiting_approval")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Stable empty array for selectors: zustand v5 loops forever if a selector returns a new [] each call. */
export const EMPTY: never[] = [];

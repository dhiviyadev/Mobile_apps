import { create } from "zustand";
import { api, ApiError, postStream } from "@/lib/api";
import { bus } from "@/lib/events";
import type { Conversation, Message, Metrics, Source, Task } from "@/lib/types";
import { useCore } from "./core";

export interface Attachment {
  id: string;
  filename: string;
  size: number;
  preview: string;
  has_text: boolean;
}

interface Streaming {
  conversationId: string;
  generationId: string | null;
  text: string;
  thinking: string;
  status: "starting" | "loading_model" | "streaming";
  model: string | null;
  sources: Source[];
  memories: { id: string; category: string; content: string }[];
  userText: string;
}

export interface SendOptions {
  mode: "chat" | "agent";
  agentId?: string | null;
  model?: string | null;
  attachments?: Attachment[];
  allowCloud?: boolean;
  useKnowledge?: boolean;
}

interface ChatState {
  conversations: Conversation[];
  activeId: string | null;
  messages: Record<string, Message[]>;
  streaming: Streaming | null;
  pendingTask: Record<string, string>; // conversationId -> running agent task id
  error: string | null;
  lastMetrics: Metrics | null;
  loadList: (q?: string) => Promise<void>;
  open: (id: string | null) => Promise<void>;
  newConversation: () => Promise<string>;
  send: (text: string, opts: SendOptions) => Promise<Message | null>;
  stop: () => Promise<void>;
  regenerate: (opts?: { model?: string | null }) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

let controller: AbortController | null = null;
let wired = false;

export const useChat = create<ChatState>((set, get) => {
  async function reload(id: string): Promise<void> {
    const conv = await api.get<Conversation & { messages: Message[] }>(`/api/conversations/${id}`);
    set((s) => ({ messages: { ...s.messages, [id]: conv.messages } }));
  }

  function wire(): void {
    if (wired) return;
    wired = true;
    // The other window (or an agent) added a message: refresh if we have that conversation loaded.
    bus.on<{ conversation_id: string }>("conversation.message", (e) => {
      const cid = e.data.conversation_id;
      if (get().streaming?.conversationId === cid) return;
      if (get().messages[cid]) void reload(cid);
      void get().loadList();
    });
    bus.on("conversation.updated", () => void get().loadList());
    bus.on("conversation.deleted", () => void get().loadList());
    bus.on<Task>("task.updated", (e) => {
      const t = e.data;
      if (!t.conversation_id) return;
      if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") {
        set((s) => {
          const p = { ...s.pendingTask };
          if (p[t.conversation_id!] === t.id) delete p[t.conversation_id!];
          return { pendingTask: p, error: t.status === "failed" ? t.error : s.error };
        });
        void reload(t.conversation_id);
      }
    });
  }

  async function stream(cid: string, path: string, body: unknown, userText: string): Promise<Message | null> {
    controller?.abort();
    controller = new AbortController();
    set({
      error: null,
      streaming: { conversationId: cid, generationId: null, text: "", thinking: "", status: "starting", model: null, sources: [], memories: [], userText },
    });
    let final: Message | null = null;
    const patch = (p: Partial<Streaming>) => set((s) => (s.streaming ? { streaming: { ...s.streaming, ...p } } : s));
    try {
      await postStream<Record<string, unknown>>(
        path,
        body,
        (ev) => {
          const s = get().streaming;
          switch (ev.type) {
            case "start":
              patch({ generationId: ev.generation_id as string });
              break;
            case "model":
              patch({ model: ev.model as string });
              break;
            case "status":
              patch({ status: ev.status as Streaming["status"] });
              break;
            case "sources":
              patch({ sources: ev.sources as Source[] });
              break;
            case "memories":
              patch({ memories: ev.memories as Streaming["memories"] });
              break;
            case "thinking":
              patch({ thinking: (s?.thinking ?? "") + (ev.text as string) });
              break;
            case "delta":
              patch({ text: (s?.text ?? "") + (ev.text as string), status: "streaming" });
              break;
            case "done":
              final = ev.message as Message;
              set({ lastMetrics: (ev.metrics as Metrics) ?? null });
              break;
            case "error":
              set({ error: ev.error as string });
              break;
          }
        },
        controller.signal,
      );
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ streaming: null });
      controller = null;
      await reload(cid).catch(() => undefined);
      void get().loadList();
    }
    return final;
  }

  return {
    conversations: [],
    activeId: null,
    messages: {},
    streaming: null,
    pendingTask: {},
    error: null,
    lastMetrics: null,

    loadList: async (q) => {
      wire();
      try {
        const list = await api.get<Conversation[]>(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`);
        set({ conversations: list });
      } catch {
        /* offline: keep what we have */
      }
    },

    open: async (id) => {
      wire();
      set({ activeId: id, error: null });
      if (id) await reload(id).catch((e: ApiError) => set({ error: e.message }));
    },

    newConversation: async () => {
      const conv = await api.post<Conversation>("/api/conversations", {});
      set((s) => ({ conversations: [conv, ...s.conversations], activeId: conv.id, messages: { ...s.messages, [conv.id]: [] } }));
      return conv.id;
    },

    send: async (text, opts) => {
      wire();
      let cid = get().activeId;
      if (!cid) cid = await get().newConversation();
      const attachments = (opts.attachments ?? []).map((a) => a.id);
      if (opts.mode === "agent") {
        try {
          const optimistic: Message = {
            id: `local-${Date.now()}`, conversation_id: cid, role: "user", content: text, model: null, status: "complete",
            task_id: null, metadata: {}, created_at: new Date().toISOString(),
          };
          set((s) => ({ messages: { ...s.messages, [cid!]: [...(s.messages[cid!] ?? []), optimistic] } }));
          const r = await api.post<{ task: Task }>(`/api/conversations/${cid}/messages`, {
            content: text, mode: "agent", agent_id: opts.agentId ?? "chief", attachments,
          });
          set((s) => ({ pendingTask: { ...s.pendingTask, [cid!]: r.task.id } }));
          useCore.getState().focusTask(r.task.id);
          await reload(cid);
        } catch (e) {
          set({ error: (e as Error).message });
        }
        return null;
      }
      return stream(cid, `/api/conversations/${cid}/messages`, {
        content: text, mode: "chat", model: opts.model ?? null, attachments,
        allow_cloud: opts.allowCloud ?? false, use_knowledge: opts.useKnowledge ?? true,
      }, text);
    },

    stop: async () => {
      const s = get().streaming;
      if (s?.generationId) await api.post(`/api/generations/${s.generationId}/stop`).catch(() => undefined);
      const cid = get().activeId;
      const task = cid ? get().pendingTask[cid] : undefined;
      if (task) await api.post(`/api/tasks/${task}/cancel`).catch(() => undefined);
    },

    regenerate: async (opts) => {
      const cid = get().activeId;
      if (!cid) return;
      await stream(cid, `/api/conversations/${cid}/regenerate`, { model: opts?.model ?? null }, "");
    },

    rename: async (id, title) => {
      await api.patch(`/api/conversations/${id}`, { title });
      void get().loadList();
    },

    remove: async (id) => {
      await api.del(`/api/conversations/${id}`);
      set((s) => ({ activeId: s.activeId === id ? null : s.activeId }));
      void get().loadList();
    },
  };
});

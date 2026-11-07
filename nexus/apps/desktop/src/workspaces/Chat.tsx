import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Brain, Check, Copy, Download, FileText, MessageSquarePlus, RotateCcw, Search, Trash2, Volume2, VolumeX } from "lucide-react";
import { useChat } from "@/stores/chat";
import { useCore } from "@/stores/core";
import { Composer } from "@/components/Composer";
import { Markdown } from "@/components/Markdown";
import { Timeline } from "@/components/Timeline";
import { Badge, Empty, IconButton, Input, Select } from "@/components/ui";
import { Orb } from "@/components/Orb";
import { speak, interruptSpeech } from "@/hooks/useVoice";
import { api } from "@/lib/api";
import type { Message, ModelsResponse, Source } from "@/lib/types";
import { cls, relTime } from "@/lib/format";

export function Chat() {
  const { conversations, activeId, messages, streaming, pendingTask, loadList, open, newConversation, send, stop, regenerate, remove } = useChat();
  const speaking = useCore((s) => s.speaking);
  const ttsEnabled = useCore((s) => s.boot?.voice.tts_enabled && s.boot.voice.tts_available);
  const [q, setQ] = useState("");
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [model, setModel] = useState("");
  const [proposed, setProposed] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const list = activeId ? messages[activeId] ?? [] : [];
  const live = streaming && streaming.conversationId === activeId ? streaming : null;
  const pending = activeId ? pendingTask[activeId] : undefined;
  const conv = conversations.find((c) => c.id === activeId);

  useEffect(() => {
    void loadList();
    void api.get<ModelsResponse>("/api/models").then(setModels).catch(() => undefined);
  }, [loadList]);
  useEffect(() => {
    const t = setTimeout(() => void loadList(q || undefined), 200);
    return () => clearTimeout(t);
  }, [q, loadList]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom || !live) el.scrollTo({ top: el.scrollHeight, behavior: live ? "auto" : "smooth" });
  }, [list.length, live?.text, pending]);

  const lastAssistant = useMemo(() => [...list].reverse().find((m) => m.role === "assistant"), [list]);
  const chatModels = models?.installed.filter((m) => !m.embedding) ?? [];

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[260px] flex-none flex-col border-r border-line-soft">
        <div className="flex items-center gap-2 p-3">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2.5 top-2.5 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search history" className="pl-8" />
          </div>
          <IconButton label="New conversation" onClick={() => void newConversation()}>
            <MessageSquarePlus size={15} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => void open(c.id)}
              className={cls("group flex w-full flex-col rounded-[10px] px-3 py-2 text-left transition-colors", c.id === activeId ? "bg-white/[0.06]" : "hover:bg-white/[0.03]")}
            >
              <span className="truncate text-[13px] text-fg">{c.title}</span>
              <span className="text-[11px] text-muted">
                {relTime(c.updated_at)} · {c.message_count ?? 0} messages
              </span>
            </button>
          ))}
          {conversations.length === 0 && <p className="p-3 text-[12px] text-muted">{q ? "No matches" : "No conversations yet"}</p>}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 flex-none items-center justify-between gap-3 border-b border-line-soft px-5">
          <p className="truncate text-[13px] font-medium text-fg">{conv?.title ?? "New conversation"}</p>
          <div className="flex items-center gap-1.5">
            <Select
              value={model}
              onChange={setModel}
              placeholder={models?.online === false ? "Ollama offline" : `Auto (${models?.routing.general || models?.default || "router"})`}
              options={chatModels.map((m) => ({ value: m.name, label: `${m.name}${m.parameter_size ? ` · ${m.parameter_size}` : ""}` }))}
              className="max-w-[220px]"
            />
            {activeId && (
              <>
                <IconButton
                  label="Suggest memories from this conversation"
                  onClick={() =>
                    void api.post<unknown[]>(`/api/conversations/${activeId}/memories/propose`).then((r) => setProposed(`${r.length} memory proposal${r.length === 1 ? "" : "s"} added for review in Knowledge → Memory`))
                  }
                >
                  <Brain size={15} />
                </IconButton>
                <IconButton
                  label="Export as Markdown"
                  onClick={() =>
                    void api.text(`/api/conversations/${activeId}/export`).then((md) => {
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
                      a.download = `${(conv?.title ?? "conversation").replace(/[^\w-]+/g, "-")}.md`;
                      a.click();
                    })
                  }
                >
                  <Download size={15} />
                </IconButton>
                <IconButton label="Delete conversation" onClick={() => void remove(activeId)}>
                  <Trash2 size={15} />
                </IconButton>
              </>
            )}
          </div>
        </div>
        {proposed && (
          <div className="flex items-center justify-between border-b border-line-soft bg-white/[0.02] px-5 py-1.5 text-[12px] text-fg-2">
            {proposed}
            <button onClick={() => setProposed(null)} className="text-muted hover:text-fg">
              Dismiss
            </button>
          </div>
        )}

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[780px] px-6 py-6">
            {list.length === 0 && !live && (
              <div className="pt-16">
                <Empty
                  icon={<Orb state="idle" size={64} />}
                  title="Start a conversation"
                  body="Chat streams directly from your local model. Switch to Agent mode to let a specialist use tools — you'll see every step it takes."
                />
              </div>
            )}
            {list.map((m) => (
              <MessageView
                key={m.id}
                m={m}
                isLast={m.id === lastAssistant?.id}
                onRegenerate={() => void regenerate({ model: model || null })}
                speaking={speaking}
                canSpeak={Boolean(ttsEnabled)}
              />
            ))}
            {live && (
              <>
                {live.userText && (
                  <div className="mb-6 flex justify-end">
                    <div className="selectable max-w-[85%] whitespace-pre-wrap rounded-[14px] rounded-br-[5px] border border-line-soft bg-elevated px-3.5 py-2.5 text-[14px] leading-relaxed text-fg">
                      {live.userText}
                    </div>
                  </div>
                )}
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-6">
                  <AssistantHeader model={live.model} />
                  {live.sources.length > 0 && <Sources sources={live.sources} />}
                  {live.text ? (
                    <Markdown text={live.text} streaming />
                  ) : (
                    <p className="shimmer text-[13px]">{live.status === "loading_model" ? `Loading ${live.model ?? "model"} into memory…` : live.thinking ? "Reasoning…" : "Thinking…"}</p>
                  )}
                </motion.div>
              </>
            )}
            {pending && (
              <div className="mb-6">
                <AssistantHeader model="agent" />
                <Timeline taskId={pending} />
                <LiveAgentText taskId={pending} />
              </div>
            )}
          </div>
        </div>

        <div className="mx-auto w-full max-w-[820px] px-6 pb-5">
          <Composer onSend={(t, o) => send(t, { ...o, model: model || null })} busy={Boolean(live || pending)} onStop={() => void stop()} autoSendVoice={false} />
          <p className="mt-1.5 text-center text-[10.5px] text-muted">Runs locally on your Mac · Enter to send, Shift+Enter for a new line</p>
        </div>
      </div>
    </div>
  );
}

function MessageView({ m, isLast, onRegenerate, speaking, canSpeak }: { m: Message; isLast: boolean; onRegenerate: () => void; speaking: boolean; canSpeak: boolean }) {
  const [copied, setCopied] = useState(false);
  if (m.role === "user") {
    return (
      <div className="mb-6 flex justify-end">
        <div className="selectable max-w-[85%] whitespace-pre-wrap rounded-[14px] rounded-br-[5px] border border-line-soft bg-elevated px-3.5 py-2.5 text-[14px] leading-relaxed text-fg">
          {m.content}
          {Array.isArray(m.metadata.attachments) && m.metadata.attachments.length > 0 && (
            <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted">
              <FileText size={11} /> {m.metadata.attachments.length} attachment(s)
            </p>
          )}
        </div>
      </div>
    );
  }
  const metrics = m.metadata.metrics;
  return (
    <div className="group mb-6">
      <AssistantHeader model={m.model} />
      {m.task_id && (
        <details className="mb-2">
          <summary className="cursor-pointer text-[11.5px] text-muted hover:text-fg-2">Execution timeline</summary>
          <div className="mt-2">
            <Timeline taskId={m.task_id} compact />
          </div>
        </details>
      )}
      {m.metadata.sources && m.metadata.sources.length > 0 && <Sources sources={m.metadata.sources} />}
      <Markdown text={m.content || "_(empty response)_"} />
      <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <IconButton
          label="Copy"
          onClick={() => {
            void navigator.clipboard.writeText(m.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </IconButton>
        {isLast && !m.task_id && (
          <IconButton label="Regenerate" onClick={onRegenerate}>
            <RotateCcw size={13} />
          </IconButton>
        )}
        {canSpeak && (
          <IconButton label={speaking ? "Stop speaking" : "Read aloud"} onClick={() => (speaking ? interruptSpeech() : void speak(m.content))}>
            {speaking ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </IconButton>
        )}
        {m.status === "stopped" && <Badge tone="warn">stopped</Badge>}
        {metrics?.tokens_per_s && (
          <span className="ml-1 text-[11px] text-muted">
            {metrics.tokens_per_s} tok/s · {metrics.eval_tokens} tokens{metrics.ttft_ms ? ` · ${Math.round(metrics.ttft_ms)} ms to first token` : ""}
          </span>
        )}
        {m.metadata.provider === "cloud" && <Badge tone="warn">cloud</Badge>}
      </div>
    </div>
  );
}

function AssistantHeader({ model }: { model: string | null | undefined }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="h-3.5 w-3.5 rounded-full bg-[radial-gradient(circle_at_35%_30%,#fff,#9aa1ad_45%,#3a3e47)]" />
      <span className="text-[12px] font-medium text-fg-2">NEXUS</span>
      {model && <span className="text-[11px] text-muted">{model}</span>}
    </div>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  return (
    <div className="mb-2.5 flex flex-wrap gap-1.5">
      {sources.map((s, i) => (
        <button
          key={`${s.path}-${i}`}
          title={s.path}
          onClick={() => void api.post("/api/files/open", { path: s.path, reveal: "1" }).catch(() => undefined)}
          className="inline-flex h-6 max-w-[260px] items-center gap-1.5 rounded-md border border-line-soft bg-white/[0.025] px-2 text-[11px] text-fg-2 hover:border-line hover:text-fg"
        >
          <span className="text-muted">[{i + 1}]</span>
          <span className="truncate">{s.title}</span>
          {s.location && <span className="flex-none text-muted">· {s.location}</span>}
        </button>
      ))}
    </div>
  );
}

function LiveAgentText({ taskId }: { taskId: string }) {
  const text = useCore((s) => s.taskText[taskId]);
  if (!text) return null;
  return (
    <div className="mt-3">
      <Markdown text={text} streaming />
    </div>
  );
}

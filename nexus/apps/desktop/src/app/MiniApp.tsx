import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Maximize2, Pin, PinOff, Plus, X } from "lucide-react";
import { useCore } from "@/stores/core";
import { useChat } from "@/stores/chat";
import { Composer } from "@/components/Composer";
import { Markdown } from "@/components/Markdown";
import { Timeline } from "@/components/Timeline";
import { ApprovalStack } from "@/components/Approvals";
import { Orb, useOrbState, usePauseWhenHidden } from "@/components/Orb";
import { Ambient } from "@/components/Ambient";
import { motion } from "framer-motion";
import { IconButton } from "@/components/ui";
import { listen, shell } from "@/lib/tauri";
import { speak } from "@/hooks/useVoice";

/**
 * Floating mini assistant (separate Tauri window). It shares all state with the
 * main window through the core service: conversations, tasks and approvals are
 * persisted there and streamed to both windows over the event bus.
 */
export function MiniApp() {
  const init = useCore((s) => s.init);
  const status = useCore((s) => s.status);
  const ttsEnabled = useCore((s) => Boolean(s.boot?.voice.tts_enabled && s.boot.voice.tts_available));
  const { activeId, messages, streaming, pendingTask, send, stop, open, loadList, conversations, newConversation } = useChat();
  const orb = useOrbState();
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [level, setLevel] = useState(0);
  const [wave, setWave] = useState<Uint8Array | null>(null);
  const [ptt, setPtt] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  usePauseWhenHidden();

  // While collapsed, size the native window to exactly header + composer (+ outer padding/borders).
  useEffect(() => {
    if (expanded || !header.current || !footer.current) return;
    const fit = () => {
      const h = (header.current?.offsetHeight ?? 0) + (footer.current?.offsetHeight ?? 0) + 12 + 2;
      void shell.setMiniHeight(Math.ceil(h));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(header.current);
    ro.observe(footer.current);
    fit();
    return () => ro.disconnect();
  }, [expanded]);

  useEffect(() => {
    document.body.classList.add("mini-window");
    void init();
    void loadList();
  }, [init, loadList]);

  // Resume the most recent conversation so mini and main continue the same thread.
  useEffect(() => {
    if (!activeId && conversations[0]) void open(conversations[0].id);
  }, [activeId, conversations, open]);

  const setExp = useCallback((v: boolean) => {
    setExpanded(v);
    void shell.setMiniExpanded(v);
  }, []);

  useEffect(() => {
    const offs = [
      listen("nexus://ptt", () => {
        setPtt((n) => n + 1);
      }),
      listen("nexus://mini-shown", () => document.querySelector<HTMLTextAreaElement>("textarea")?.focus()),
    ];
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !useCore.getState().listening && void shell.hideMini();
    window.addEventListener("keydown", onKey);
    return () => {
      offs.forEach((p) => void p.then((off) => off()));
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const list = activeId ? (messages[activeId] ?? []).slice(-8) : [];
  const live = streaming && streaming.conversationId === activeId ? streaming : null;
  const pending = activeId ? pendingTask[activeId] : undefined;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [list.length, live?.text]);

  return (
    <div className="flex h-full flex-col p-1.5">
      <Ambient field={false} />
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: -8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 30 }}
        className="surface-elevated silver-edge flex min-h-0 flex-1 flex-col overflow-hidden rounded-[26px]"
      >
        <div ref={header} className="drag flex h-11 flex-none items-center gap-2.5 px-3" onMouseDown={(e) => e.target === e.currentTarget && void shell.startDragging()}>
          <Orb state={orb} size={24} level={level} waveform={wave} />
          <p className="flex-1 text-[12px] font-medium tracking-[0.14em] text-fg-2">NEXUS</p>
          <div className="no-drag flex items-center">
            <IconButton label="New conversation" onClick={() => void newConversation()}>
              <Plus size={14} />
            </IconButton>
            <IconButton label={pinned ? "Unpin (stop floating on top)" : "Keep on top"} onClick={() => { setPinned(!pinned); void shell.setAlwaysOnTop(!pinned); }}>
              {pinned ? <Pin size={13} /> : <PinOff size={13} />}
            </IconButton>
            <IconButton label={expanded ? "Collapse" : "Expand"} onClick={() => setExp(!expanded)}>
              {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </IconButton>
            <IconButton label="Open in NEXUS" onClick={() => void shell.showMain(activeId ? `chat:${activeId}` : "home")}>
              <Maximize2 size={13} />
            </IconButton>
            <IconButton label="Hide (Esc)" onClick={() => void shell.hideMini()}>
              <X size={14} />
            </IconButton>
          </div>
        </div>

        {expanded && (
          <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto border-t border-white/[0.07] px-3.5 py-3">
            {status !== "online" && <p className="text-[12px] text-danger">Core service offline.</p>}
            {list.length === 0 && !live && <p className="pt-6 text-center text-[12px] text-muted">Ask anything. ⌥⇧Space to talk.</p>}
            {list.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="rise ml-8 rounded-2xl rounded-br-md border border-white/10 bg-white/[0.08] px-3 py-2 text-[13px] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">{m.content}</div>
              ) : (
                <div key={m.id} className="rise text-[13px]"><Markdown text={m.content} /></div>
              ),
            )}
            {live && (
              <>
                {live.userText && <div className="rise ml-8 rounded-2xl rounded-br-md border border-white/10 bg-white/[0.08] px-3 py-2 text-[13px] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">{live.userText}</div>}
                {live.text ? <Markdown text={live.text} streaming /> : <p className="shimmer text-[12.5px]">Thinking…</p>}
              </>
            )}
            {pending && <Timeline taskId={pending} compact />}
            <ApprovalStack compact />
          </div>
        )}

        <div ref={footer} className="flex-none p-2">
          <Composer
            compact
            autoFocus
            showModes={expanded}
            busy={Boolean(live || pending)}
            onStop={() => void stop()}
            voiceTrigger={ptt}
            onVoiceLevel={(l, w) => {
              setLevel(l);
              setWave(w);
            }}
            onSend={async (text, opts) => {
              if (!expanded) setExp(true);
              const msg = await send(text, opts);
              if (msg && ttsEnabled) void speak(msg.content).catch(() => undefined);
            }}
          />
        </div>
      </motion.div>
    </div>
  );
}

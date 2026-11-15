import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import { ArrowUp, AudioLines, Bot, Cloud, Loader2, Mic, MicOff, MonitorUp, Paperclip, Square, X } from "lucide-react";
import { api } from "@/lib/api";
import { cls, bytes } from "@/lib/format";
import { useCore, EMPTY } from "@/stores/core";
import { useChat, type Attachment, type SendOptions } from "@/stores/chat";
import { interruptSpeech, speak, useVoice } from "@/hooks/useVoice";
import { isMobileApp } from "@/lib/tauri";
import { IconButton } from "./ui";

export interface ComposerProps {
  onSend: (text: string, opts: SendOptions) => void | Promise<unknown>;
  placeholder?: string;
  autoFocus?: boolean;
  compact?: boolean;
  showModes?: boolean;
  busy?: boolean;
  onStop?: () => void;
  onVoiceLevel?: (level: number, wave: Uint8Array | null) => void;
  voiceTrigger?: number; // increments to toggle push-to-talk from outside (global shortcut)
  autoSendVoice?: boolean;
}

export function Composer({ onSend, placeholder, autoFocus, compact, showModes = true, busy, onStop, onVoiceLevel, voiceTrigger, autoSendVoice = true }: ComposerProps) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"chat" | "agent">("chat");
  const [agentId, setAgentId] = useState("chief");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [allowCloud, setAllowCloud] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const pillId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const agents = useCore((s) => s.boot?.agents ?? EMPTY);
  const voiceAvailable = useCore((s) => s.boot?.voice.stt_available ?? false);
  const cloudEnabled = useCore((s) => Boolean(s.boot?.cloud?.enabled));
  const chatError = useChat((s) => s.error);
  const notice = useChat((s) => s.notice);
  const ttsAvailable = useCore((s) => Boolean(s.boot?.voice.tts_available));
  const speaking = useCore((s) => s.speaking);
  const isMac = useCore((s) => s.boot?.hardware?.platform === "Darwin");
  // Hands-free: listen → send → speak the reply → listen again, until switched off.
  const [handsFree, setHandsFree] = useState(false);
  const [turn, setTurn] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const answering = useRef(false);
  const empties = useRef(0);
  const hf = useRef(false);
  hf.current = handsFree;

  const submit = (value: string) => {
    const v = value.trim();
    if (!v || busy) return;
    const sent = Promise.resolve(onSend(v, { mode, agentId, attachments, allowCloud, handsFree: hf.current }));
    if (hf.current) {
      answering.current = true;
      empties.current = 0;
      void sent
        .then(async (reply) => {
          const content = reply && typeof reply === "object" && "content" in reply ? String((reply as { content: unknown }).content) : "";
          if (content && ttsAvailable && hf.current) await speak(content).catch(() => undefined);
        })
        .finally(() => {
          answering.current = false;
          setTurn((n) => n + 1);
        });
    }
    setText("");
    setAttachments((cur) => {
      cur.forEach((a) => a.thumb && URL.revokeObjectURL(a.thumb));
      return [];
    });
  };

  const voice = useVoice(
    (t) => (autoSendVoice || hf.current ? submit(t) : setText((cur) => (cur ? `${cur} ${t}` : t))),
    () => {
      if (!hf.current) return;
      // Nothing was said twice in a row: close the microphone rather than keep listening to a quiet room.
      if (++empties.current >= 2) {
        setHandsFree(false);
        setNote("Hands-free paused — I didn't hear anything.");
      } else setTurn((n) => n + 1);
    },
  );

  useEffect(() => {
    if (!handsFree) return;
    if (voice.phase === "error") {
      setHandsFree(false);
      return;
    }
    if (busy || speaking || answering.current || voice.phase !== "idle") return;
    const t = window.setTimeout(() => void voice.start(true), 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handsFree, busy, speaking, voice.phase, turn]);

  const toggleHandsFree = () => {
    setNote(null);
    if (handsFree) {
      setHandsFree(false);
      voice.cancel();
      interruptSpeech();
    } else {
      empties.current = 0;
      setHandsFree(true);
    }
  };

  useEffect(() => onVoiceLevel?.(voice.level, voice.wave), [voice.level, voice.wave, onVoiceLevel]);
  useEffect(() => {
    if (voiceTrigger) void voice.toggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceTrigger]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    // WebKit can over-report scrollHeight for an empty textarea; an empty field is always one line.
    const line = parseFloat(getComputedStyle(el).lineHeight) || 21;
    if (!text) {
      el.style.height = `${line}px`;
      return;
    }
    el.style.height = `${line}px`;
    el.style.height = `${Math.max(line, Math.min(el.scrollHeight, compact ? 120 : 220))}px`;
  }, [text, compact]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(text);
    }
    if (e.key === "Escape" && voice.phase === "recording") voice.cancel();
  };

  const upload = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    setUploading(true);
    setNote(null);
    try {
      for (const f of Array.from(files)) {
        const a = await api.upload<Attachment>("/api/attachments", f, f.name || "pasted.png");
        setAttachments((cur) => [...cur, { ...a, thumb: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined }]);
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const captureScreen = async () => {
    setUploading(true);
    setNote(null);
    try {
      const a = await api.post<Attachment>("/api/screen/capture");
      const blob = await api.getBlob(`/api/attachments/${a.id}/file`);
      setAttachments((cur) => [...cur, { ...a, thumb: URL.createObjectURL(blob) }]);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className={cls("surface silver-edge glass flex flex-col gap-2 transition-shadow duration-300 focus-within:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_0_0_4px_rgba(205,214,228,0.07),0_24px_60px_-24px_rgba(0,0,0,0.8)]", compact ? "rounded-[20px] p-2" : "rounded-[24px] p-3")}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void upload(e.dataTransfer.files);
      }}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <span key={a.id} title={a.preview.slice(0, 400)} className={cls("inline-flex items-center gap-1.5 rounded-lg border border-line bg-elevated text-[12px] text-fg-2", a.thumb ? "h-12 pl-1 pr-2" : "h-7 px-2")}>
              {a.thumb ? <img src={a.thumb} alt="" className="h-10 w-10 rounded-md object-cover" /> : <Paperclip size={12} />} {a.filename} <span className="text-muted">{bytes(a.size)}</span>
              {!a.has_text && !a.image && <span className="text-warn">no text</span>}
              <button aria-label="Remove attachment" onClick={() => { if (a.thumb) URL.revokeObjectURL(a.thumb); setAttachments((c) => c.filter((x) => x.id !== a.id)); }} className="text-muted hover:text-fg">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {voice.phase === "recording" && (
        <div className="flex items-center gap-2 px-1 text-[12px] text-fg-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-danger" /> {handsFree ? "Listening — just talk, I'll answer when you pause" : "Listening — release or press the mic to finish, Esc to cancel"}
        </div>
      )}
      {voice.phase === "transcribing" && (
        <div className="flex items-center gap-2 px-1 text-[12px] text-fg-2">
          <Loader2 size={12} className="animate-spin" /> Transcribing locally…
        </div>
      )}
      {handsFree && voice.phase === "idle" && (
        <div className="flex items-center gap-2 px-1 text-[12px] text-fg-2">
          <AudioLines size={12} className="text-accent" /> Hands-free is on{speaking ? " — speaking" : busy ? " — thinking" : ""}. Press the wave button to stop.
        </div>
      )}
      {voice.error && <p className="px-1 text-[12px] text-danger">{voice.error}</p>}
      {note && <p className="px-1 text-[12px] text-warn">{note}</p>}
      <textarea
        ref={ta}
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.length) {
            e.preventDefault();
            void upload(files);
          }
        }}
        rows={1}
        placeholder={placeholder ?? (mode === "agent" ? "Describe a task for the agent…" : "Ask NEXUS anything…")}
        className={cls("selectable w-full resize-none bg-transparent px-1.5 text-fg outline-none placeholder:text-muted", compact ? "text-[13px]" : "text-[14px]")}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
          <IconButton label="Attach files or pictures" onClick={() => fileInput.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 size={15} className="animate-spin" /> : <Paperclip size={15} />}
          </IconButton>
          {isMac && !isMobileApp && (
            <IconButton label="Attach a picture of my screen" onClick={() => void captureScreen()} disabled={uploading}>
              <MonitorUp size={15} />
            </IconButton>
          )}
          <IconButton
            label={voiceAvailable ? "Push to talk" : "Voice input unavailable — install a local speech engine (Settings → Voice)"}
            onClick={() => void voice.toggle()}
            active={voice.phase === "recording"}
            disabled={!voiceAvailable && voice.phase !== "recording"}
          >
            {voiceAvailable ? <Mic size={15} className={voice.phase === "recording" ? "text-danger" : ""} /> : <MicOff size={15} />}
          </IconButton>
          {voiceAvailable && (
            <IconButton label={handsFree ? "Stop hands-free conversation" : "Hands-free conversation (talk back and forth)"} onClick={toggleHandsFree} active={handsFree}>
              <AudioLines size={15} className={handsFree ? "text-accent" : ""} />
            </IconButton>
          )}
          {showModes && (
            <div className="glass-inset relative ml-1 flex items-center gap-1 rounded-full p-[3px]">
              {(["chat", "agent"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={cls("press relative h-6 rounded-full px-2.5 text-[11.5px] font-medium capitalize transition-colors", mode === m ? "text-fg" : "text-muted hover:text-fg-2")}
                >
                  {mode === m && (
                    <motion.span
                      layoutId={`mode-${pillId}`}
                      transition={{ type: "spring", stiffness: 520, damping: 36 }}
                      className="absolute inset-0 rounded-full border border-white/[0.14] bg-white/[0.12] shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]"
                    />
                  )}
                  <span className="relative">
                  {m === "agent" ? (
                    <span className="inline-flex items-center gap-1">
                      <Bot size={12} /> Agent
                    </span>
                  ) : (
                    "Chat"
                  )}
                  </span>
                </button>
              ))}
            </div>
          )}
          {showModes && mode === "agent" && (
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="glass-inset h-7 rounded-full px-2 text-[11.5px] text-fg-2">
              {agents.filter((a) => a.enabled).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          {cloudEnabled && mode === "chat" && (
            <IconButton label={allowCloud ? "Cloud allowed for this message" : "Local only (click to allow cloud for this message)"} onClick={() => setAllowCloud(!allowCloud)} active={allowCloud}>
              <Cloud size={15} className={allowCloud ? "text-warn" : ""} />
            </IconButton>
          )}
        </div>
        {busy ? (
          <button onClick={onStop} aria-label="Stop" title="Stop generating" className="press relative grid h-8 w-8 place-items-center rounded-full border border-white/15 bg-white/[0.1] text-fg shadow-[0_0_0_0_rgba(220,228,240,0.4)] hover:bg-white/[0.16] animate-[pulse-ring_1.8s_ease-out_infinite]">
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={() => submit(text)}
            disabled={!text.trim()}
            aria-label="Send"
            className="btn-liquid press grid h-8 w-8 place-items-center rounded-full disabled:opacity-30 disabled:shadow-none"
          >
            <ArrowUp size={16} strokeWidth={2.4} />
          </button>
        )}
      </div>
      {chatError && !compact && <p className="selectable px-1 text-[12px] text-danger">{chatError}</p>}
      {notice && !chatError && <p className="selectable px-1 text-[12px] text-warn">{notice}</p>}
    </div>
  );
}

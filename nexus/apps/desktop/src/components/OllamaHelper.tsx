import { useEffect, useState } from "react";
import { Download, Loader2, Play, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useCore } from "@/stores/core";
import { Button } from "./ui";

interface OllamaStatus {
  online: boolean;
  installed: boolean;
  models: string[];
  next_step: "install" | "start" | "model" | "ready";
  can_start: boolean;
  download_url: string;
}

const TEXT: Record<Exclude<OllamaStatus["next_step"], "ready">, { title: string; body: string }> = {
  install: {
    title: "One step left: install Ollama",
    body: "NEXUS thinks with an AI model that runs on your Mac, through a free app called Ollama. Install it, open it once, then come back here.",
  },
  start: {
    title: "Ollama isn't running",
    body: "Chat, agents and briefings need it. NEXUS can start it for you.",
  },
  model: {
    title: "Ollama is running — now pick a model",
    body: "It has no chat model yet. Download one (Qwen 3 · 14B is a good everyday choice for your Mac).",
  },
};

/** Shown wherever the AI is needed while it isn't ready: says what is missing and fixes it in one click. */
export function OllamaHelper({ compact = false }: { compact?: boolean }) {
  const online = useCore((s) => s.boot?.ollama.online);
  const installed = useCore((s) => s.boot?.ollama.installed ?? 0);
  const refresh = useCore((s) => s.refresh);
  const openSettings = useCore((s) => s.openSettings);
  const [st, setSt] = useState<OllamaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    void api.get<OllamaStatus>("/api/ollama").then(setSt).catch(() => undefined);
  }, [online, installed]);

  if (!st || st.next_step === "ready" || (online && installed > 0)) return null;
  const step = st.next_step;

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      setSt(await api.post<OllamaStatus>("/api/ollama/start"));
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    const r = await api.post<{ opened: boolean; url: string }>("/api/ollama/download").catch(() => null);
    if (!r?.opened) window.open(st.download_url, "_blank", "noopener");
    setOpened(true);
  };

  return (
    <div className={`rise flex items-center gap-4 rounded-2xl border border-warn/25 bg-warn/[0.07] ${compact ? "px-4 py-3" : "px-5 py-4"}`}>
      <Sparkles size={18} className="flex-none text-warn" />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-fg">{TEXT[step].title}</p>
        <p className="mt-0.5 text-[12.5px] leading-snug text-fg-2">
          {TEXT[step].body}
          {step === "install" && opened && " When it's installed and open, press “Check again”."}
        </p>
        {err && <p className="mt-1 text-[12px] text-danger">{err}</p>}
      </div>
      {step === "install" && (
        <>
          <Button variant="primary" icon={<Download size={13} />} onClick={() => void download()}>
            Get Ollama
          </Button>
          {opened && (
            <Button variant="ghost" onClick={() => void api.get<OllamaStatus>("/api/ollama").then(setSt).then(refresh)}>
              Check again
            </Button>
          )}
        </>
      )}
      {step === "start" && (
        <Button variant="primary" disabled={busy || !st.can_start} icon={busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} onClick={() => void start()}>
          {busy ? "Starting…" : "Start Ollama"}
        </Button>
      )}
      {step === "model" && (
        <Button variant="primary" icon={<Download size={13} />} onClick={() => openSettings("models")}>
          Choose a model
        </Button>
      )}
    </div>
  );
}

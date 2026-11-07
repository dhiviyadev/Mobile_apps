import { useEffect, useState } from "react";
import { Gauge, HardDrive, Loader2, MemoryStick, Power, Server } from "lucide-react";
import { api } from "@/lib/api";
import { bus } from "@/lib/events";
import type { ModelsResponse, SystemSnapshot } from "@/lib/types";
import { Badge, Button, Card, Dot, Meter, SectionTitle, Select, Sparkline, Stat } from "@/components/ui";
import { bytes, pct } from "@/lib/format";

interface Bench {
  model: string;
  load: { load_ms: number | null; wall_ms: number };
  generation: { tokens_per_s: number | null; ttft_ms: number | null; eval_tokens: number | null; total_ms: number | null };
  resident_bytes: number | null;
  memory_before: { available: number };
  memory_after: { available: number };
  pressure_after: { label: string };
  tool_calling: { trials: number; successes: number; rate: number | null; errors: string[] };
}

export function System() {
  const [snap, setSnap] = useState<SystemSnapshot | null>(null);
  const [hist, setHist] = useState<SystemSnapshot["history"]>([]);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [benchModel, setBenchModel] = useState("");
  const [bench, setBench] = useState<Bench | null>(null);
  const [benching, setBenching] = useState(false);
  const [benchErr, setBenchErr] = useState<string | null>(null);

  const load = () => {
    void api.get<SystemSnapshot>("/api/system/status").then((s) => {
      setSnap(s);
      setHist(s.history);
    });
    void api.get<ModelsResponse>("/api/models").then(setModels);
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    const off = bus.on<SystemSnapshot["history"][number]>("system.sample", (e) => setHist((h) => [...h.slice(-119), e.data]));
    return () => {
      clearInterval(t);
      off();
    };
  }, []);

  if (!snap) return <div className="p-8 text-muted"><Loader2 className="animate-spin" size={16} /></div>;
  const hw = snap.hardware as Record<string, string | number | null>;
  const last = hist.at(-1);
  const svc = snap.services;

  const runBench = async () => {
    setBenching(true);
    setBenchErr(null);
    try {
      setBench(await api.post<Bench>("/api/models/benchmark", { model: benchModel, cold: true, tool_trials: 3 }));
    } catch (e) {
      setBenchErr((e as Error).message);
    } finally {
      setBenching(false);
      load();
    }
  };

  return (
    <div className="mx-auto max-w-[1120px] px-8 py-8">
      <SectionTitle
        title="System"
        sub={[hw.chip, hw.memory_bytes ? `${bytes(Number(hw.memory_bytes), 0)} unified memory` : null, hw.macos_version ? `macOS ${hw.macos_version}` : `${hw.platform} ${hw.machine}`].filter(Boolean).join(" · ")}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <Stat label="CPU" value={pct(last?.cpu_percent ?? snap.cpu.percent)} sub={`${snap.cpu.count} cores${snap.cpu.load_avg ? ` · load ${snap.cpu.load_avg[0]?.toFixed(2)}` : ""}`} />
          <div className="mt-3"><Sparkline values={hist.map((h) => h.cpu_percent)} /></div>
        </Card>
        <Card>
          <Stat label="Memory" value={pct(last?.memory_percent ?? snap.memory.percent)} sub={`${bytes(snap.memory.used)} of ${bytes(snap.memory.total)} · swap ${bytes(snap.memory.swap_used)}`} />
          <div className="mt-3"><Sparkline values={hist.map((h) => h.memory_percent)} /></div>
        </Card>
        <Card>
          <Stat
            label="Memory pressure"
            value={<span className="flex items-center gap-2"><Dot tone={snap.memory.pressure.label === "critical" ? "danger" : snap.memory.pressure.label === "warning" ? "warn" : snap.memory.pressure.available ? "ok" : "neutral"} />{snap.memory.pressure.label}</span>}
            sub={snap.memory.pressure.source ?? "macOS only (kern.memorystatus_vm_pressure_level)"}
          />
        </Card>
        <Card>
          <Stat label="Inference" value={snap.inference.avg_tokens_per_s ? `${snap.inference.avg_tokens_per_s} tok/s` : "—"} sub={snap.inference.avg_ttft_ms ? `${Math.round(snap.inference.avg_ttft_ms)} ms to first token · ${snap.inference.samples} samples` : "No generations measured yet"} />
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-1.5"><Server size={12} /> Services</span>}>
          <ServiceRow name="NEXUS core" ok={svc.core.status === "ok"} detail={`pid ${svc.core.pid} · ${bytes(svc.core.rss_bytes)} RSS · up ${Math.round(svc.core.uptime_s / 60)} min`} />
          <ServiceRow name="Ollama" ok={svc.ollama.status === "ok"} detail={svc.ollama.version ? `v${svc.ollama.version} · ${svc.ollama.url}` : `offline · ${svc.ollama.url}`} />
          <ServiceRow name="Hermes" ok={svc.hermes.status === "ready"} warn={svc.hermes.status === "installed"} neutral={svc.hermes.status === "not_installed" || svc.hermes.status === "disabled"} detail={svc.hermes.status === "ready" ? `${svc.hermes.transport} · ${svc.hermes.version ?? ""}` : svc.hermes.status.replace("_", " ")} />
          <ServiceRow name="Database" ok={svc.database.status === "ok"} detail={`SQLite · ${bytes(svc.database.size_bytes)}`} />
          <ServiceRow name="Voice" ok={svc.voice.stt_available} warn={!svc.voice.stt_available && svc.voice.tts_available} detail={`STT: ${svc.voice.stt_engines.join(", ") || "none"} · TTS: ${svc.voice.tts_engines.join(", ") || "none"}`} />
          <p className="mt-3 text-[11.5px] text-muted">Active tasks: {snap.tasks.queued_or_running} {snap.halted && <Badge tone="danger">emergency stop</Badge>}</p>
        </Card>

        <Card title={<span className="flex items-center gap-1.5"><MemoryStick size={12} /> Loaded models</span>}>
          {svc.ollama.loaded_models.length === 0 ? (
            <p className="text-[12.5px] text-muted">No model is resident. Models load on first use and unload after their keep-alive expires.</p>
          ) : (
            svc.ollama.loaded_models.map((m) => (
              <div key={m.name} className="flex items-center gap-3 py-1.5">
                <Dot tone="ok" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-fg">{m.name}</p>
                  <p className="text-[11px] text-muted">
                    {bytes(m.size)} resident · {bytes(m.size_vram)} on GPU{m.context_length ? ` · ctx ${m.context_length}` : ""} · expires {new Date(m.expires_at).toLocaleTimeString()}
                  </p>
                </div>
                <Button size="sm" variant="ghost" icon={<Power size={11} />} onClick={() => void api.post(`/api/models/${encodeURIComponent(m.name)}/unload`).then(load)}>
                  Unload
                </Button>
              </div>
            ))
          )}
          {Object.entries(svc.ollama.transitions).map(([m, s]) => (
            <p key={m} className="text-[12px] text-fg-2"><Loader2 size={11} className="mr-1 inline animate-spin" />{s} {m}</p>
          ))}
          <div className="mt-3 border-t border-line-soft pt-3">
            <p className="text-[11.5px] text-muted">{snap.gpu.note}</p>
          </div>
        </Card>

        <Card title={<span className="flex items-center gap-1.5"><HardDrive size={12} /> Storage</span>}>
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-fg-2">Volume holding NEXUS data</span>
            <span className="text-muted">{bytes(snap.disk.free)} free of {bytes(snap.disk.total)}</span>
          </div>
          <div className="mt-2"><Meter value={snap.disk.percent} /></div>
          <p className="mt-2 truncate font-mono text-[11px] text-muted">{snap.disk.path}</p>
        </Card>

        <Card title={<span className="flex items-center gap-1.5"><Gauge size={12} /> Measure a model on this Mac</span>}>
          <p className="text-[12px] text-fg-2">Cold-loads the model, generates ~200 words, and tests tool-calling 3×. Uses Ollama's own counters — no estimates.</p>
          <div className="mt-3 flex gap-2">
            <Select value={benchModel} onChange={setBenchModel} placeholder="Choose model" options={(models?.installed ?? []).filter((m) => !m.embedding).map((m) => ({ value: m.name, label: `${m.name} · ${bytes(m.size)}` }))} />
            <Button variant="primary" disabled={!benchModel || benching} onClick={() => void runBench()}>
              {benching ? <><Loader2 size={12} className="animate-spin" /> Measuring…</> : "Run benchmark"}
            </Button>
          </div>
          {benchErr && <p className="mt-2 text-[12px] text-danger">{benchErr}</p>}
          {bench && (
            <div className="mt-3 grid grid-cols-3 gap-3 border-t border-line-soft pt-3">
              <Stat label="Load" value={`${((bench.load.load_ms ?? bench.load.wall_ms) / 1000).toFixed(1)}s`} />
              <Stat label="Speed" value={bench.generation.tokens_per_s ? `${bench.generation.tokens_per_s} t/s` : "—"} sub={bench.generation.ttft_ms ? `${Math.round(bench.generation.ttft_ms)} ms TTFT` : undefined} />
              <Stat label="Tool calls" value={`${bench.tool_calling.successes}/${bench.tool_calling.trials}`} />
              <Stat label="Resident" value={bytes(bench.resident_bytes)} />
              <Stat label="RAM used" value={bytes(bench.memory_before.available - bench.memory_after.available)} sub="change in available memory" />
              <Stat label="Pressure" value={bench.pressure_after.label} />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function ServiceRow({ name, ok, warn, neutral, detail }: { name: string; ok: boolean; warn?: boolean; neutral?: boolean; detail: string }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <Dot tone={ok ? "ok" : warn ? "warn" : neutral ? "neutral" : "danger"} />
      <span className="w-24 text-[13px] text-fg">{name}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{detail}</span>
    </div>
  );
}

import { useEffect, useRef } from "react";
import { useCore, activeTasks } from "@/stores/core";
import { useChat } from "@/stores/chat";

export type OrbState = "idle" | "listening" | "thinking" | "executing";

/** Derive the orb state from real activity: recording, generating, or agent tasks running tools. */
export function useOrbState(): OrbState {
  const listening = useCore((s) => s.listening);
  const tasks = useCore((s) => s.tasks);
  const events = useCore((s) => s.taskEvents);
  const streaming = useChat((s) => s.streaming);
  if (listening) return "listening";
  const active = activeTasks(tasks).filter((t) => t.status === "running");
  if (active.length) {
    const last = active.map((t) => events[t.id]?.at(-1)?.type ?? "").find(Boolean) ?? "";
    return last.startsWith("tool.") || last.startsWith("automation") || last.startsWith("hermes") ? "executing" : "thinking";
  }
  if (streaming) return "thinking";
  return "idle";
}

/**
 * The NEXUS orb: a liquid-glass droplet. A dark glass body holds two morphing,
 * counter-rotating silver caustics under a rim-lit shell with a specular
 * highlight. Pure CSS (transform/opacity/border-radius on a small element);
 * a tiny canvas draws the voice waveform only while listening. Animations
 * pause when the window is hidden and stop under Reduce Motion.
 */
export function Orb({ state, size = 120, level = 0, waveform }: { state: OrbState; size?: number; level?: number; waveform?: Uint8Array | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    ref.current?.style.setProperty("--level", String(level));
  }, [level]);

  useEffect(() => {
    if (state !== "listening" || !canvas.current || !waveform || waveform.length === 0) return;
    const c = canvas.current;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const cx = c.width / 2;
    const cy = c.height / 2;
    const base = c.width * 0.43;
    ctx.beginPath();
    const n = waveform.length;
    for (let i = 0; i <= n; i++) {
      const v = ((waveform[i % n] ?? 128) - 128) / 128;
      const a = (i / n) * Math.PI * 2;
      const r = base + v * c.width * 0.06;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(220,226,235,0.55)";
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();
  }, [state, waveform, size]);

  return (
    <div ref={ref} className="orb" data-state={state} style={{ ["--size" as string]: `${size}px` }} role="img" aria-label={`NEXUS is ${state}`}>
      <div className="orb-halo" />
      {size >= 48 && <div className="orb-reflection" />}
      <div className="orb-ring" />
      <div className="orb-ring" />
      <div className="orb-ring" />
      <div className="orb-core">
        <div className="orb-liquid" />
        <div className="orb-liquid second" />
      </div>
      <div className="orb-shell" />
      <div className="orb-shine" />
      {state === "listening" && <canvas ref={canvas} />}
    </div>
  );
}

/** Adds `.paused` to <body> while the window is hidden so CSS animations stop consuming GPU. */
export function usePauseWhenHidden(): void {
  useEffect(() => {
    const update = () => document.body.classList.toggle("paused", document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
}

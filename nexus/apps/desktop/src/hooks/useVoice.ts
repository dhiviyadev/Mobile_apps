import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { play, Recorder, stopPlayback } from "@/lib/audio";
import { useCore } from "@/stores/core";

export type VoicePhase = "idle" | "recording" | "transcribing" | "error";

/** Push-to-talk: start() opens the mic, stop() closes it and returns the local transcription. */
export function useVoice(onTranscript: (text: string) => void, onEmpty?: () => void) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [level, setLevel] = useState(0);
  const [wave, setWave] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const rec = useRef<Recorder | null>(null);
  const setListening = useCore((s) => s.setListening);
  const cb = useRef(onTranscript);
  cb.current = onTranscript;
  const emptyCb = useRef(onEmpty);
  emptyCb.current = onEmpty;
  const stopRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => () => rec.current?.cancel(), []);

  /** @param autoStop hands-free: stop by itself when the speaker goes quiet */
  const start = useCallback(async (autoStop = false) => {
    setError(null);
    setPreview("");
    stopPlayback();
    const r = new Recorder(
      (l, w) => {
        setLevel(l);
        setWave(w);
      },
      autoStop ? () => void stopRef.current() : undefined,
    );
    rec.current = r;
    try {
      await r.start();
      setPhase("recording");
      setListening(true);
    } catch (e) {
      setPhase("error");
      setError((e as Error).name === "NotAllowedError" ? "Microphone permission was denied. Enable it in System Settings → Privacy & Security → Microphone." : (e as Error).message);
    }
  }, [setListening]);

  const stop = useCallback(async () => {
    const r = rec.current;
    if (!r) return;
    setListening(false);
    const out = await r.stop();
    rec.current = null;
    if (!out) {
      setPhase("idle");
      emptyCb.current?.();
      return;
    }
    setPhase("transcribing");
    try {
      const res = await api.upload<{ text: string; engine: string }>("/api/voice/transcribe", out.blob, out.filename);
      setPreview(res.text);
      setPhase("idle");
      if (res.text.trim()) cb.current(res.text.trim());
      else emptyCb.current?.();
    } catch (e) {
      setPhase("error");
      setError((e as Error).message);
    }
  }, [setListening]);

  const cancel = useCallback(() => {
    rec.current?.cancel();
    rec.current = null;
    setListening(false);
    setPhase("idle");
  }, [setListening]);

  stopRef.current = stop;
  const toggle = useCallback(() => (phase === "recording" ? stop() : start()), [phase, start, stop]);

  return { phase, level, wave, error, preview, start, stop, cancel, toggle };
}

/** Speak text with the local TTS engine; returns a stop function. */
export async function speak(text: string): Promise<void> {
  const clean = text.replace(/```[\s\S]*?```/g, " code block omitted ").replace(/[#*_`>|]/g, "").slice(0, 3500);
  const blob = await api.blob("/api/voice/speak", { text: clean });
  useCore.getState().setSpeaking(true);
  play(blob, () => useCore.getState().setSpeaking(false));
}

export function interruptSpeech(): void {
  stopPlayback();
  useCore.getState().setSpeaking(false);
}

import { useEffect } from "react";
import { useCore } from "@/stores/core";
import { useOrbState } from "./Orb";

export type Material = "ambient" | "desktop" | "solid";
export type Motion = "full" | "calm";

const KEY = "nexus.appearance";

/** Apply appearance attributes to <html>. Called early (before React) from main.tsx to avoid a flash. */
/** transparency: 0 (frosted) … 100 (clearest). Maps to the glass tint's alpha. */
export function applyAppearance(material: Material, motion: Motion, transparency?: number): void {
  const root = document.documentElement;
  root.dataset.material = material;
  root.dataset.motion = motion;
  let t = transparency;
  if (t === undefined) {
    try {
      t = (JSON.parse(localStorage.getItem(KEY) ?? "null") as { transparency?: number } | null)?.transparency;
    } catch {
      t = undefined;
    }
  }
  const tv = Math.max(0, Math.min(100, t ?? DEFAULT_TRANSPARENCY));
  root.style.setProperty("--glass-alpha", (0.6 - (tv / 100) * 0.52).toFixed(3));
  try {
    localStorage.setItem(KEY, JSON.stringify({ material, motion, transparency: tv }));
  } catch {
    /* storage unavailable */
  }
}

export const DEFAULT_TRANSPARENCY = 73;

export function restoreAppearance(): void {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { material?: Material; motion?: Motion; transparency?: number } | null;
    applyAppearance(v?.material ?? "ambient", v?.motion ?? "full", v?.transparency);
  } catch {
    applyAppearance("ambient", "full");
  }
}

/** Keeps <html> attributes in sync with the core's appearance settings and the orb's activity. */
function useAppearanceSync(fromCore: boolean): void {
  const appearance = useCore((s) => s.boot?.appearance);
  const activity = useOrbState();
  useEffect(() => {
    if (fromCore && appearance) applyAppearance(appearance.material, appearance.motion, appearance.transparency);
  }, [appearance, fromCore]);
  useEffect(() => {
    document.documentElement.dataset.activity = activity;
  }, [activity]);
}

/**
 * One light source for the whole UI: the pointer position is published as
 * --mx/--my (viewport px) at most once per frame, and every glass pane renders
 * its highlight from it with a fixed-attachment gradient. No per-element work.
 */
function useSpotlight(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    let raf = 0;
    let x = 0;
    let y = 0;
    const move = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (root.dataset.motion === "calm") return;
        root.style.setProperty("--mx", `${x}px`);
        root.style.setProperty("--my", `${y}px`);
      });
    };
    const leave = () => root.style.setProperty("--my", "-400px");
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.removeEventListener("pointerleave", leave);
      cancelAnimationFrame(raf);
    };
  }, [enabled]);
}

/** The ambient light field behind all glass. Not rendered in the floating window (the desktop is its backdrop). */
export function Ambient({ field = true, syncFromCore = true, spotlight = true }: { field?: boolean; syncFromCore?: boolean; spotlight?: boolean }) {
  useAppearanceSync(syncFromCore);
  useSpotlight(spotlight);
  if (!field) return null;
  return (
    <div className="ambient" aria-hidden>
      <div className="blob blob-a" />
      <div className="blob blob-b" />
      <div className="blob blob-c" />
      <div className="grain" />
      <div className="vignette" />
    </div>
  );
}

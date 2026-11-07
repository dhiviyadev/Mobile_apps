/** Thin bridge to the Tauri shell. Every call degrades gracefully in a plain browser (dev mode). */
import type { Event, UnlistenFn } from "@tauri-apps/api/event";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface CoreInfo {
  baseUrl: string;
  token: string | null;
  spawned?: boolean;
  error?: string | null;
}

export function windowLabel(): "main" | "mini" {
  const params = new URLSearchParams(window.location.search);
  if (params.get("window") === "mini") return "mini";
  if (isTauri) {
    const label = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
      .__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
    if (label === "mini") return "mini";
  }
  return "main";
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri) return null;
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args);
}

export async function coreInfo(): Promise<CoreInfo> {
  const fromShell = await invoke<CoreInfo>("core_info").catch((e: unknown) => ({ baseUrl: "http://127.0.0.1:8765", token: null, error: String(e) }));
  if (fromShell) return fromShell;
  // Browser dev mode: token from ?token=, VITE_NEXUS_TOKEN, or a previously pasted value.
  const params = new URLSearchParams(window.location.search);
  let token = params.get("token") || (import.meta.env.VITE_NEXUS_TOKEN as string | undefined) || null;
  try {
    if (token) localStorage.setItem("nexus.token", token);
    else token = localStorage.getItem("nexus.token");
  } catch {
    /* storage unavailable */
  }
  return { baseUrl: (import.meta.env.VITE_NEXUS_URL as string | undefined) || "http://127.0.0.1:8765", token };
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  const { listen: l } = await import("@tauri-apps/api/event");
  return l<T>(event, (e: Event<T>) => handler(e.payload));
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  if (!isTauri) return;
  const { emit: e } = await import("@tauri-apps/api/event");
  await e(event, payload);
}

export const shell = {
  showMain: (route?: string) => invoke("show_main", { route: route ?? null }),
  toggleMini: () => invoke("toggle_mini"),
  hideMini: () => invoke("hide_mini"),
  setMiniExpanded: (expanded: boolean) => invoke("set_mini_expanded", { expanded }),
  setMiniHeight: (height: number) => invoke("set_mini_height", { height }),
  setAlwaysOnTop: (on: boolean) => invoke("set_mini_always_on_top", { on }),
  pickFolder: () => invoke<string | null>("pick_folder"),
  startDragging: async () => {
    if (!isTauri) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
  },
};

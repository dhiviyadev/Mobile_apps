import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

type State = "loading" | "unsupported" | "needs-install" | "off" | "on" | "blocked" | "disabled-on-mac";

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function b64url(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

/** Lets this phone receive notifications from the Mac (approvals, finished tasks, alerts). Off until switched on here. */
export function PushToggle() {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      // On iPhone, notifications only exist once the app is on the Home Screen.
      setState(isIOS() && !isStandalone() ? "needs-install" : "unsupported");
      return;
    }
    try {
      const status = await api.get<{ enabled: boolean }>("/api/push");
      if (!status.enabled) return setState("disabled-on-mac");
      if (Notification.permission === "denied") return setState("blocked");
      const reg = await navigator.serviceWorker.ready;
      setState((await reg.pushManager.getSubscription()) ? "on" : "off");
    } catch (e) {
      setError((e as Error).message);
      setState("off");
    }
  };
  useEffect(() => void check(), []);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const { public_key } = await api.get<{ public_key: string }>("/api/push");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(public_key) });
      await api.post("/api/push/subscribe", { endpoint: sub.endpoint, p256dh: b64url(sub.getKey("p256dh")), auth: b64url(sub.getKey("auth")) });
      setState("on");
      await api.post("/api/push/test");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.post("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => undefined);
        await sub.unsubscribe();
      }
      setState("off");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const text: Record<State, string> = {
    loading: "Checking…",
    unsupported: "This browser can't show notifications.",
    "needs-install": "Add NEXUS to your Home Screen first (Share → Add to Home Screen), then open it from there.",
    off: "Get told when NEXUS needs your approval or finishes a task.",
    on: "On. You'll hear about approvals, finished tasks and alerts.",
    blocked: "Notifications are blocked for NEXUS in this phone's settings.",
    "disabled-on-mac": "Phone notifications are switched off on your Mac (Settings → Phone).",
  };
  const canToggle = state === "off" || state === "on";

  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 flex-none place-items-center rounded-full border border-white/10 bg-white/[0.06]">
          {state === "on" ? <Bell size={15} className="text-ok" /> : <BellOff size={15} className="text-muted" />}
        </div>
        <p className="min-w-0 flex-1 text-[13.5px] leading-snug text-fg-2">{text[state]}</p>
        {canToggle && (
          <button
            onClick={() => void (state === "on" ? disable() : enable())}
            disabled={busy}
            className="press h-9 flex-none rounded-full border border-white/15 bg-white/[0.09] px-4 text-[13px] font-medium text-fg disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : state === "on" ? "Turn off" : "Turn on"}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-[12.5px] text-danger">{error}</p>}
      <p className="mt-2 text-[11.5px] leading-snug text-muted">
        Messages are short and encrypted so only this phone can read them. They pass through {isIOS() ? "Apple's" : "your phone maker's"} notification service, which is how any app wakes a phone.
      </p>
    </div>
  );
}

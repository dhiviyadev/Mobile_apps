import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import { Activity, BookOpen, Home as HomeIcon, Loader2, MessageSquare, OctagonX, Play, Workflow } from "lucide-react";
import { useCore } from "@/stores/core";
import { useChat } from "@/stores/chat";
import { api, ApiError, setDeviceToken } from "@/lib/api";
import { bus } from "@/lib/events";
import { Ambient } from "@/components/Ambient";
import { Orb, useOrbState, usePauseWhenHidden } from "@/components/Orb";
import { Button, Dot } from "@/components/ui";
import { cls } from "@/lib/format";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MChat, MHome, MKnowledge, MMore, MTasks } from "./screens";

export type Tab = "home" | "chat" | "tasks" | "knowledge" | "more";

const TABS: { id: Tab; label: string; icon: typeof HomeIcon }[] = [
  { id: "home", label: "Home", icon: HomeIcon },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "tasks", label: "Tasks", icon: Workflow },
  { id: "knowledge", label: "Search", icon: BookOpen },
  { id: "more", label: "Mac", icon: Activity },
];

const SPRING = { type: "spring", stiffness: 420, damping: 36, mass: 0.9 } as const;

export function MobileApp() {
  const { status, init, refresh } = useCore();
  const halted = useCore((s) => s.halted);
  const resume = useCore((s) => s.resume);
  const loadList = useChat((s) => s.loadList);
  const [tab, setTab] = useState<Tab>("home");
  const [paired, setPaired] = useState<boolean | null>(null);
  usePauseWhenHidden();

  // Pair automatically when opened from the QR code link (…/m/#pair=ABCD-EFGH).
  useEffect(() => {
    const m = /pair=([A-Za-z0-9-]+)/.exec(window.location.hash);
    if (m?.[1]) {
      history.replaceState(null, "", window.location.pathname);
      setPaired(false);
      void claim(m[1]).then((ok) => setPaired(ok));
      return;
    }
    setPaired(Boolean(localStorage.getItem("nexus.device_token")));
  }, []);

  useEffect(() => {
    if (!paired) return;
    void init();
    void loadList();
  }, [paired, init, loadList]);

  // Phones suspend background tabs: on return, refresh and reconnect the live stream.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && paired) {
        void refresh();
        bus.reconnectNow();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [paired, refresh]);

  if (paired === null) return null;
  if (!paired || status === "unauthorized") {
    return (
      <>
        <Ambient syncFromCore={false} spotlight={false} />
        <Pair
          revoked={status === "unauthorized"}
          onPaired={() => {
            setPaired(true);
            void refresh().then(() => bus.reconnectNow());
          }}
        />
      </>
    );
  }

  return (
    <>
      <Ambient syncFromCore={false} spotlight={false} />
      <div className="app-layer flex h-full flex-col">
        <Header tab={tab} />
        {halted && (
          <div className="relative z-10 flex items-center justify-between gap-2 border-b border-[#e6a6a6]/25 bg-[#e6a6a6]/12 px-4 py-2 text-[13px] text-[#f3c9c9] backdrop-blur-xl">
            <span className="flex items-center gap-2">
              <OctagonX size={15} /> Emergency stop is active
            </span>
            <Button size="sm" variant="secondary" icon={<Play size={12} />} onClick={() => void resume()}>
              Resume
            </Button>
          </div>
        )}
        {status === "offline" && (
          <div className="relative z-10 border-b border-white/10 bg-black/30 px-4 py-2 text-[13px] text-warn backdrop-blur-xl">
            Can't reach your Mac. Is it awake and connected to Tailscale?
          </div>
        )}
        <main className="relative min-h-0 flex-1">
          <div key={tab} className="page-enter absolute inset-0">
            <ErrorBoundary area={`mobile:${tab}`}>
              {tab === "home" && <MHome go={setTab} />}
              {tab === "chat" && <MChat />}
              {tab === "tasks" && <MTasks />}
              {tab === "knowledge" && <MKnowledge />}
              {tab === "more" && <MMore />}
            </ErrorBoundary>
          </div>
        </main>
        <TabBar tab={tab} setTab={setTab} />
      </div>
    </>
  );
}

function Header({ tab }: { tab: Tab }) {
  const orb = useOrbState();
  const ws = useCore((s) => s.ws);
  const approvals = useCore((s) => s.approvals.length);
  return (
    <header className="glass-chrome m-header relative z-20 flex-none border-b border-white/[0.07]">
      <div className="flex h-12 items-center gap-3 px-4">
        <Orb state={orb} size={26} />
        <p className="flex-1 font-[family-name:var(--font-display)] text-[15px] font-semibold tracking-[0.16em] text-fg">
          {tab === "home" ? "NEXUS" : TABS.find((t) => t.id === tab)?.label === "Mac" ? "YOUR MAC" : TABS.find((t) => t.id === tab)?.label.toUpperCase()}
        </p>
        {approvals > 0 && <span className="rounded-full border border-warn/30 bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">{approvals} to approve</span>}
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <Dot tone={ws === "open" ? "ok" : ws === "connecting" ? "warn" : "danger"} pulse={ws === "connecting"} />
          {ws === "open" ? "Live" : ws === "connecting" ? "Connecting" : "Offline"}
        </span>
      </div>
    </header>
  );
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const running = useCore((s) => Object.values(s.tasks).filter((t) => t.status === "running" || t.status === "queued").length);
  return (
    <nav className="m-tabbar pointer-events-none absolute inset-x-0 bottom-0 z-30 px-3">
      <div className="surface-elevated pointer-events-auto mx-auto flex h-[64px] max-w-[520px] items-center justify-around rounded-[28px] px-1.5">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cls("relative flex h-[52px] flex-1 flex-col items-center justify-center gap-0.5 rounded-[22px]", active ? "text-fg" : "text-muted")}
              aria-label={t.label}
            >
              {active && (
                <motion.span
                  layoutId="m-tab-pill"
                  transition={SPRING}
                  className="absolute inset-0 rounded-[22px] border border-white/[0.13] bg-[linear-gradient(180deg,rgba(255,255,255,0.15),rgba(255,255,255,0.05))] shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]"
                />
              )}
              <Icon size={20} strokeWidth={active ? 2.2 : 1.8} className={cls("relative", active && "drop-shadow-[0_0_8px_rgba(230,236,245,0.55)]")} />
              <span className="relative text-[10.5px] font-medium">{t.label}</span>
              {t.id === "tasks" && running > 0 && <span className="absolute right-[22%] top-1.5 h-2 w-2 rounded-full bg-accent shadow-[0_0_8px_rgba(230,236,245,0.8)]" />}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

async function claim(code: string): Promise<boolean> {
  try {
    const name = guessDeviceName();
    const res = await api.post<{ token: string }>("/api/devices/claim", { code, name });
    setDeviceToken(res.token);
    return true;
  } catch {
    return false;
  }
}

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Phone";
}

function Pair({ onPaired, revoked }: { onPaired: () => void; revoked: boolean }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(revoked ? "This phone is no longer paired. Create a new code on your Mac." : null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<{ token: string }>("/api/devices/claim", { code, name: guessDeviceName() });
      setDeviceToken(res.token);
      onPaired();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't reach your Mac.");
    } finally {
      setBusy(false);
    }
  };

  const fmt = (v: string) => {
    const c = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
  };

  return (
    <div className="app-layer flex h-full flex-col items-center justify-center px-6" style={{ paddingTop: "var(--safe-top)" }}>
      <motion.div initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 200, damping: 22 }} className="flex w-full max-w-[380px] flex-col items-center text-center">
        <Orb state={busy ? "thinking" : "idle"} size={132} />
        <h1 className="mt-7 bg-[linear-gradient(180deg,#ffffff_20%,#b9c0cb_100%)] bg-clip-text font-[family-name:var(--font-display)] text-[28px] font-semibold tracking-tight text-transparent">
          Pair with your Mac
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-fg-2">
          On your Mac, open NEXUS → Settings → Phone, turn on remote access and tap <span className="text-fg">Pair a phone</span>. Enter the code shown there, or scan its QR code.
        </p>
        <div className="surface silver-edge mt-7 w-full p-4">
          <input
            value={code}
            onChange={(e) => setCode(fmt(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && code.length === 9 && void submit()}
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            className="glass-inset h-14 w-full rounded-2xl text-center font-mono text-[24px]! tracking-[0.3em] text-fg placeholder:text-muted/60"
          />
          <Button variant="primary" className="mt-3 h-12 w-full text-[15px]" disabled={code.length !== 9 || busy} onClick={() => void submit()}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : "Pair this phone"}
          </Button>
          {err && <p className="mt-3 text-[13px] text-danger">{err}</p>}
        </div>
        <p className="mt-5 text-[12px] leading-relaxed text-muted">
          Your phone gets its own key, which you can revoke from your Mac at any time. Everything still runs on your Mac.
        </p>
      </motion.div>
    </div>
  );
}

/** Bottom sheet with drag-to-dismiss. */
export function Sheet({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            className="surface-elevated fixed inset-x-0 bottom-0 z-50 flex max-h-[86dvh] flex-col rounded-b-none! rounded-t-[30px] bg-[linear-gradient(180deg,rgba(255,255,255,0.09),rgba(255,255,255,0.03)),rgba(17,19,24,0.92)]"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 380, damping: 38 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info: PanInfo) => {
              if (info.offset.y > 110 || info.velocity.y > 600) onClose();
            }}
          >
            <div className="flex flex-none flex-col items-center pt-2.5">
              <div className="m-sheet-handle" />
              {title && <p className="mt-3 text-[15px] font-semibold text-fg">{title}</p>}
            </div>
            <div className="m-scroll min-h-0 flex-1 px-4 pb-[max(var(--safe-bottom),20px)] pt-3">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

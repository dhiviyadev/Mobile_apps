import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { KeyRound, Loader2, RefreshCw, X } from "lucide-react";
import { useCore } from "@/stores/core";
import { useChat } from "@/stores/chat";
import { CommandPalette, HaltedBanner, NAV, Sidebar, TitleBar } from "@/components/Shell";
import { ApprovalStack } from "@/components/Approvals";
import { Timeline } from "@/components/Timeline";
import { Orb, usePauseWhenHidden } from "@/components/Orb";
import { Ambient } from "@/components/Ambient";
import { Button, IconButton, Input } from "@/components/ui";
import { setToken } from "@/lib/api";
import { bus } from "@/lib/events";
import { isTauri, listen } from "@/lib/tauri";
import { Home } from "@/workspaces/Home";
import { Chat } from "@/workspaces/Chat";
import { Agents } from "@/workspaces/Agents";
import { Knowledge } from "@/workspaces/Knowledge";
import { Automations } from "@/workspaces/Automations";
import { System } from "@/workspaces/System";
import { Settings } from "@/workspaces/Settings";
import type { Workspace } from "@/lib/types";

const TITLES: Record<Workspace, string> = {
  home: "Command Centre", chat: "Chat", agents: "Agents", knowledge: "Knowledge", automations: "Automations", system: "System", settings: "Settings",
};

export function App() {
  const { status, init, workspace, setWorkspace, setPalette, paletteOpen, emergencyStop } = useCore();
  const loadList = useChat((s) => s.loadList);
  const openConv = useChat((s) => s.open);
  const newConv = useChat((s) => s.newConversation);
  usePauseWhenHidden();

  useEffect(() => {
    void init();
    void loadList();
  }, [init, loadList]);

  // Messages from the Tauri shell (tray menu, floating assistant).
  useEffect(() => {
    const offs = [
      listen<string | null>("nexus://navigate", (route) => {
        if (!route) return;
        if (route.startsWith("chat:")) {
          void openConv(route.slice(5));
          setWorkspace("chat");
        } else setWorkspace(route as Workspace);
      }),
      listen("nexus://emergency-stop", () => void emergencyStop()),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()));
  }, [openConv, setWorkspace, emergencyStop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "k") {
        e.preventDefault();
        setPalette(!paletteOpen);
      } else if (e.key === ",") {
        e.preventDefault();
        setWorkspace("settings");
      } else if (e.key === "n") {
        e.preventDefault();
        void newConv().then(() => setWorkspace("chat"));
      } else {
        const nav = NAV.find((n) => n.key === e.key);
        if (nav) {
          e.preventDefault();
          setWorkspace(nav.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, setPalette, setWorkspace, newConv]);

  if (status === "unauthorized" || (status === "offline" && !useCore.getState().boot)) {
    return (
      <>
        <Ambient />
        <ConnectionGate />
      </>
    );
  }
  if (status === "connecting" && !useCore.getState().boot) {
    return (
      <>
        <Ambient />
        <div className="app-layer flex h-full flex-col items-center justify-center gap-6">
          <div className="drag absolute inset-x-0 top-0 h-10" />
          <Orb state="thinking" size={96} />
          <p className="shimmer text-[12.5px]">Starting NEXUS…</p>
        </div>
      </>
    );
  }

  return (
    <>
    <Ambient />
    <div className="app-layer flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <TitleBar title={TITLES[workspace]} />
        <HaltedBanner />
        <div className={workspace === "chat" ? "min-h-0 flex-1" : "min-h-0 flex-1 overflow-y-auto"}>
          <AnimatePresence mode="wait">
            <motion.div
              key={workspace}
              initial={{ opacity: 0, y: 14, scale: 0.992 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.996, transition: { duration: 0.12 } }}
              transition={{ type: "spring", stiffness: 380, damping: 34, mass: 0.9 }}
              className="h-full"
            >
              {workspace === "home" && <Home />}
              {workspace === "chat" && <Chat />}
              {workspace === "agents" && <Agents />}
              {workspace === "knowledge" && <Knowledge />}
              {workspace === "automations" && <Automations />}
              {workspace === "system" && <System />}
              {workspace === "settings" && <Settings />}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      <TaskDrawer />
      <ApprovalStack />
      <CommandPalette />
    </div>
    </>
  );
}

function TaskDrawer() {
  const id = useCore((s) => s.focusTaskId);
  const focus = useCore((s) => s.focusTask);
  const text = useCore((s) => (id ? s.taskText[id] : undefined));
  const task = useCore((s) => (id ? s.tasks[id] : undefined));
  const workspace = useCore((s) => s.workspace);
  if (!id || workspace === "chat") return null;
  return (
    <motion.aside initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 380, damping: 34 }} className="glass-chrome flex w-[360px] flex-none flex-col border-l border-white/[0.07]">
      <div className="drag flex h-[46px] items-center justify-between px-3">
        <p className="text-[12px] font-medium text-fg-2">Task</p>
        <IconButton label="Close" className="no-drag" onClick={() => focus(null)}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <Timeline taskId={id} />
        {(task?.result || text) && (
          <div className="surface selectable whitespace-pre-wrap p-3 text-[12.5px] leading-relaxed text-fg-2">{task?.result ?? text}</div>
        )}
      </div>
    </motion.aside>
  );
}

function ConnectionGate() {
  const { status, error, refresh } = useCore();
  const [token, setTok] = useState("");
  return (
    <div className="app-layer flex h-full items-center justify-center">
      <div className="drag absolute inset-x-0 top-0 h-10" />
      <motion.div initial={{ opacity: 0, y: 16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 28 }} className="surface-elevated silver-edge w-[460px] p-7 text-center">
        <div className="mx-auto w-fit">
          <Orb state="idle" size={72} />
        </div>
        <h1 className="mt-5 text-[17px] font-semibold text-fg">{status === "unauthorized" ? "Authorise this window" : "NEXUS core is not running"}</h1>
        <p className="mt-2 text-[12.5px] leading-relaxed text-fg-2">
          {status === "unauthorized"
            ? "The local API token did not match. Paste the token from data/secrets/api_token."
            : isTauri
              ? "The desktop shell could not reach the core service on 127.0.0.1:8765. Check data/logs/core.log, or start it with scripts/dev.sh."
              : "Start the core with scripts/dev.sh (or `python -m nexus_core`), then reload."}
        </p>
        {error && <p className="mt-2 font-mono text-[11px] text-muted">{error}</p>}
        {(status === "unauthorized" || !isTauri) && (
          <div className="mt-4 flex gap-2">
            <Input value={token} onChange={(e) => setTok(e.target.value)} placeholder="API token" className="font-mono text-[12px]" />
            <Button
              variant="primary"
              icon={<KeyRound size={12} />}
              disabled={!token}
              onClick={() => {
                setToken(token.trim());
                void refresh().then(() => bus.reconnectNow());
              }}
            >
              Connect
            </Button>
          </div>
        )}
        <Button className="mt-4" variant="ghost" icon={status === "connecting" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} onClick={() => void refresh()}>
          Retry
        </Button>
      </motion.div>
    </div>
  );
}

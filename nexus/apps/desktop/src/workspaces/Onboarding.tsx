import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Check, FolderPlus, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { shell } from "@/lib/tauri";
import { useCore } from "@/stores/core";
import { Orb } from "@/components/Orb";
import { Button, Input } from "@/components/ui";
import { GetModels } from "./SettingsExtras";

const STEPS = ["Welcome", "Your assistant's brain", "Your documents", "Ready"] as const;

/** First-run guide: name → local model → an approved folder. Shown once; every step can be skipped. */
export function Onboarding() {
  const done = useCore((s) => s.boot?.onboarding?.completed ?? true);
  const boot = useCore((s) => s.boot);
  const refresh = useCore((s) => s.refresh);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [folderMsg, setFolderMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [closing, setClosing] = useState(false);

  if (done || closing) return null;

  const finish = async () => {
    setClosing(true);
    await api.patch("/api/settings", { values: { "onboarding.completed": true } }).catch(() => undefined);
    void refresh();
  };

  const next = async () => {
    if (step === 0 && name.trim()) await api.patch("/api/settings", { values: { "profile.name": name.trim() } }).catch(() => undefined);
    if (step === STEPS.length - 1) return finish();
    void refresh();
    setStep(step + 1);
  };

  const addFolder = async () => {
    setFolderMsg(null);
    try {
      await api.post("/api/folders", { path: path.trim() });
      setFolderMsg({ ok: true, text: "Added. NEXUS is reading it in the background." });
      setPath("");
      void refresh();
    } catch (e) {
      setFolderMsg({ ok: false, text: (e as Error).message });
    }
  };

  const installed = boot?.ollama.installed ?? 0;

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/55 backdrop-blur-xl" role="dialog" aria-modal="true" aria-label="Set up NEXUS">
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 300, damping: 28 }}
        className="surface-elevated silver-edge flex max-h-[86vh] w-[620px] flex-col overflow-hidden rounded-[28px]"
      >
        <div className="flex items-center gap-2 px-7 pt-6">
          {STEPS.map((s, i) => (
            <span key={s} className={`h-1 flex-1 rounded-full transition-colors duration-500 ${i <= step ? "bg-white/70" : "bg-white/12"}`} />
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div key={step} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.25 }}>
              {step === 0 && (
                <div className="text-center">
                  <div className="mx-auto w-fit">
                    <Orb state="idle" size={84} />
                  </div>
                  <h1 className="mt-5 font-[family-name:var(--font-display)] text-[24px] font-semibold tracking-tight text-fg">Welcome to NEXUS</h1>
                  <p className="mx-auto mt-2 max-w-[440px] text-[13.5px] leading-relaxed text-fg-2">
                    Your own assistant that runs on this Mac. Your chats, files and memories stay here unless you choose otherwise.
                  </p>
                  <div className="mx-auto mt-6 max-w-[320px] text-left">
                    <label className="mb-1.5 block text-[12px] text-muted" htmlFor="onb-name">
                      What should I call you? (optional)
                    </label>
                    <Input id="onb-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your first name" maxLength={60} onKeyDown={(e) => e.key === "Enter" && void next()} />
                  </div>
                </div>
              )}
              {step === 1 && (
                <div>
                  <h2 className="text-[18px] font-semibold text-fg">Choose a model</h2>
                  <p className="mb-4 mt-1 text-[13px] leading-relaxed text-fg-2">
                    {installed > 0
                      ? `You already have ${installed} model${installed === 1 ? "" : "s"} installed, so you're ready. You can add more now or later in Settings.`
                      : "NEXUS thinks with a model that runs on your Mac. Pick one to download — the first is a good everyday choice. Downloads are large, so this can take a while; you can carry on in the meantime."}
                  </p>
                  <GetModels />
                </div>
              )}
              {step === 2 && (
                <div>
                  <h2 className="text-[18px] font-semibold text-fg">Let NEXUS read a folder</h2>
                  <p className="mt-1 text-[13px] leading-relaxed text-fg-2">
                    Choose a folder of documents you'd like to ask questions about. NEXUS only ever reads folders you approve here — never the rest of your Mac.
                  </p>
                  <div className="mt-4 flex gap-2">
                    <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/Documents/Project" className="flex-1 font-mono text-[12px]" />
                    <Button onClick={() => void shell.pickFolder().then((p) => p && setPath(p))}>Choose…</Button>
                    <Button variant="primary" icon={<FolderPlus size={13} />} disabled={!path.trim()} onClick={() => void addFolder()}>
                      Approve
                    </Button>
                  </div>
                  {folderMsg && <p className={`mt-2 text-[12.5px] ${folderMsg.ok ? "text-ok" : "text-danger"}`}>{folderMsg.text}</p>}
                  {(boot?.folders.length ?? 0) > 0 && (
                    <ul className="mt-3 space-y-1 text-[12.5px] text-fg-2">
                      {boot!.folders.map((f) => (
                        <li key={f.id} className="flex items-center gap-2">
                          <Check size={12} className="text-ok" /> <span className="truncate">{f.path}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-4 flex items-start gap-2 text-[12px] leading-snug text-muted">
                    <ShieldCheck size={14} className="mt-0.5 flex-none" /> Read-only by default. You can remove a folder or change what's allowed at any time in Knowledge.
                  </p>
                </div>
              )}
              {step === 3 && (
                <div className="text-center">
                  <div className="mx-auto w-fit">
                    <Orb state="idle" size={72} />
                  </div>
                  <h2 className="mt-5 text-[20px] font-semibold text-fg">You're all set{name.trim() ? `, ${name.trim()}` : ""}</h2>
                  <ul className="mx-auto mt-4 max-w-[400px] space-y-2 text-left text-[13px] text-fg-2">
                    <li>
                      <b className="text-fg">⌥ Space</b> opens the floating assistant from anywhere.
                    </li>
                    <li>
                      <b className="text-fg">⌥ ⇧ Q</b> works on text you've copied: summarise, rewrite, reply.
                    </li>
                    <li>
                      <b className="text-fg">⌘ K</b> jumps to anything inside NEXUS.
                    </li>
                    <li>Web search, calendar and phone access are off until you turn them on in Settings.</li>
                  </ul>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="flex items-center justify-between border-t border-white/[0.07] px-7 py-4">
          <button className="text-[12.5px] text-muted hover:text-fg-2" onClick={() => void finish()}>
            {step === STEPS.length - 1 ? "" : "Skip setup"}
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button variant="ghost" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <Button variant="primary" icon={step === STEPS.length - 1 ? <Check size={13} /> : <ArrowRight size={13} />} onClick={() => void next()}>
              {step === STEPS.length - 1 ? "Start using NEXUS" : step === 0 ? "Get started" : "Continue"}
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

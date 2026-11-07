import { useEffect, useState, type ReactNode } from "react";
import { Archive, Copy, KeyRound, Smartphone, Volume2 } from "lucide-react";
import { motion } from "framer-motion";
import { api } from "@/lib/api";
import { useCore } from "@/stores/core";
import type { HermesStatus, ModelsResponse, VoiceStatus } from "@/lib/types";
import { Badge, Button, Card, Input, SectionTitle, Segmented, Select, Toggle } from "@/components/ui";
import { Orb } from "@/components/Orb";
import { QRCode } from "@/components/QRCode";
import { applyAppearance, type Material, type Motion } from "@/components/Ambient";
import { HermesCard } from "./Agents";
import { speak } from "@/hooks/useVoice";
import { invoke, isTauri } from "@/lib/tauri";
import { bytes, cls, relTime } from "@/lib/format";

type Values = Record<string, unknown>;
type Section = "general" | "appearance" | "phone" | "models" | "hermes" | "cloud" | "voice" | "scripts" | "security" | "backup";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "phone", label: "Phone" },
  { id: "models", label: "Models" },
  { id: "hermes", label: "Hermes" },
  { id: "cloud", label: "Cloud (optional)" },
  { id: "voice", label: "Voice" },
  { id: "scripts", label: "Scripts & apps" },
  { id: "security", label: "Security & audit" },
  { id: "backup", label: "Backup" },
];

export function Settings() {
  const [section, setSection] = useState<Section>("general");
  const [values, setValues] = useState<Values>({});
  const [stat, setStat] = useState<Record<string, unknown>>({});
  const refresh = useCore((s) => s.refresh);
  const load = () => void api.get<{ values: Values; static: Record<string, unknown> }>("/api/settings").then((r) => {
    setValues(r.values);
    setStat(r.static);
  });
  useEffect(load, []);
  const set = async (key: string, value: unknown) => {
    setValues((v) => ({ ...v, [key]: value }));
    await api.patch("/api/settings", { values: { [key]: value } });
    void refresh();
  };

  return (
    <div className="mx-auto flex max-w-[1080px] gap-8 px-8 py-8">
      <nav className="w-44 flex-none space-y-0.5 pt-12">
        {SECTIONS.map((s) => (
          <button key={s.id} onClick={() => setSection(s.id)} className={cls("press relative flex h-8 w-full items-center rounded-full px-3 text-[13px] transition-colors", section === s.id ? "text-fg" : "text-fg-2 hover:bg-white/[0.04]")}>
            {section === s.id && (
              <motion.span
                layoutId="settings-pill"
                transition={{ type: "spring", stiffness: 480, damping: 36 }}
                className="absolute inset-0 rounded-full border border-white/[0.12] bg-white/[0.09] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
              />
            )}
            <span className="relative">{s.label}</span>
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        <SectionTitle title={SECTIONS.find((s) => s.id === section)!.label} />
        {section === "general" && <General values={values} set={set} stat={stat} />}
        {section === "appearance" && <Appearance values={values} set={set} />}
        {section === "phone" && <Phone />}
        {section === "models" && <Models values={values} set={set} />}
        {section === "hermes" && <Hermes />}
        {section === "cloud" && <CloudSettings values={values} set={set} />}
        {section === "voice" && <Voice values={values} set={set} />}
        {section === "scripts" && <Scripts />}
        {section === "security" && <Security />}
        {section === "backup" && <Backup stat={stat} />}
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line-soft py-3 last:border-0">
      <div className="min-w-0">
        <p className="text-[13px] text-fg">{label}</p>
        {hint && <p className="text-[11.5px] leading-snug text-muted">{hint}</p>}
      </div>
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  );
}

function TextSetting({ value, onSave, placeholder, className, type }: { value: string; onSave: (v: string) => void; placeholder?: string; className?: string; type?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <Input type={type} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} onKeyDown={(e) => e.key === "Enter" && onSave(v)} className={className ?? "w-64"} />;
}

type SetFn = (k: string, v: unknown) => Promise<void>;

function General({ values, set, stat }: { values: Values; set: SetFn; stat: Record<string, unknown> }) {
  return (
    <Card>
      <Row label="Your name" hint="Used in greetings and given to the assistant as context.">
        <TextSetting value={String(values["profile.name"] ?? "")} onSave={(v) => void set("profile.name", v)} placeholder="Name" />
      </Row>
      <Row label="Native notifications" hint="Show macOS notifications for finished automations and alerts.">
        <Toggle checked={Boolean(values["notifications.native"])} onChange={(v) => void set("notifications.native", v)} />
      </Row>
      <Row label="Use reviewed memory in chat" hint="Include approved long-term memories as context.">
        <Toggle checked={Boolean(values["memory.inject_in_chat"])} onChange={(v) => void set("memory.inject_in_chat", v)} />
      </Row>
      <Row label="Agent runtime" hint="Auto prefers Hermes and falls back to the NEXUS native runtime.">
        <Select value={String(values["agents.runtime"] ?? "auto")} onChange={(v) => void set("agents.runtime", v)} options={[{ value: "auto", label: "Auto" }, { value: "hermes", label: "Hermes" }, { value: "native", label: "NEXUS native" }]} />
      </Row>
      <Row label="Max agent steps" hint="Tool-calling iterations per native task.">
        <Select value={String(values["agents.max_steps"] ?? 8)} onChange={(v) => void set("agents.max_steps", Number(v))} options={[4, 6, 8, 12, 16].map((n) => ({ value: String(n), label: String(n) }))} />
      </Row>
      {isTauri && <LaunchAtLogin />}
      <Row label="Data directory" hint="Database, workspace, logs and backups. Kept separate from source code.">
        <span className="font-mono text-[11.5px] text-muted">{String(stat.data_dir ?? "")}</span>
      </Row>
      <Row label="Keyboard shortcuts">
        <span className="text-[12px] text-fg-2">⌥Space floating assistant · ⌥⇧Space push-to-talk · ⌘K commands</span>
      </Row>
    </Card>
  );
}

function Appearance({ values, set }: { values: Values; set: SetFn }) {
  const material = (values["appearance.material"] as Material) ?? "ambient";
  const motion = (values["appearance.motion"] as Motion) ?? "full";
  const change = (m: Material, mo: Motion) => {
    applyAppearance(m, mo); // instant locally; the other window follows via the core
    void set("appearance.material", m);
    void set("appearance.motion", mo);
  };
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-6">
          <div className="flex gap-5">
            {(["idle", "listening", "thinking", "executing"] as const).map((st) => (
              <div key={st} className="flex flex-col items-center gap-2">
                <Orb state={st} size={56} level={st === "listening" ? 0.5 : 0} />
                <span className="text-[11px] capitalize text-muted">{st}</span>
              </div>
            ))}
          </div>
          <p className="text-[12.5px] leading-relaxed text-fg-2">
            Liquid glass surfaces over a slow ambient light field. The field brightens while NEXUS is thinking or working, and one soft light follows your pointer across every pane.
          </p>
        </div>
      </Card>
      <Card>
        <Row label="Material" hint="Ambient: glass over NEXUS's light field. Desktop: see-through to your wallpaper (macOS vibrancy). Solid: opaque graphite — lightest on the GPU.">
          <Segmented<Material>
            value={material}
            onChange={(m) => change(m, motion)}
            options={[
              { value: "ambient", label: "Ambient" },
              { value: "desktop", label: "Desktop" },
              { value: "solid", label: "Solid" },
            ]}
          />
        </Row>
        <Row label="Motion" hint="Calm freezes the ambient field and the pointer light, and slows the orb. macOS Reduce Motion and Reduce Transparency are always respected.">
          <Segmented<Motion>
            value={motion}
            onChange={(mo) => change(material, mo)}
            options={[
              { value: "full", label: "Full" },
              { value: "calm", label: "Calm" },
            ]}
          />
        </Row>
      </Card>
    </div>
  );
}

interface RemoteStatus {
  enabled: boolean;
  hostnames: string[];
  mobile_app_built: boolean;
  tailscale: { installed: boolean; dns_name: string | null; online: boolean; serving_nexus: boolean; serve_command: string };
  devices: { id: string; name: string; created_at: string; last_seen_at: string | null; last_ip: string | null; revoked: number }[];
}

function Phone() {
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [host, setHost] = useState("");
  const [code, setCode] = useState<{ code: string; expires_in: number } | null>(null);
  const [left, setLeft] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    void api.get<RemoteStatus>("/api/devices/remote").then((r) => {
      setSt(r);
      setHost((h) => h || r.hostnames[0] || r.tailscale.dns_name || "");
    });
  useEffect(load, []);
  useEffect(() => {
    if (!code) return;
    setLeft(code.expires_in);
    const t = setInterval(() => setLeft((l) => (l <= 1 ? (clearInterval(t), setCode(null), 0) : l - 1)), 1000);
    return () => clearInterval(t);
  }, [code]);

  const save = async (body: Partial<{ enabled: boolean; hostnames: string[] }>) => {
    setErr(null);
    try {
      setSt(await api.patch<RemoteStatus>("/api/devices/remote", body));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (!st) return null;
  const url = st.hostnames[0] ? `https://${st.hostnames[0]}/m/` : null;
  const ts = st.tailscale;
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start gap-4">
          <div className="grid h-11 w-11 flex-none place-items-center rounded-full border border-white/15 bg-[radial-gradient(circle_at_35%_25%,rgba(255,255,255,0.22),rgba(255,255,255,0.04)_60%)]">
            <Smartphone size={18} className="text-accent-strong" />
          </div>
          <p className="text-[12.5px] leading-relaxed text-fg-2">
            Use NEXUS from your phone: chat, run agents, <span className="text-fg">approve or deny actions</span>, review memories and trigger the emergency stop. Everything still runs on this Mac. Your phone connects through
            <span className="text-fg"> Tailscale</span> (encrypted, works away from home); NEXUS itself stays bound to this Mac only.
          </p>
        </div>
      </Card>
      <Card title="1 · Connection">
        <Row label="Tailscale" hint={ts.installed ? (ts.dns_name ? `This Mac is ${ts.dns_name}` : "Installed — sign in to your tailnet") : "Install Tailscale on this Mac and your phone, signed in to the same account."}>
          <Badge tone={ts.installed && ts.online ? "ok" : "warn"}>{ts.installed ? (ts.online ? "connected" : "offline") : "not installed"}</Badge>
        </Row>
        <Row label="Expose NEXUS to your tailnet" hint={<>Run once in Terminal (you decide; NEXUS doesn't change Tailscale). It gives this Mac an HTTPS address only your devices can reach.</>}>
          <code className="selectable rounded-lg bg-black/30 px-2 py-1 font-mono text-[12px] text-fg-2">{ts.serve_command}</code>
          <IconCopy text={ts.serve_command} />
          <Badge tone={ts.serving_nexus ? "ok" : "neutral"}>{ts.serving_nexus ? "serving" : "not detected"}</Badge>
        </Row>
        <Row label="Mac's address" hint="The hostname your phone uses, e.g. my-mac.tail1234.ts.net. Requests to any other name are refused.">
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="my-mac.tail1234.ts.net" className="w-64 font-mono text-[12px]" />
          <Button size="sm" onClick={() => void save({ hostnames: host ? [host] : [] })}>Save</Button>
        </Row>
        <Row label="Allow remote access" hint="Off by default. Turning it off instantly locks out every paired phone.">
          <Toggle checked={st.enabled} onChange={(v) => void save({ enabled: v })} />
        </Row>
        {err && <p className="text-[12px] text-danger">{err}</p>}
        {!st.mobile_app_built && <p className="mt-2 text-[12px] text-warn">The phone app isn't built yet — run <code className="font-mono">npm run build:mobile</code> in apps/desktop.</p>}
      </Card>
      <Card title="2 · Pair a phone">
        {code && url ? (
          <div className="flex items-center gap-6">
            <QRCode value={`${url}#pair=${code.code}`} size={168} />
            <div>
              <p className="font-mono text-[34px] font-semibold tracking-[0.18em] text-fg">{code.code}</p>
              <p className="mt-1 text-[12.5px] text-fg-2">Scan with your phone's camera, or open <span className="font-mono text-fg">{url}</span> and enter the code.</p>
              <p className="mt-2 text-[12px] text-muted">Single use · expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</p>
              <p className="mt-3 text-[12px] text-muted">Tip: on iPhone, tap Share → <span className="text-fg-2">Add to Home Screen</span> first, then pair from the home-screen app.</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <p className="text-[12.5px] text-fg-2">{!st.enabled ? "Turn on remote access first." : !url ? "Save your Mac's address first." : "Creates a one-time code valid for 5 minutes."}</p>
            <Button variant="primary" disabled={!st.enabled || !url} onClick={() => void api.post<{ code: string; expires_in: number }>("/api/devices/pair").then(setCode).catch((e: Error) => setErr(e.message))}>
              Pair a phone
            </Button>
          </div>
        )}
      </Card>
      <Card title="Paired devices">
        {st.devices.length === 0 && <p className="text-[12.5px] text-muted">No phones paired yet.</p>}
        {st.devices.map((d) => (
          <Row key={d.id} label={d.name} hint={`Paired ${relTime(d.created_at)} · last seen ${relTime(d.last_seen_at)}${d.last_ip ? ` from ${d.last_ip}` : ""}`}>
            {d.revoked ? <Badge tone="danger">revoked</Badge> : <Button size="sm" variant="danger" onClick={() => void api.post(`/api/devices/${d.id}/revoke`).then(load)}>Revoke</Button>}
            <Button size="sm" variant="ghost" onClick={() => void api.del(`/api/devices/${d.id}`).then(load)}>Remove</Button>
          </Row>
        ))}
        <p className="mt-3 text-[11.5px] leading-snug text-muted">
          Phones can't change folder permissions, secrets, scripts, agent tools, settings or devices, or open apps on this Mac. Their approvals and stops are recorded in the audit log under the device's name.
        </p>
      </Card>
    </div>
  );
}

function IconCopy({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button aria-label="Copy" className="press grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-white/[0.08] hover:text-fg" onClick={() => { void navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); }}>
      {ok ? <span className="text-[11px] text-ok">✓</span> : <Copy size={13} />}
    </button>
  );
}

function LaunchAtLogin() {
  const [on, setOn] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => void invoke<boolean>("launch_at_login_status").then((v) => setOn(Boolean(v))), []);
  return (
    <Row label="Launch at login" hint={err ?? "Start NEXUS in the menu bar when you log in."}>
      <Toggle
        checked={on}
        onChange={(v) => void invoke<boolean>("set_launch_at_login", { enabled: v }).then((r) => setOn(Boolean(r))).catch((e: unknown) => setErr(String(e)))}
      />
    </Row>
  );
}

function Models({ values, set }: { values: Values; set: SetFn }) {
  const [m, setM] = useState<ModelsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => void api.get<ModelsResponse>("/api/models").then(setM);
  useEffect(load, []);
  if (!m) return null;
  const chat = m.installed.filter((x) => !x.embedding);
  const emb = m.installed.filter((x) => x.embedding);
  const route = async (body: object) => {
    setErr(null);
    try {
      await api.patch("/api/models/routing", body);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      {!m.online && <Card><p className="text-[12.5px] text-danger">{m.error}</p><p className="mt-1 text-[12px] text-muted">Start Ollama (open the Ollama app or run `ollama serve`).</p></Card>}
      <Card title="Installed models (read from Ollama)">
        {m.installed.map((x) => (
          <div key={x.name} className="flex items-center gap-3 border-b border-line-soft py-2 last:border-0">
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{x.name}</span>
            {x.embedding && <Badge>embedding</Badge>}
            {x.loaded && <Badge tone="ok">loaded</Badge>}
            <span className="w-40 text-right text-[11.5px] text-muted">{[x.parameter_size, x.quantization].filter(Boolean).join(" · ")}</span>
            <span className="w-20 text-right text-[11.5px] text-muted">{bytes(x.size)}</span>
          </div>
        ))}
        {m.installed.length === 0 && m.online && <p className="text-[12.5px] text-muted">No models installed. Pull one with `ollama pull qwen3:14b` (see SETUP.md for recommendations).</p>}
      </Card>
      <Card title="Routing">
        <Row label="Default model" hint="Used for any category without its own assignment. Empty = smallest installed chat model.">
          <Select value={m.default ?? ""} onChange={(v) => void route({ default: v })} placeholder="Automatic" options={chat.map((x) => ({ value: x.name, label: x.name }))} />
        </Row>
        {m.categories.map((c) => (
          <Row key={c} label={c[0]!.toUpperCase() + c.slice(1)}>
            <Select value={m.routing[c] ?? ""} onChange={(v) => void route({ assignments: { [c]: v } })} placeholder="Use default" options={(c === "embeddings" ? emb : chat).map((x) => ({ value: x.name, label: x.name }))} />
          </Row>
        ))}
        {err && <p className="text-[12px] text-danger">{err}</p>}
      </Card>
      <Card title="Memory safety (24 GB unified memory)">
        <Row label="Single-model mode" hint="Unload other chat models before loading a new one, so only one large model is resident.">
          <Toggle checked={Boolean(values["models.single_model_mode"])} onChange={(v) => void set("models.single_model_mode", v)} />
        </Row>
        <Row label="Max share of free memory" hint="Refuse to load a model larger than this fraction of currently available memory.">
          <Select value={String(values["models.max_memory_fraction"] ?? 0.75)} onChange={(v) => void set("models.max_memory_fraction", Number(v))} options={[0.5, 0.6, 0.75, 0.85, 0.95].map((n) => ({ value: String(n), label: `${Math.round(n * 100)}%` }))} />
        </Row>
        <Row label="Keep-alive" hint="How long Ollama keeps an idle model in memory.">
          <Select value={String(values["models.keep_alive"] ?? "10m")} onChange={(v) => void set("models.keep_alive", v)} options={["2m", "5m", "10m", "30m", "1h"].map((n) => ({ value: n, label: n }))} />
        </Row>
        <Row label="Context window" hint="Larger contexts use substantially more memory (KV cache).">
          <Select value={String(values["models.num_ctx"] ?? 8192)} onChange={(v) => void set("models.num_ctx", Number(v))} options={[4096, 8192, 16384, 32768].map((n) => ({ value: String(n), label: String(n) }))} />
        </Row>
      </Card>
    </div>
  );
}

function SecretField({ account, label }: { account: string; label: string }) {
  const [has, setHas] = useState<boolean | null>(null);
  const [kc, setKc] = useState(true);
  const [v, setV] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => void api.get<{ keychain_available: boolean; secrets: Record<string, boolean> }>("/api/secrets").then((r) => {
    setHas(r.secrets[account] ?? false);
    setKc(r.keychain_available);
  });
  useEffect(load, [account]);
  return (
    <Row label={label} hint={kc ? "Stored in the macOS Keychain. NEXUS never displays it again." : "Keychain unavailable on this OS — use the NEXUS_SECRET_* environment variable."}>
      {has && <Badge tone="ok"><KeyRound size={10} /> stored</Badge>}
      <Input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder={has ? "Replace…" : "Paste key"} className="w-52" />
      <Button size="sm" disabled={!v || !kc} onClick={() => void api.post("/api/secrets", { account, value: v }).then(() => { setV(""); setMsg("Saved"); load(); }).catch((e: Error) => setMsg(e.message))}>Save</Button>
      {has && <Button size="sm" variant="ghost" onClick={() => void api.del(`/api/secrets/${account}`).then(load)}>Remove</Button>}
      {msg && <span className="text-[11px] text-muted">{msg}</span>}
    </Row>
  );
}

function Hermes() {
  const [st, setSt] = useState<HermesStatus | null>(null);
  const load = () => void api.get<HermesStatus>("/api/hermes/status").then(setSt);
  useEffect(load, []);
  return (
    <div className="space-y-4">
      <HermesCard st={st} />
      <Card title="Connection">
        <SecretField account="hermes.api_key" label="Hermes API server key" />
        <Row label="API server URL" hint="Set NEXUS_HERMES_API_URL to change. NEXUS only connects; it never edits Hermes configuration.">
          <span className="font-mono text-[12px] text-muted">{st?.api_url}</span>
          <Button size="sm" variant="ghost" onClick={load}>Re-check</Button>
        </Row>
      </Card>
      <Card title="Enable the Hermes API server (do this yourself)">
        <p className="text-[12.5px] leading-relaxed text-fg-2">
          Add these lines to <code className="font-mono">~/.hermes/.env</code>, run <code className="font-mono">hermes gateway</code>, then paste the same key above. Without it NEXUS uses Hermes' CLI one-shot mode (if <code className="font-mono">hermes</code> is on PATH) or the NEXUS native runtime.
        </p>
        <pre className="selectable mt-3 rounded-xl border border-line bg-black/30 p-3 font-mono text-[12px] text-fg-2">{`API_SERVER_ENABLED=true\nAPI_SERVER_KEY=<a long random string>`}</pre>
      </Card>
    </div>
  );
}

function CloudSettings({ values, set }: { values: Values; set: SetFn }) {
  const provider = String(values["cloud.provider"] ?? "");
  return (
    <div className="space-y-4">
      <Card>
        <p className="text-[12.5px] leading-relaxed text-fg-2">
          NEXUS is local-first. Cloud models are off by default and, even when enabled, each message needs your explicit per-message consent (cloud icon in the composer). A Claude Pro/Max subscription does not include API access — an API key from the provider's console is billed separately.
        </p>
      </Card>
      <Card>
        <Row label="Enable cloud models">
          <Toggle checked={Boolean(values["cloud.enabled"])} onChange={(v) => void set("cloud.enabled", v)} />
        </Row>
        <Row label="Provider">
          <Select value={provider} onChange={(v) => void set("cloud.provider", v)} placeholder="None" options={[{ value: "anthropic", label: "Anthropic API" }, { value: "openai_compatible", label: "OpenAI-compatible endpoint" }]} />
        </Row>
        <Row label="Model ID" hint="Exactly as the provider names it.">
          <TextSetting value={String(values["cloud.model"] ?? "")} onSave={(v) => void set("cloud.model", v)} placeholder="model id" />
        </Row>
        {provider === "openai_compatible" && (
          <Row label="Base URL">
            <TextSetting value={String(values["cloud.base_url"] ?? "")} onSave={(v) => void set("cloud.base_url", v)} placeholder="https://…/v1" />
          </Row>
        )}
        {provider && <SecretField account={`cloud.${provider}`} label="API key" />}
        <Row label="Allow local documents to be sent" hint="When off, a cloud request that would include attachments or knowledge excerpts is refused.">
          <Toggle checked={Boolean(values["cloud.allow_documents"])} onChange={(v) => void set("cloud.allow_documents", v)} />
        </Row>
      </Card>
    </div>
  );
}

function Voice({ values, set }: { values: Values; set: SetFn }) {
  const [st, setSt] = useState<VoiceStatus | null>(null);
  const [voices, setVoices] = useState<{ id: string; locale: string }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void api.get<VoiceStatus>("/api/voice/status").then(setSt);
    void api.get<typeof voices>("/api/voice/voices").then(setVoices);
  }, [values]);
  return (
    <div className="space-y-4">
      <Card title="Engines detected on this Mac">
        <Row label="Speech recognition" hint="mlx-whisper (Apple Silicon GPU) or whisper.cpp. Audio is processed locally.">
          {st?.stt_engines.length ? st.stt_engines.map((e) => <Badge key={e} tone="ok">{e}</Badge>) : <Badge tone="warn">not installed</Badge>}
        </Row>
        <Row label="Speech synthesis">
          {st?.tts_engines.length ? st.tts_engines.map((e) => <Badge key={e} tone="ok">{e}</Badge>) : <Badge tone="warn">not available</Badge>}
        </Row>
        <Row label="ffmpeg" hint="Converts recorded audio for transcription.">
          <Badge tone={st?.ffmpeg ? "ok" : "warn"}>{st?.ffmpeg ? "found" : "missing"}</Badge>
        </Row>
      </Card>
      <Card title="Preferences">
        <Row label="Recognition engine">
          <Select value={String(values["voice.stt_engine"] ?? "auto")} onChange={(v) => void set("voice.stt_engine", v)} options={[{ value: "auto", label: "Auto" }, { value: "mlx", label: "MLX Whisper" }, { value: "whispercpp", label: "whisper.cpp" }]} />
        </Row>
        <Row label="Whisper model" hint="whisper.cpp: path to a ggml .bin file. MLX: a Hugging Face repo id (default mlx-community/whisper-small-mlx).">
          <TextSetting value={String(values["voice.whisper_model"] ?? "")} onSave={(v) => void set("voice.whisper_model", v)} placeholder="/path/ggml-small.en.bin" className="w-72 font-mono text-[12px]" />
        </Row>
        <Row label="Read replies aloud" hint="Off by default. The microphone is only ever used during push-to-talk.">
          <Toggle checked={Boolean(values["voice.tts_enabled"])} onChange={(v) => void set("voice.tts_enabled", v)} />
        </Row>
        <Row label="Voice">
          <Select value={String(values["voice.voice"] ?? "")} onChange={(v) => void set("voice.voice", v)} placeholder="System default" options={voices.map((v) => ({ value: v.id, label: `${v.id} (${v.locale})` }))} />
          <Button size="sm" icon={<Volume2 size={12} />} disabled={!st?.tts_available} onClick={() => void speak("Hello. I'm NEXUS, running entirely on your Mac.").catch((e: Error) => setMsg(e.message))}>Test</Button>
        </Row>
        {msg && <p className="text-[12px] text-danger">{msg}</p>}
      </Card>
    </div>
  );
}

function Scripts() {
  const [data, setData] = useState<{ dir: string; scripts: { id: string; name: string; path: string; description: string; timeout_s: number }[] } | null>(null);
  const [name, setName] = useState("");
  const [file, setFile] = useState("");
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [apps, setApps] = useState<string[]>([]);
  const load = () => void api.get<typeof data>("/api/scripts").then(setData);
  useEffect(() => {
    load();
    void api.get<string[]>("/api/apps").then(setApps);
  }, []);
  return (
    <div className="space-y-4">
      <Card>
        <p className="text-[12.5px] leading-relaxed text-fg-2">
          Agents have no general shell. They can only run scripts you place in <code className="font-mono">{data?.dir}</code> and register here — each run still asks for approval, executes without a shell, with a timeout and a minimal environment.
        </p>
      </Card>
      <Card title="Approved scripts">
        {data?.scripts.map((s) => (
          <Row key={s.id} label={s.name} hint={`${s.path} · ${s.timeout_s}s timeout${s.description ? ` · ${s.description}` : ""}`}>
            <Button size="sm" variant="ghost" onClick={() => void api.del(`/api/scripts/${s.id}`).then(load)}>Remove</Button>
          </Row>
        ))}
        <div className="mt-3 flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="w-40" />
          <Input value={file} onChange={(e) => setFile(e.target.value)} placeholder="filename.sh" className="w-44 font-mono text-[12px]" />
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What it does" />
          <Button variant="primary" disabled={!name || !file} onClick={() => void api.post("/api/scripts", { name, filename: file, description: desc }).then(() => { setName(""); setFile(""); setDesc(""); setErr(null); load(); }).catch((e: Error) => setErr(e.message))}>Register</Button>
        </div>
        {err && <p className="mt-2 text-[12px] text-danger">{err}</p>}
      </Card>
      <Card title={`Applications (${apps.length})`}>
        <p className="mb-2 text-[12px] text-muted">Agents can request to open these (with approval). Click to open one yourself.</p>
        <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
          {apps.map((a) => (
            <button key={a} onClick={() => void api.post("/api/apps/open", { name: a })} className="h-6 rounded-md border border-line-soft px-2 text-[11.5px] text-fg-2 hover:border-line hover:text-fg">{a}</button>
          ))}
          {apps.length === 0 && <p className="text-[12px] text-muted">No /Applications folder on this system.</p>}
        </div>
      </Card>
    </div>
  );
}

interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  decision: string;
}

function Security() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [approvals, setApprovals] = useState<{ id: string; title: string; status: string; source: string; created_at: string }[]>([]);
  useEffect(() => {
    void api.get<AuditRow[]>("/api/audit?limit=300").then(setRows);
    void api.get<typeof approvals>("/api/approvals?history=true").then(setApprovals);
  }, []);
  return (
    <div className="space-y-4">
      <Card title="Controls in force">
        <ul className="space-y-1.5 text-[12.5px] text-fg-2">
          <li>• Core API bound to 127.0.0.1 with a per-install bearer token and DNS-rebinding protection</li>
          <li>• Agents read only approved folders; write and execute are separate grants; credential stores are always blocked</li>
          <li>• Overwrites, deletions, scripts, app launches and approval-gated automations wait for you</li>
          <li>• No general shell access for agents · secrets live in the macOS Keychain · cloud is off by default</li>
        </ul>
      </Card>
      <Card title="Approval history">
        {approvals.slice(0, 20).map((a) => (
          <div key={a.id} className="flex items-center gap-3 py-1 text-[12.5px]">
            <Badge tone={a.status === "approved" ? "ok" : a.status === "denied" ? "danger" : "neutral"}>{a.status}</Badge>
            <span className="flex-1 truncate text-fg-2">{a.title}</span>
            <span className="text-[11px] text-muted">{a.source} · {relTime(a.created_at)}</span>
          </div>
        ))}
        {approvals.length === 0 && <p className="text-[12.5px] text-muted">No approvals yet.</p>}
      </Card>
      <Card title="Audit log" pad>
        <div className="max-h-[420px] overflow-y-auto font-mono text-[11.5px]">
          {rows.map((r) => (
            <div key={r.id} className="grid grid-cols-[150px_120px_140px_1fr_70px] gap-2 border-b border-line-soft py-1 text-fg-2">
              <span className="text-muted">{new Date(r.ts).toLocaleString()}</span>
              <span className="truncate">{r.actor}</span>
              <span className="truncate">{r.action}</span>
              <span className="selectable truncate text-muted" title={r.target ?? ""}>{r.target}</span>
              <span className={r.decision === "denied" ? "text-danger" : r.decision === "executed" ? "text-ok" : ""}>{r.decision}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Backup({ stat }: { stat: Record<string, unknown> }) {
  const [list, setList] = useState<{ name: string; path: string; bytes: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => void api.get<typeof list>("/api/system/backups").then(setList);
  useEffect(load, []);
  return (
    <Card>
      <Row label="Create a backup" hint="Consistent snapshot of the database (SQLite backup API) plus your NEXUS workspace, as a .tar.gz in the data folder.">
        <Button icon={<Archive size={12} />} disabled={busy} onClick={() => { setBusy(true); void api.post("/api/system/backup").then(load).finally(() => setBusy(false)); }}>{busy ? "Backing up…" : "Back up now"}</Button>
      </Row>
      {list.map((b) => (
        <Row key={b.name} label={b.name} hint={b.path}>
          <span className="text-[11.5px] text-muted">{bytes(b.bytes)}</span>
        </Row>
      ))}
      <p className="mt-3 text-[11.5px] text-muted">Restore with <code className="font-mono">scripts/restore.sh &lt;backup.tar.gz&gt;</code> while NEXUS is quit. Data folder: {String(stat.data_dir ?? "")}</p>
    </Card>
  );
}

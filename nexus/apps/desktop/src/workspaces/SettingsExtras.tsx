import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, Check, Download, Eye, Globe, Loader2, Search, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { bus } from "@/lib/events";
import { cls } from "@/lib/format";
import { useCore } from "@/stores/core";
import type { CalendarEvent, CatalogModel, ModelPull } from "@/lib/types";
import { Badge, Button, Card, Input, Meter, Toggle } from "@/components/ui";

type Values = Record<string, unknown>;
type SetFn = (k: string, v: unknown) => Promise<void>;

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
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

const FIT: Record<CatalogModel["fit"], { tone: "ok" | "warn" | "danger"; label: string }> = {
  fits: { tone: "ok", label: "Runs well on this Mac" },
  tight: { tone: "warn", label: "Tight — close other apps" },
  too_big: { tone: "danger", label: "Too big for this Mac" },
};

const ROLE: Record<string, string> = {
  general: "Everyday", reasoning: "Reasoning", coding: "Code", classification: "Fast helper", embeddings: "Search", documents: "Documents",
};

/** Download and remove local models without touching the Terminal. */
export function GetModels({ onChanged }: { onChanged?: () => void }) {
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [pulls, setPulls] = useState<Record<string, ModelPull>>({});
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const online = useCore((s) => Boolean(s.boot?.ollama.online));
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ suggested: CatalogModel[]; pulls: ModelPull[] }>("/api/models/catalog");
      setCatalog(r.suggested);
      setPulls((cur) => ({ ...Object.fromEntries(r.pulls.map((p) => [p.model, p])), ...cur }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    return bus.on<ModelPull>("model.pull", (e) => {
      const p = e.data;
      setPulls((cur) => ({ ...cur, [p.model]: p }));
      if (p.status === "done" || p.status === "deleted") {
        void load();
        changed.current?.();
      }
    });
  }, [load]);

  const pull = async (model: string) => {
    setError(null);
    try {
      await api.post("/api/models/pull", { model });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (model: string) => {
    setError(null);
    setConfirm(null);
    try {
      await api.del(`/api/models/${encodeURIComponent(model)}`);
      await load();
      changed.current?.();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const busy = (name: string) => {
    const p = pulls[name];
    return p && !["done", "failed", "cancelled", "deleted"].includes(p.status) ? p : null;
  };

  return (
    <Card title="Get models">
      {!online && <p className="mb-3 text-[12.5px] text-warn">Ollama isn't running. Open the Ollama app, then come back to download models.</p>}
      <div className="space-y-2">
        {catalog.map((m) => {
          const p = busy(m.name);
          const failed = pulls[m.name]?.status === "failed" ? pulls[m.name] : null;
          return (
            <div key={m.name} className="glass-inset rounded-2xl p-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium text-fg">
                    {m.label}
                    <Badge>{ROLE[m.role] ?? m.role}</Badge>
                    {m.vision && (
                      <Badge tone="accent">
                        <Eye size={10} className="mr-1 inline" />
                        Sees images
                      </Badge>
                    )}
                  </p>
                  <p className="mt-0.5 text-[12px] text-fg-2">{m.note}</p>
                  <p className="mt-1 flex items-center gap-2 text-[11.5px] text-muted">
                    <span className="font-mono">{m.name}</span> · {m.size_gb} GB ·{" "}
                    <span className={cls(FIT[m.fit].tone === "ok" ? "text-ok" : FIT[m.fit].tone === "warn" ? "text-warn" : "text-danger")}>{FIT[m.fit].label}</span>
                  </p>
                </div>
                {m.installed ? (
                  confirm === m.name ? (
                    <>
                      <Button size="sm" variant="danger" onClick={() => void remove(m.name)}>
                        Delete {m.size_gb} GB
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <>
                      <Badge tone="ok">
                        <Check size={10} className="mr-1 inline" />
                        Installed
                      </Badge>
                      <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} aria-label={`Delete ${m.name}`} onClick={() => setConfirm(m.name)} />
                    </>
                  )
                ) : p ? (
                  <span className="flex items-center gap-2 text-[12px] text-fg-2">
                    <Loader2 size={13} className="animate-spin" /> {p.percent != null ? `${Math.round(p.percent)}%` : "Starting…"}
                  </span>
                ) : (
                  <Button size="sm" variant={m.fit === "too_big" ? "ghost" : "primary"} icon={<Download size={12} />} disabled={!online} onClick={() => void pull(m.name)}>
                    Download
                  </Button>
                )}
              </div>
              {p && (
                <div className="mt-2.5">
                  <Meter value={p.percent ?? 0} />
                  <p className="mt-1 text-[11px] text-muted">{p.status}</p>
                </div>
              )}
              {failed && <p className="mt-2 text-[12px] text-danger">Download failed: {failed.error}</p>}
            </div>
          );
        })}
      </div>
      <form
        className="mt-4 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (custom.trim()) void pull(custom.trim()).then(() => setCustom(""));
        }}
      >
        <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Any other Ollama model, e.g. llama3.3:8b" className="flex-1 font-mono text-[12px]" />
        <Button type="submit" icon={<Download size={12} />} disabled={!custom.trim() || !online}>
          Download
        </Button>
      </form>
      {Object.values(pulls)
        .filter((p) => !catalog.some((m) => m.name === p.model) && !["done", "deleted"].includes(p.status))
        .map((p) => (
          <div key={p.model} className="mt-2.5">
            <p className="text-[12px] text-fg-2">
              <span className="font-mono">{p.model}</span> — {p.status === "failed" ? <span className="text-danger">{p.error}</span> : `${Math.round(p.percent ?? 0)}%`}
            </p>
            {p.status !== "failed" && <Meter value={p.percent ?? 0} />}
          </div>
        ))}
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      <p className="mt-3 text-[11.5px] leading-snug text-muted">
        Downloads come straight from Ollama's library to this Mac. NEXUS keeps one large model in memory at a time, so you can install several and switch.
      </p>
    </Card>
  );
}

/** Web access and Apple apps. Everything here is off until switched on. */
export function WebAndApps({ values, set }: { values: Values; set: SetFn }) {
  const apple = useCore((s) => s.boot?.apple);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ title: string; url: string; snippet: string }[] | null>(null);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setMsg((m) => ({ ...m, [key]: "" }));
    try {
      await fn();
    } catch (e) {
      setMsg((m) => ({ ...m, [key]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  const web = Boolean(values["web.enabled"]);
  const mac = apple?.available ?? false;

  return (
    <div className="space-y-4">
      <Card title="Web">
        <Row
          label={
            <span className="inline-flex items-center gap-2">
              <Globe size={14} className="text-muted" /> Let agents search and read the web
            </span>
          }
          hint="Off: nothing leaves your Mac. On: an agent may send a search phrase to DuckDuckGo and download public pages. Your files, memories and chats are never sent."
        >
          <Toggle checked={web} onChange={(v) => void set("web.enabled", v)} />
        </Row>
        {web && (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run("web", async () => {
                const r = await api.post<{ results: { title: string; url: string; snippet: string }[] }>("/api/web/search", { query });
                setResults(r.results);
              });
            }}
          >
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Try a search to check it works" className="flex-1" />
            <Button type="submit" icon={busy === "web" ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} disabled={!query.trim() || busy === "web"}>
              Search
            </Button>
          </form>
        )}
        {msg.web && <p className="mt-2 text-[12px] text-danger">{msg.web}</p>}
        {web && results && (
          <ul className="mt-3 space-y-2">
            {results.length === 0 && <li className="text-[12px] text-muted">No results.</li>}
            {results.slice(0, 4).map((r) => (
              <li key={r.url} className="text-[12px]">
                <p className="text-fg">{r.title}</p>
                <p className="selectable truncate font-mono text-[11px] text-muted">{r.url}</p>
                <p className="text-fg-2">{r.snippet}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11.5px] leading-snug text-muted">
          Used by the Researcher and Chief of Staff agents. Pages are treated as information only, and addresses on your own network are always blocked.
        </p>
      </Card>

      <Card title="Markets">
        <Row
          label="Get market prices"
          hint="Off: nothing is requested. On: the ticker symbols you look at are sent to Yahoo Finance to fetch prices and charts. Your practice holdings and orders stay on this Mac. NEXUS never places real orders."
        >
          <Toggle checked={Boolean(values["markets.enabled"])} onChange={(v) => void set("markets.enabled", v)} />
        </Row>
      </Card>

      <Card title="Calendar, Reminders and Mail">
        {!mac && <p className="mb-2 text-[12.5px] text-warn">These work when NEXUS runs on a Mac.</p>}
        <Row label="Read my calendar" hint="Lets the assistant see today's and upcoming events, for briefings and planning.">
          <Toggle checked={Boolean(values["integrations.calendar"])} onChange={(v) => void set("integrations.calendar", v)} />
        </Row>
        <Row label="Read and add reminders" hint="Reading is automatic. Adding a reminder always asks you first.">
          <Toggle checked={Boolean(values["integrations.reminders"])} onChange={(v) => void set("integrations.reminders", v)} />
        </Row>
        <Row label="Prepare email drafts" hint="Opens a draft in Mail for you to review. NEXUS never sends email.">
          <Toggle checked={Boolean(values["integrations.mail"])} onChange={(v) => void set("integrations.mail", v)} />
        </Row>
        {Boolean(values["integrations.calendar"]) && (
          <div className="mt-3">
            <Button
              size="sm"
              icon={busy === "cal" ? <Loader2 size={12} className="animate-spin" /> : <CalendarDays size={12} />}
              disabled={busy === "cal"}
              onClick={() => void run("cal", async () => setEvents((await api.get<{ events: CalendarEvent[] }>("/api/apple/calendar?days=1")).events))}
            >
              Show today's events
            </Button>
            {msg.cal && <p className="mt-2 text-[12px] text-danger">{msg.cal}</p>}
            {events && (
              <ul className="mt-2 space-y-1 text-[12.5px] text-fg-2">
                {events.length === 0 && <li className="text-muted">Nothing on the calendar today.</li>}
                {events.map((ev, i) => (
                  <li key={i}>
                    <span className="font-mono text-[11.5px] text-muted">{ev.all_day ? "all day" : ev.start.slice(11, 16)}</span> {ev.title}
                    {ev.location && <span className="text-muted"> · {ev.location}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="mt-3 text-[11.5px] leading-snug text-muted">
          The first time each one is used, macOS asks whether NEXUS may use that app. You can change it later in System Settings → Privacy &amp; Security.
        </p>
      </Card>

      <Card title="Documents">
        <Row label="Read text in scans and photos" hint="Recognises text in scanned PDFs, screenshots and photos when indexing folders and attaching files. Runs on this Mac.">
          <Toggle checked={values["knowledge.ocr"] !== false} onChange={(v) => void set("knowledge.ocr", v)} />
        </Row>
      </Card>
    </div>
  );
}

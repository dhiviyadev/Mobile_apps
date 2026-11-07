import { useEffect, useState } from "react";
import { AlertTriangle, Check, ExternalLink, FileText, FolderPlus, Loader2, Pin, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { shell, isTauri } from "@/lib/tauri";
import { bus } from "@/lib/events";
import { useCore, EMPTY } from "@/stores/core";
import type { Folder, Memory, SearchResult } from "@/lib/types";
import { Badge, Button, Card, Empty, IconButton, Input, SectionTitle, Segmented, Select, Toggle } from "@/components/ui";
import { bytes, cls, highlightSegments, relTime } from "@/lib/format";

type Tab = "search" | "folders" | "documents" | "memory";

export function Knowledge() {
  const [tab, setTab] = useState<Tab>("search");
  const stats = useCore((s) => s.boot?.knowledge);
  const proposed = useCore((s) => s.boot?.memory.proposed ?? 0);
  return (
    <div className="mx-auto max-w-[1080px] px-8 py-8">
      <SectionTitle
        title="Knowledge"
        sub={`${stats?.documents ?? 0} documents · ${stats?.chunks ?? 0} passages · ${stats?.embeddings.embedded ?? 0} embedded. Only folders you approve are ever read.`}
        action={
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "search", label: "Search" },
              { value: "folders", label: "Folders" },
              { value: "documents", label: "Documents" },
              { value: "memory", label: <span className="inline-flex items-center gap-1.5">Memory {proposed > 0 && <span className="h-1.5 w-1.5 rounded-full bg-warn" />}</span> },
            ]}
          />
        }
      />
      {tab === "search" && <SearchTab />}
      {tab === "folders" && <FoldersTab />}
      {tab === "documents" && <DocumentsTab />}
      {tab === "memory" && <MemoryTab />}
    </div>
  );
}

function Snippet({ text }: { text: string }) {
  return (
    <p className="selectable text-[12.5px] leading-relaxed text-fg-2">
      {highlightSegments(text).map((s, i) =>
        s.hit ? (
          <mark key={i} className="rounded-[3px] bg-accent/20 px-0.5 text-fg">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </p>
  );
}

function SearchTab() {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"auto" | "keyword" | "semantic" | "hybrid">("auto");
  const [project, setProject] = useState("");
  const [res, setRes] = useState<{ mode: string; results: SearchResult[]; note: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ query: string; mode: string; result_count: number }[]>([]);
  const projects = useCore((s) => s.boot?.knowledge.projects ?? EMPTY);

  useEffect(() => void api.get<typeof history>("/api/knowledge/history").then(setHistory), [res]);

  const run = async (query = q) => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      setRes(await api.post("/api/knowledge/search", { query, mode, project: project || null, limit: 15 }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-[9px] text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void run()} placeholder="Search your documents…" className="h-9 pl-9 text-[13.5px]" autoFocus />
        </div>
        {projects.length > 0 && <Select value={project} onChange={setProject} placeholder="All projects" options={projects.map((p) => ({ value: p, label: p }))} className="h-9" />}
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "auto", label: "Auto" },
            { value: "keyword", label: "Keyword" },
            { value: "semantic", label: "Semantic" },
            { value: "hybrid", label: "Hybrid" },
          ]}
        />
      </div>
      {history.length > 0 && !res && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {history.slice(0, 10).map((h, i) => (
            <button key={i} onClick={() => { setQ(h.query); void run(h.query); }} className="h-6 rounded-full border border-line-soft px-2.5 text-[11.5px] text-fg-2 hover:border-line hover:text-fg">
              {h.query}
            </button>
          ))}
        </div>
      )}
      <div className="mt-5 space-y-2">
        {busy && <Loader2 size={15} className="animate-spin text-muted" />}
        {res?.note && <p className="text-[12px] text-warn">{res.note}</p>}
        {res && (
          <p className="text-[11.5px] text-muted">
            {res.results.length} results · {res.mode} search
          </p>
        )}
        {res?.results.map((r) => (
          <div key={r.chunk_id} className="surface group p-3.5">
            <div className="mb-1.5 flex items-center gap-2">
              <FileText size={13} className="text-muted" />
              <span className="text-[13px] font-medium text-fg">{r.title}</span>
              <Badge>{r.ext.replace(".", "")}</Badge>
              {r.location && <span className="text-[11.5px] text-muted">{r.location}</span>}
              {r.project && <Badge tone="accent">{r.project}</Badge>}
              <span className="ml-auto text-[11px] text-muted">{r.match}</span>
              <IconButton label="Reveal in Finder" onClick={() => void api.post("/api/files/open", { path: r.path, reveal: "1" })} className="opacity-0 group-hover:opacity-100">
                <ExternalLink size={13} />
              </IconButton>
            </div>
            <Snippet text={r.snippet} />
            <p className="mt-1.5 truncate font-mono text-[10.5px] text-muted">{r.path}</p>
          </div>
        ))}
        {res && res.results.length === 0 && <Empty title="No matches" body="Try different words, or approve and index more folders." />}
      </div>
    </div>
  );
}

function FoldersTab() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [workspace, setWorkspaceDir] = useState("");
  const [path, setPath] = useState("");
  const [project, setProject] = useState("");
  const [write, setWrite] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const indexing = useCore((s) => s.boot?.knowledge.indexing ?? EMPTY);
  const embeddings = useCore((s) => s.boot?.knowledge.embeddings);
  const [embedMsg, setEmbedMsg] = useState<string | null>(null);

  const load = () => void api.get<{ workspace: string; folders: Folder[] }>("/api/folders").then((r) => {
    setFolders(r.folders);
    setWorkspaceDir(r.workspace);
  });
  useEffect(() => {
    load();
    const off1 = bus.on("knowledge", () => load());
    return () => off1();
  }, []);

  const add = async () => {
    setErr(null);
    try {
      await api.post("/api/folders", { path, project: project || null, can_write: write });
      setPath("");
      setProject("");
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Approve a folder">
        <div className="flex gap-2">
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/Documents/REstack" className="font-mono text-[12px]" />
          {isTauri && (
            <Button onClick={() => void shell.pickFolder().then((p) => p && setPath(p))}>Choose…</Button>
          )}
          <Input value={project} onChange={(e) => setProject(e.target.value)} placeholder="Project (optional)" className="w-48" />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
            <Toggle checked={write} onChange={setWrite} label="Allow writes" /> Allow agents to create files here (overwrites and deletions always ask)
          </label>
          <Button variant="primary" icon={<FolderPlus size={13} />} disabled={!path.trim()} onClick={() => void add()}>
            Approve & index
          </Button>
        </div>
        {err && <p className="mt-2 text-[12px] text-danger">{err}</p>}
        <p className="mt-3 text-[11.5px] text-muted">
          System folders, your whole home folder, and credential stores (~/.ssh, Keychains, browser profiles, .env files) can never be approved. NEXUS does not need Full Disk Access.
        </p>
      </Card>

      <div className="surface divide-y divide-line-soft">
        <FolderLine label="NEXUS Workspace" path={workspace} perms="read · write" builtin />
        {folders.map((f) => (
          <div key={f.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[13px] text-fg">
                {f.label} {f.project && <Badge tone="accent">{f.project}</Badge>}
                {indexing.includes(f.id) && (
                  <span className="flex items-center gap-1 text-[11px] text-muted">
                    <Loader2 size={11} className="animate-spin" /> indexing
                  </span>
                )}
              </p>
              <p className="truncate font-mono text-[11px] text-muted">{f.path}</p>
            </div>
            <PermToggle label="Read" on={!!f.can_read} onChange={(v) => void api.patch(`/api/folders/${f.id}`, { can_read: v }).then(load)} />
            <PermToggle label="Write" on={!!f.can_write} onChange={(v) => void api.patch(`/api/folders/${f.id}`, { can_write: v }).then(load)} />
            <PermToggle label="Index" on={!!f.index_enabled} onChange={(v) => void api.patch(`/api/folders/${f.id}`, { index_enabled: v }).then(load)} />
            <span className="w-24 text-right text-[11px] text-muted">{f.last_indexed_at ? relTime(f.last_indexed_at) : "never"}</span>
            <IconButton label="Re-index" onClick={() => void api.post(`/api/folders/${f.id}/index`).then(load)} disabled={indexing.includes(f.id)}>
              <RefreshCw size={13} />
            </IconButton>
            <IconButton label="Revoke access" onClick={() => void api.del(`/api/folders/${f.id}`).then(load)}>
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
      </div>

      <Card title="Semantic search">
        <div className="flex items-center justify-between gap-4">
          <p className="text-[12.5px] text-fg-2">
            {embeddings?.embedded ?? 0} of {embeddings?.total ?? 0} passages have embeddings. Embeddings use a local Ollama embedding model (e.g. <code className="font-mono">nomic-embed-text</code>) and are stored in SQLite. Qdrant can replace this store later.
          </p>
          <Button
            icon={<Sparkles size={13} />}
            onClick={() => void api.post<{ model: string }>("/api/knowledge/embeddings").then((r) => setEmbedMsg(`Building embeddings with ${r.model}…`)).catch((e: Error) => setEmbedMsg(e.message))}
          >
            Build embeddings
          </Button>
        </div>
        {embedMsg && <p className="mt-2 text-[12px] text-muted">{embedMsg}</p>}
      </Card>
    </div>
  );
}

function FolderLine({ label, path, perms, builtin }: { label: string; path: string; perms: string; builtin?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[13px] text-fg">
          {label} {builtin && <Badge>built-in</Badge>}
        </p>
        <p className="truncate font-mono text-[11px] text-muted">{path}</p>
      </div>
      <span className="text-[11.5px] text-muted">{perms}</span>
    </div>
  );
}

function PermToggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
      <Toggle checked={on} onChange={onChange} label={label} /> {label}
    </label>
  );
}

interface Doc {
  id: string;
  path: string;
  title: string;
  ext: string;
  size: number;
  chunk_count: number;
  error: string | null;
  project: string | null;
  indexed_at: string;
}

function DocumentsTab() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [open, setOpen] = useState<(Doc & { chunks: { ordinal: number; location: string | null; preview: string }[] }) | null>(null);
  useEffect(() => void api.get<Doc[]>("/api/knowledge/documents?limit=300").then(setDocs), []);
  if (!docs.length) return <Empty icon={<FileText size={22} />} title="Nothing indexed yet" body="Approve a folder in the Folders tab. PDF, DOCX, TXT, Markdown, CSV, XLSX and JSON are supported." />;
  return (
    <div className="grid grid-cols-[1fr_1fr] gap-4">
      <div className="surface max-h-[640px] divide-y divide-line-soft overflow-y-auto">
        {docs.map((d) => (
          <button key={d.id} onClick={() => void api.get<typeof open>(`/api/knowledge/documents/${d.id}`).then(setOpen)} className={cls("flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-white/[0.02]", open?.id === d.id && "bg-white/[0.04]")}>
            <Badge>{d.ext.replace(".", "")}</Badge>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] text-fg">{d.title}</p>
              <p className="truncate text-[11px] text-muted">{d.path}</p>
            </div>
            {d.error ? (
              <span title={d.error}>
                <AlertTriangle size={13} className="text-warn" />
              </span>
            ) : (
              <span className="text-[11px] text-muted">{d.chunk_count} passages</span>
            )}
          </button>
        ))}
      </div>
      <div className="surface max-h-[640px] overflow-y-auto p-4">
        {open ? (
          <>
            <p className="text-[14px] font-medium text-fg">{open.title}</p>
            <p className="mb-1 font-mono text-[11px] text-muted">{open.path}</p>
            <p className="mb-3 text-[11.5px] text-muted">
              {bytes(open.size)} · indexed {relTime(open.indexed_at)} {open.project && `· ${open.project}`}
            </p>
            {open.error && <p className="mb-3 text-[12px] text-warn">{open.error}</p>}
            {open.chunks.map((c) => (
              <div key={c.ordinal} className="mb-3">
                {c.location && <p className="text-[10.5px] uppercase tracking-[0.08em] text-muted">{c.location}</p>}
                <p className="selectable whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg-2">{c.preview}</p>
              </div>
            ))}
          </>
        ) : (
          <Empty title="Select a document" body="Preview its extracted passages and metadata." />
        )}
      </div>
    </div>
  );
}

const CATS: Memory["category"][] = ["preference", "project", "task", "decision", "summary", "knowledge"];

function MemoryTab() {
  const [mems, setMems] = useState<Memory[]>([]);
  const [cat, setCat] = useState<string>("");
  const [content, setContent] = useState("");
  const [newCat, setNewCat] = useState<Memory["category"]>("preference");
  const refresh = useCore((s) => s.refresh);
  const load = () => void api.get<Memory[]>(`/api/memories${cat ? `?category=${cat}` : ""}`).then(setMems);
  useEffect(load, [cat]);
  const update = (id: string, body: Partial<Memory> | { status: string }) => void api.patch(`/api/memories/${id}`, body).then(() => { load(); void refresh(); });
  const proposals = mems.filter((m) => m.status === "proposed");
  const rest = mems.filter((m) => m.status !== "proposed");

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-fg-2">
        Long-term memory is small, reviewed and attributable. Automatic suggestions are always <em>proposals</em> until you approve them, and anything that looks like a credential is flagged. Conversations themselves are not stored as memory.
      </p>
      {proposals.length > 0 && (
        <Card title={`Review ${proposals.length} proposal${proposals.length > 1 ? "s" : ""}`}>
          {proposals.map((m) => (
            <div key={m.id} className="flex items-start gap-3 border-b border-line-soft py-2.5 last:border-0">
              <Badge tone="warn">{m.category}</Badge>
              <div className="min-w-0 flex-1">
                <p className="selectable text-[13px] text-fg">{m.content}</p>
                <p className="text-[11px] text-muted">
                  from {m.source_type}
                  {m.source_ref ? ` · ${m.source_ref}` : ""} · {relTime(m.created_at)} {m.sensitive ? "· ⚠ looks sensitive" : ""}
                </p>
              </div>
              <IconButton label="Approve" onClick={() => update(m.id, { status: "active" })}>
                <Check size={14} className="text-ok" />
              </IconButton>
              <IconButton label="Reject" onClick={() => void api.del(`/api/memories/${m.id}`).then(load)}>
                <X size={14} />
              </IconButton>
            </div>
          ))}
        </Card>
      )}
      <Card title="Remember something">
        <div className="flex gap-2">
          <Select value={newCat} onChange={(v) => setNewCat(v as Memory["category"])} options={CATS.map((c) => ({ value: c, label: c }))} />
          <Input value={content} onChange={(e) => setContent(e.target.value)} placeholder="e.g. I prefer British English and concise answers" />
          <Button variant="primary" disabled={!content.trim()} onClick={() => void api.post("/api/memories", { category: newCat, content }).then(() => { setContent(""); load(); })}>
            Save
          </Button>
        </div>
      </Card>
      <div className="flex items-center gap-2">
        <Segmented value={cat} onChange={setCat} options={[{ value: "", label: "All" }, ...CATS.map((c) => ({ value: c, label: c }))]} />
      </div>
      <div className="surface divide-y divide-line-soft">
        {rest.length === 0 && <Empty title="No memories yet" body="Add one above, or use the brain icon in a conversation to get suggestions." />}
        {rest.map((m) => (
          <div key={m.id} className={cls("group flex items-start gap-3 px-4 py-3", m.status === "archived" && "opacity-50")}>
            <Badge>{m.category}</Badge>
            <div className="min-w-0 flex-1">
              <p className="selectable text-[13px] text-fg">{m.content}</p>
              <p className="text-[11px] text-muted">
                {m.source_type}
                {m.source_ref ? ` · ${m.source_ref}` : ""} · used {m.use_count}× {m.last_used_at ? `· last ${relTime(m.last_used_at)}` : ""} · {m.status}
              </p>
            </div>
            <IconButton label={m.pinned ? "Unpin" : "Pin (always include)"} onClick={() => update(m.id, { pinned: m.pinned ? 0 : 1 } as Partial<Memory>)} active={!!m.pinned}>
              <Pin size={13} />
            </IconButton>
            <IconButton label={m.status === "archived" ? "Restore" : "Archive"} onClick={() => update(m.id, { status: m.status === "archived" ? "active" : "archived" })}>
              <RefreshCw size={13} />
            </IconButton>
            <IconButton label="Delete" onClick={() => void api.del(`/api/memories/${m.id}`).then(load)}>
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  );
}

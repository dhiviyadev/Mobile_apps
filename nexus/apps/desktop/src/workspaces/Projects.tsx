import { useCallback, useEffect, useState } from "react";
import { Check, FolderOpen, FolderPlus, MessageSquare, Plus, Sparkles, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { cls, relTime } from "@/lib/format";
import { useCore, EMPTY } from "@/stores/core";
import { useChat } from "@/stores/chat";
import type { Conversation, Folder, Memory, Project } from "@/lib/types";
import { Badge, Button, Card, Empty, Input, SectionTitle, Select, Textarea } from "@/components/ui";

import { PROJECT_COLORS } from "@/lib/projectColors";

type Detail = Project & { conversations: Conversation[]; memories: Memory[]; folders: Folder[] };

/** Projects: a named space with its own instructions, chats, memories and folders. */
export function Projects() {
  const projects = useCore((s) => s.boot?.projects ?? (EMPTY as Project[]));
  const current = useCore((s) => s.projectId);
  const setProject = useCore((s) => s.setProject);
  const refresh = useCore((s) => s.refresh);
  const [selected, setSelected] = useState<string | null>(current);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected && projects[0]) setSelected(projects[0].id);
    if (selected && !projects.some((p) => p.id === selected)) setSelected(projects[0]?.id ?? null);
  }, [projects, selected]);

  const create = async () => {
    setError(null);
    try {
      const p = await api.post<Project>("/api/projects", { name });
      setName("");
      await refresh();
      setSelected(p.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-[1080px] px-8 py-7">
      <SectionTitle
        title="Projects"
        sub="Give each area of your life its own space. A project has its own instructions, chats, memories and folders, so answers stay on topic."
      />
      <div className="grid grid-cols-[280px_1fr] gap-5">
        <div className="space-y-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void create();
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" maxLength={60} />
            <Button type="submit" variant="primary" icon={<Plus size={13} />} disabled={!name.trim()}>
              Add
            </Button>
          </form>
          {error && <p className="px-1 text-[12px] text-danger">{error}</p>}
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelected(p.id)}
              className={cls(
                "surface press flex w-full items-center gap-3 p-3 text-left transition-colors",
                selected === p.id ? "border-white/20 bg-white/[0.09]" : "hover:bg-white/[0.05]",
              )}
            >
              <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: PROJECT_COLORS[p.color] ?? PROJECT_COLORS.silver, boxShadow: `0 0 10px ${PROJECT_COLORS[p.color] ?? "#cdd3dd"}66` }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-fg">{p.name}</span>
                <span className="block text-[11.5px] text-muted">
                  {p.counts.conversations} chats · {p.counts.documents} documents
                </span>
              </span>
              {current === p.id && <Badge tone="accent">Current</Badge>}
            </button>
          ))}
        </div>
        {selected ? (
          <ProjectDetail key={selected} id={selected} />
        ) : (
          <Empty
            icon={<Sparkles size={20} />}
            title="No projects yet"
            body="Create one for a client, a course, your home admin — anything you keep coming back to."
          />
        )}
      </div>
      {current && (
        <p className="mt-4 text-[12px] text-muted">
          New chats are filed under the current project.{" "}
          <button className="underline underline-offset-2 hover:text-fg-2" onClick={() => setProject(null)}>
            Stop working in a project
          </button>
        </p>
      )}
    </div>
  );
}

function ProjectDetail({ id }: { id: string }) {
  const current = useCore((s) => s.projectId);
  const setProject = useCore((s) => s.setProject);
  const setWorkspace = useCore((s) => s.setWorkspace);
  const refresh = useCore((s) => s.refresh);
  const allFolders = useCore((s) => s.boot?.folders ?? (EMPTY as Folder[]));
  const openChat = useChat((s) => s.open);
  const newChat = useChat((s) => s.newConversation);
  const [d, setD] = useState<Detail | null>(null);
  const [form, setForm] = useState({ name: "", description: "", instructions: "" });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linkId, setLinkId] = useState("");

  const load = useCallback(async () => {
    const detail = await api.get<Detail>(`/api/projects/${id}`);
    setD(detail);
    setForm({ name: detail.name, description: detail.description, instructions: detail.instructions });
  }, [id]);
  useEffect(() => void load().catch((e: Error) => setError(e.message)), [load]);

  if (!d) return <div className="surface p-6 text-[13px] text-muted">{error ?? "Loading…"}</div>;
  const dirty = form.name !== d.name || form.description !== d.description || form.instructions !== d.instructions;
  const unlinked = allFolders.filter((f) => !f.project);

  const save = async () => {
    setError(null);
    try {
      await api.patch(`/api/projects/${id}`, form);
      await Promise.all([load(), refresh()]);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const link = async (folderId: string, project: string | null) => {
    await api.patch(`/api/folders/${folderId}`, { project: project ?? "" });
    setLinkId("");
    await Promise.all([load(), refresh()]);
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-2.5">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} className="text-[15px] font-medium" aria-label="Project name" />
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What is this project about? (optional)" maxLength={500} />
          </div>
          {current === id ? (
            <Button icon={<Check size={13} />} onClick={() => setProject(null)}>
              Working here
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setProject(id)}>
              Work in this project
            </Button>
          )}
        </div>
        <p className="mb-1.5 mt-4 text-[12px] font-medium text-fg-2">Instructions for NEXUS</p>
        <Textarea
          value={form.instructions}
          onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          rows={5}
          maxLength={8000}
          placeholder={"How should NEXUS behave in this project?\nFor example: “Write in British English. The client is Acme Ltd. Always cite the contract clause.”"}
        />
        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" disabled={!dirty || !form.name.trim()} onClick={() => void save()}>
            Save
          </Button>
          {saved && <span className="text-[12px] text-ok">Saved</span>}
          {error && <span className="text-[12px] text-danger">{error}</span>}
          <span className="flex-1" />
          {confirmDelete ? (
            <>
              <span className="text-[12px] text-fg-2">Chats and memories are kept, just unfiled.</span>
              <Button
                variant="danger"
                onClick={() =>
                  void api.del(`/api/projects/${id}`).then(() => {
                    if (current === id) setProject(null);
                    return refresh();
                  })
                }
              >
                Delete project
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" icon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card
          title="Chats"
          action={
            <Button
              size="sm"
              icon={<Plus size={12} />}
              onClick={() => {
                setProject(id);
                void newChat().then(() => setWorkspace("chat"));
              }}
            >
              New chat
            </Button>
          }
        >
          {d.conversations.length === 0 && <p className="text-[12.5px] text-muted">No chats in this project yet.</p>}
          <div className="space-y-0.5">
            {d.conversations.slice(0, 8).map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  void openChat(c.id);
                  setWorkspace("chat");
                }}
                className="press flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-fg-2 hover:bg-white/[0.05] hover:text-fg"
              >
                <MessageSquare size={12} className="flex-none text-muted" />
                <span className="flex-1 truncate">{c.title}</span>
                <span className="text-[11px] text-muted">{relTime(c.updated_at)}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card title="Folders">
          {d.folders.length === 0 && (
            <p className="text-[12.5px] text-muted">
              No folders linked. Link an approved folder and questions in this project will search only its documents.
            </p>
          )}
          <div className="space-y-1">
            {d.folders.map((f) => (
              <div key={f.id} className="flex h-8 items-center gap-2 rounded-lg px-2 text-[12.5px] text-fg-2">
                <FolderOpen size={12} className="flex-none text-muted" />
                <span className="flex-1 truncate" title={f.path}>
                  {f.label}
                </span>
                <button className="text-[11.5px] text-muted hover:text-fg" onClick={() => void link(f.id, null)}>
                  Unlink
                </button>
              </div>
            ))}
          </div>
          {unlinked.length > 0 ? (
            <div className="mt-3 flex gap-2">
              <Select value={linkId} onChange={setLinkId} placeholder="Choose an approved folder…" options={unlinked.map((f) => ({ value: f.id, label: f.label }))} className="flex-1" />
              <Button icon={<FolderPlus size={13} />} disabled={!linkId} onClick={() => void link(linkId, d.name)}>
                Link
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-[11.5px] text-muted">Approve folders in Knowledge to link them here.</p>
          )}
        </Card>
      </div>

      <Card title={`Project memories (${d.memories.length})`}>
        {d.memories.length === 0 ? (
          <p className="text-[12.5px] text-muted">Things NEXUS learns while you work in this project are kept here and only used inside it.</p>
        ) : (
          <ul className="space-y-1.5">
            {d.memories.slice(0, 12).map((m) => (
              <li key={m.id} className="flex items-start gap-2 text-[12.5px] text-fg-2">
                <Badge tone={m.status === "active" ? "ok" : "warn"}>{m.status === "active" ? m.category : "to review"}</Badge>
                <span className="selectable flex-1">{m.content}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

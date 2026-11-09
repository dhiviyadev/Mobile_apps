export type TaskStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export interface Task {
  id: string;
  title: string;
  kind: "agent" | "automation" | "index" | "chat" | "system";
  status: TaskStatus;
  agent_id: string | null;
  conversation_id: string | null;
  input: string;
  result: string | null;
  error: string | null;
  runtime: string | null;
  external_ref: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TaskEvent {
  task_id: string;
  seq: number;
  type: string;
  title: string;
  detail: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  description: string;
  system_prompt: string;
  model_category: string;
  tools: string[];
  hermes_toolsets: string[];
  runtime_pref: "auto" | "hermes" | "native";
  enabled: boolean;
  builtin: boolean;
  status: "idle" | "busy" | "disabled";
  current_task: { id: string; title: string; status: TaskStatus } | null;
  stats: { runs: number; completed: number; failed: number; last_run_at: string | null };
}

export interface Conversation {
  id: string;
  title: string;
  model: string | null;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  archived: number;
  message_count?: number;
}

export interface Source {
  title: string;
  path: string;
  location: string | null;
  document_id?: string;
  match?: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  model: string | null;
  status: string;
  task_id: string | null;
  metadata: {
    metrics?: Metrics;
    sources?: Source[];
    attachments?: { id: string; filename: string }[] | string[];
    provider?: string;
    agent_id?: string;
    runtime?: string;
  };
  created_at: string;
}

export interface Metrics {
  model?: string;
  load_ms?: number | null;
  ttft_ms?: number | null;
  total_ms?: number | null;
  prompt_tokens?: number | null;
  eval_tokens?: number | null;
  tokens_per_s?: number | null;
}

export interface Approval {
  id: string;
  task_id: string | null;
  kind: string;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
  source: string;
  status: "pending" | "approved" | "denied" | "expired";
  created_at: string;
}

export interface Notification {
  id: string;
  link?: string | null;
  title: string;
  body: string;
  level: string;
  read: number;
  created_at: string;
}

export interface Folder {
  id: string;
  path: string;
  label: string;
  project: string | null;
  can_read: number;
  can_write: number;
  can_execute: number;
  index_enabled: number;
  created_at: string;
  last_indexed_at: string | null;
}

export interface Memory {
  id: string;
  category: "preference" | "project" | "task" | "decision" | "summary" | "knowledge";
  content: string;
  status: "proposed" | "active" | "archived";
  source_type: string;
  source_ref: string | null;
  sensitive: number;
  pinned: number;
  relevance: number;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SearchResult {
  chunk_id: number;
  document_id: string;
  path: string;
  title: string;
  ext: string;
  project: string | null;
  location: string | null;
  snippet: string;
  score: number;
  match: "keyword" | "semantic" | "hybrid";
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  trigger: { type: "manual" | "schedule" | "file"; cron?: string; folder_id?: string; events?: string[]; patterns?: string[] };
  conditions: Record<string, unknown>[];
  actions: { type: string; [k: string]: unknown }[];
  enabled: boolean;
  requires_approval: boolean;
  failure_policy: { retries?: number; notify?: boolean };
  template: string | null;
  schedule_text?: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_run?: { status: string; started_at: string } | null;
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  automation_name?: string;
  task_id: string | null;
  trigger_reason: string;
  status: string;
  output: string | null;
  error: string | null;
  attempt: number;
  started_at: string;
  finished_at: string | null;
}

export interface ModelInfo {
  name: string;
  size: number;
  family: string | null;
  parameter_size: string | null;
  quantization: string | null;
  embedding: boolean;
  loaded: boolean;
  size_vram: number | null;
  expires_at: string | null;
  state: string;
}

export interface ModelsResponse {
  online: boolean;
  error?: string;
  version?: string | null;
  installed: ModelInfo[];
  routing: Record<string, string>;
  categories: string[];
  default: string;
  single_model_mode?: boolean;
  stats?: { samples: number; avg_tokens_per_s: number | null; avg_ttft_ms: number | null };
}

export interface HermesStatus {
  mode: string;
  status: "ready" | "installed" | "not_installed" | "disabled";
  transport: "api" | "cli" | null;
  cli_path: string | null;
  version: string | null;
  api_url: string;
  api_reachable: boolean;
  api_authenticated: boolean;
  has_api_key: boolean;
  capabilities: Record<string, boolean> | null;
  config?: {
    home: string;
    home_exists: boolean;
    config_exists: boolean;
    model?: { provider?: string; default?: string; base_url?: string };
    api_server_config?: Record<string, unknown>;
  };
}

export interface VoiceStatus {
  stt_engines: string[];
  tts_engines: string[];
  stt_available: boolean;
  tts_available: boolean;
  ffmpeg: boolean;
  tts_enabled: boolean;
  details: Record<string, unknown>;
}

export interface Bootstrap {
  profile: { name: string };
  appearance: { material: "ambient" | "desktop" | "solid"; motion: "full" | "calm"; transparency: number };
  hardware: Record<string, unknown>;
  halted: boolean;
  ollama: { online: boolean; installed: number; running: string[]; default_model: string | null };
  hermes: HermesStatus;
  tasks: { recent: Task[]; active: Task[] };
  agents: Agent[];
  automations: { upcoming: Automation[]; count: number };
  conversations: Conversation[];
  approvals: Approval[];
  notifications: Notification[];
  knowledge: { documents: number; chunks: number; failed: number; folders: number; embeddings: { total: number; embedded: number }; indexing: string[]; projects: string[] };
  folders: Folder[];
  memory: { proposed: number };
  voice: VoiceStatus;
  update: { available: boolean; behind: number; applying: boolean };
  cloud: { enabled: boolean; provider: string; model: string; has_key: boolean; allow_documents: boolean; keychain_available: boolean };
}

export interface SystemSnapshot {
  hardware: Record<string, unknown>;
  cpu: { percent: number; per_core: number[]; count: number; load_avg: number[] | null };
  memory: {
    total: number;
    available: number;
    used: number;
    percent: number;
    swap_used: number;
    swap_total: number;
    pressure: { available: boolean; level: number | null; label: string; source: string | null };
  };
  gpu: { available: boolean; note: string };
  disk: { total: number; used: number; free: number; percent: number; path: string };
  inference: { samples: number; avg_tokens_per_s: number | null; avg_ttft_ms: number | null; last: Record<string, unknown> | null };
  services: {
    core: { status: string; uptime_s: number; pid: number; rss_bytes: number };
    ollama: { status: string; version: string | null; url: string; loaded_models: { name: string; size: number; size_vram: number; expires_at: string; context_length?: number }[]; transitions: Record<string, string> };
    hermes: HermesStatus;
    database: { status: string; path: string; size_bytes: number };
    voice: VoiceStatus;
  };
  tasks: { active: number; queued_or_running: number };
  halted: boolean;
  history: { ts: number; cpu_percent: number; memory_percent: number; memory_used: number; swap_used: number; pressure: string | null }[];
}

export type Workspace = "home" | "chat" | "agents" | "knowledge" | "automations" | "system" | "settings";

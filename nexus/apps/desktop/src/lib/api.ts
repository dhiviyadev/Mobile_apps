import { coreInfo, DEVICE_TOKEN_KEY, type CoreInfo } from "./tauri";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

let info: CoreInfo | null = null;
let infoPromise: Promise<CoreInfo> | null = null;

export async function connection(force = false): Promise<CoreInfo> {
  if (info && !force) return info;
  if (!infoPromise || force) infoPromise = coreInfo().then((i) => (info = i));
  return infoPromise;
}

/** Phone app: store the device token received from pairing (or clear it to unpair). */
export function setDeviceToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(DEVICE_TOKEN_KEY, token);
    else localStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    /* ignore */
  }
  info = null;
  infoPromise = null;
}

export function setToken(token: string): void {
  if (info) info = { ...info, token };
  try {
    localStorage.setItem("nexus.token", token);
  } catch {
    /* ignore */
  }
}

function detailMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "detail" in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && "message" in d) return String((d as { message: unknown }).message);
    return JSON.stringify(d);
  }
  return `Request failed (${status})`;
}

async function headers(json = true): Promise<HeadersInit> {
  const c = await connection();
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (c.token) h["Authorization"] = `Bearer ${c.token}`;
  return h;
}

export async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const c = await connection();
  let res: Response;
  try {
    res = await fetch(`${c.baseUrl}${path}`, {
      method,
      headers: await headers(body !== undefined && !(body instanceof FormData)),
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "NEXUS core is not reachable");
  }
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, detailMessage(data, res.status), data);
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(p: string, signal?: AbortSignal) => request<T>("GET", p, undefined, signal),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  patch: <T>(p: string, b: unknown) => request<T>("PATCH", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
  upload: <T>(p: string, file: Blob, filename: string) => {
    const fd = new FormData();
    fd.append("file", file, filename);
    return request<T>("POST", p, fd);
  },
  blob: async (path: string, body: unknown): Promise<Blob> => {
    const c = await connection();
    const res = await fetch(`${c.baseUrl}${path}`, { method: "POST", headers: await headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new ApiError(res.status, detailMessage(safeJson(await res.text()), res.status));
    return res.blob();
  },
  text: async (path: string): Promise<string> => {
    const c = await connection();
    const res = await fetch(`${c.baseUrl}${path}`, { headers: await headers(false) });
    if (!res.ok) throw new ApiError(res.status, `Request failed (${res.status})`);
    return res.text();
  },
};

/** POST that returns a Server-Sent Events stream; calls onEvent for each `data:` JSON frame. */
export async function postStream<E>(path: string, body: unknown, onEvent: (e: E) => void, signal?: AbortSignal): Promise<void> {
  const c = await connection();
  let res: Response;
  try {
    res = await fetch(`${c.baseUrl}${path}`, { method: "POST", headers: await headers(), body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    throw new ApiError(0, "NEXUS core is not reachable");
  }
  if (!res.ok || !res.body) {
    const t = await res.text();
    throw new ApiError(res.status, detailMessage(safeJson(t), res.status));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data:")) onEvent(JSON.parse(line.slice(5).trim()) as E);
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  }
}

export async function wsUrl(): Promise<string> {
  const c = await connection();
  return `${c.baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(c.token ?? "")}`;
}

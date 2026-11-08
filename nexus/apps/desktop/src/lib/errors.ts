import { connection } from "./api";

const sent = new Set<string>();

/** Send a frontend error to the core so it lands in data/logs/core.log (deduplicated, best effort). */
export function reportClientError(err: unknown, context = ""): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const key = `${e.message}|${context.slice(0, 80)}`;
  if (sent.has(key)) return;
  sent.add(key);
  void connection()
    .then((c) =>
      fetch(`${c.baseUrl}/api/client-errors`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) },
        body: JSON.stringify({
          message: `${e.name}: ${e.message}`.slice(0, 2000),
          stack: (e.stack ?? "").slice(0, 4000),
          context: context.slice(0, 2000),
          url: window.location.href,
          user_agent: navigator.userAgent,
        }),
      }),
    )
    .catch(() => undefined);
}

export function installGlobalErrorReporting(): void {
  window.addEventListener("error", (ev) => reportClientError(ev.error ?? ev.message, "window.onerror"));
  window.addEventListener("unhandledrejection", (ev) => reportClientError(ev.reason, "unhandledrejection"));
}

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = (Date.now() - t) / 1000;
  const future = diff < 0;
  const s = Math.abs(diff);
  const f = (v: number, u: string) => (future ? `in ${v}${u}` : `${v}${u} ago`);
  if (s < 45) return future ? "soon" : "just now";
  if (s < 3600) return f(Math.round(s / 60), "m");
  if (s < 86400) return f(Math.round(s / 3600), "h");
  if (s < 86400 * 7) return f(Math.round(s / 86400), "d");
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function longDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function greeting(d: Date, name?: string): string {
  const h = d.getHours();
  const part = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : part;
}

export function duration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "—";
  const ms = (endIso ? new Date(endIso).getTime() : Date.now()) - new Date(startIso).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${Math.round(v)}%`;
}

export function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** Split a snippet containing \u0002…\u0003 highlight markers into safe text segments. */
export function highlightSegments(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let hit = false;
  let buf = "";
  for (const ch of snippet) {
    if (ch === "\u0002" || ch === "\u0003") {
      if (buf) out.push({ text: buf, hit });
      buf = "";
      hit = ch === "\u0002";
    } else buf += ch;
  }
  if (buf) out.push({ text: buf, hit });
  return out;
}

import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { api } from "@/lib/api";
import { useCore } from "@/stores/core";
import type { CalendarEvent } from "@/lib/types";

/** Today's calendar on the Home page. Only appears once Calendar access is switched on in Settings. */
export function TodayCard() {
  const on = useCore((s) => Boolean(s.boot?.apple?.available && s.boot.apple.calendar));
  const openSettings = useCore((s) => s.openSettings);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!on) return;
    let live = true;
    const load = () =>
      void api
        .get<{ events: CalendarEvent[] }>("/api/apple/calendar?days=1")
        .then((r) => live && (setEvents(r.events), setError(null)))
        .catch((e: Error) => live && setError(e.message));
    load();
    const t = window.setInterval(load, 10 * 60 * 1000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [on]);

  if (!on) return null;
  const now = new Date().toTimeString().slice(0, 5);
  return (
    <section className="surface rise p-5 md:col-span-2">
      <header className="mb-3 flex items-center gap-2">
        <CalendarDays size={13} className="text-muted" />
        <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-muted">Today</h3>
      </header>
      {error ? (
        <p className="text-[12.5px] text-fg-2">
          {error}{" "}
          <button className="underline underline-offset-2" onClick={() => openSettings("web")}>
            Open settings
          </button>
        </p>
      ) : !events ? (
        <p className="shimmer text-[12.5px]">Reading your calendar…</p>
      ) : events.length === 0 ? (
        <p className="text-[12.5px] text-muted">Nothing on your calendar today.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-x-8 gap-y-1.5 md:grid-cols-2">
          {events.slice(0, 8).map((ev, i) => {
            const time = ev.all_day ? "all day" : ev.start.slice(11, 16);
            const past = !ev.all_day && ev.end.slice(11, 16) < now;
            return (
              <li key={i} className={`flex items-baseline gap-3 text-[13px] ${past ? "text-muted" : "text-fg"}`}>
                <span className="w-12 flex-none font-mono text-[11.5px] text-muted">{time}</span>
                <span className="min-w-0 flex-1 truncate">
                  {ev.title}
                  {ev.location && <span className="text-muted"> · {ev.location}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

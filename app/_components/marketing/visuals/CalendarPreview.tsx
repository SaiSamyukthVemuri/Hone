import { BrowserFrame } from "../ProductFrame";

// Coded, static calendar-day preview (anonymized demo data) for the
// booking/calendar feature page. Not animated. Represents the real
// LIVE_FOR_ALL_ONBOARDED calendar; no invented analytics.

type Slot = {
  time: string;
  title: string;
  sub?: string;
  kind: "appt" | "block" | "open";
};

const SLOTS: Slot[] = [
  { time: "9:00", title: "Consultation", sub: "New client", kind: "appt" },
  { time: "10:30", title: "Upper lip + chin", sub: "Maya R. · 30 min", kind: "appt" },
  { time: "12:00", title: "Break", kind: "block" },
  { time: "1:00", title: "Open", kind: "open" },
  { time: "2:30", title: "Underarms", sub: "Jordan L. · 45 min", kind: "appt" },
];

export function CalendarPreview() {
  return (
    <BrowserFrame contextLabel="hone.care/calendar" label="Illustrative product preview">
      <div className="px-5 pb-5 pt-4 sm:px-6">
        <div className="flex items-baseline justify-between">
          <p className="text-[0.9375rem] font-semibold text-ink">Today · Tuesday</p>
          <p className="text-[0.8125rem] text-muted">Day view</p>
        </div>
        <ul className="mt-4 space-y-1.5">
          {SLOTS.map((s) => (
            <li key={s.time} className="flex items-stretch gap-3">
              <span className="w-12 shrink-0 pt-2 text-[0.75rem] text-muted">{s.time}</span>
              <div
                className="flex-1 rounded-[8px] px-3 py-2"
                style={
                  s.kind === "appt"
                    ? { background: "var(--color-wash)" }
                    : s.kind === "block"
                      ? { background: "var(--color-warm)" }
                      : {
                          border: "1px dashed var(--color-hairline-strong)",
                        }
                }
              >
                <p
                  className={`text-[0.875rem] ${
                    s.kind === "open" ? "text-muted" : "font-medium text-ink"
                  }`}
                >
                  {s.title}
                </p>
                {s.sub ? <p className="text-[0.75rem] text-muted">{s.sub}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </BrowserFrame>
  );
}

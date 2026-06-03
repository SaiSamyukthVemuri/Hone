import { MARKETING_PALETTE as PALETTE } from "./marketingNav";

// Coded product-preview illustrations for the marketing site.
//
// These are NOT screenshots and NOT real client data. Names are
// initials of plausible fictional clients (M. R., E. P., J. K.) so the
// previews read like a real working studio without naming any real
// person. Static and presentational: no hooks, no interactivity, no
// real PII. The clinical values (machine, mode, probe, hairs) are
// realistic for an electrolysis session but are illustrative only.

function PreviewCard({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <figure
      className="flex flex-col overflow-hidden rounded-xl"
      style={{
        backgroundColor: PALETTE.card,
        border: `1px solid ${PALETTE.rule}`,
      }}
    >
      <figcaption
        className="flex items-center gap-2 border-b px-4 py-2"
        style={{ borderColor: PALETTE.rule }}
      >
        <span aria-hidden className="flex gap-1">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: PALETTE.rule }}
          />
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: PALETTE.rule }}
          />
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: PALETTE.rule }}
          />
        </span>
        <span
          className="text-[10px] font-medium uppercase"
          style={{ letterSpacing: "0.18em", color: PALETTE.muted }}
        >
          {label}
        </span>
      </figcaption>
      <div
        className="flex flex-1 flex-col gap-2 p-5 text-[13px]"
        style={{ color: PALETTE.ink }}
      >
        {children}
      </div>
    </figure>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span style={{ color: PALETTE.muted }}>{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

// One-page charting preview (generic demo values, not from any real record).
export function ChartingPreview() {
  return (
    <PreviewCard label="One-page charting · preview">
      <p className="font-[var(--font-fraunces)] text-[18px] font-bold">
        Upper lip
      </p>
      <Row label="Machine" value="27.12 MHz" />
      <Row label="Mode" value="Thermolysis" />
      <Row label="Modality" value="MeloFlash" />
      <Row label="Probe" value="Ballet · Gold · One-piece · F2" />
      <Row label="Hairs treated" value="120" />
      <div style={{ borderTop: `1px solid ${PALETTE.rule}` }} className="my-1" />
      <p style={{ color: PALETTE.muted }}>
        <span className="font-medium" style={{ color: PALETTE.ink }}>
          Notes:{" "}
        </span>
        Cleared. Mild redness, settled fast.
      </p>
    </PreviewCard>
  );
}

// Treatment plan / progress preview: the fixed clinical stages + a
// planned-vs-logged summary. Demo numbers only.
export function PlanProgressPreview() {
  const stages: ReadonlyArray<{ name: string; note: string }> = [
    { name: "Clearing", note: "Weekly · 15 min" },
    { name: "Control", note: "Every 2 weeks · 15 min" },
    { name: "Maintenance", note: "Monthly · 15 min" },
  ];
  return (
    <PreviewCard label="Treatment plan · preview">
      <div className="flex flex-col gap-2">
        {stages.map((s, i) => (
          <div
            key={s.name}
            className="flex items-baseline justify-between gap-3"
          >
            <span className="font-medium">
              <span style={{ color: PALETTE.muted }}>{i + 1}. </span>
              {s.name}
            </span>
            <span className="text-[11px]" style={{ color: PALETTE.muted }}>
              {s.note}
            </span>
          </div>
        ))}
      </div>
      <div style={{ borderTop: `1px solid ${PALETTE.rule}` }} className="my-1" />
      <Row label="Logged" value="2h 15m" />
      <Row label="Est. remaining" value="~6h" />
    </PreviewCard>
  );
}

// Calendar preview: one past, one upcoming, one break. Initials only,
// no contact details, no surnames. Plausible fictional clients.
export function CalendarPreview() {
  const items: ReadonlyArray<{
    time: string;
    who: string;
    tag: string;
    muted: boolean;
  }> = [
    { time: "9:00", who: "E. P.", tag: "Done", muted: true },
    { time: "10:00", who: "M. R.", tag: "Confirmed", muted: false },
    { time: "12:00", who: "Lunch", tag: "Break", muted: true },
  ];
  return (
    <PreviewCard label="Calendar · preview">
      <div className="flex flex-col gap-2">
        {items.map((it) => (
          <div
            key={it.time + it.who}
            className={`flex items-center justify-between gap-3 rounded-md px-2 py-1.5 ${
              it.muted ? "opacity-60" : ""
            }`}
            style={{
              border: `1px solid ${PALETTE.rule}`,
              backgroundColor: PALETTE.bg,
            }}
          >
            <span>
              <span style={{ color: PALETTE.muted }}>{it.time}</span> · {it.who}
            </span>
            <span
              className="text-[10px] font-medium uppercase"
              style={{ letterSpacing: "0.1em", color: PALETTE.muted }}
            >
              {it.tag}
            </span>
          </div>
        ))}
      </div>
    </PreviewCard>
  );
}

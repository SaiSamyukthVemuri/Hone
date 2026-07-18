import { ProductFrame } from "../ProductFrame";

// The signature product visual: a coded "Before today" briefing (the real
// LIVE_FOR_ALL_ONBOARDED capability), rendered statically with a clean vertical
// rail connecting each recorded fact. All data is anonymized demo data.

type Row = {
  label: string;
  value: string;
  emphasis?: boolean;
};

const ROWS: Row[] = [
  { label: "Today · 2:00 PM", value: "Upper lip + chin · 30 min", emphasis: true },
  { label: "Last treatment · 3 weeks ago", value: "Blend · Upper lip" },
  { label: "Setup", value: "Blend · 27 MHz · Energy 3 · Probe F3 · Lot L-204" },
  { label: "Client response (last recorded)", value: "Tolerated well · mild erythema, settled" },
  { label: "Watch", value: "Sensitive along the jawline" },
  { label: "For next visit", value: "Increase spacing · confirm numbing" },
];

export function TreatmentMemoryPanel() {
  return (
    <ProductFrame>
      <div className="px-5 pb-5 pt-4 sm:px-6 sm:pb-6">
        <div className="flex items-baseline justify-between">
          <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-mineral">
            Before today
          </p>
          <p className="text-[0.8125rem] text-muted">Maya R. · returning</p>
        </div>

        <div className="relative mt-4 pl-7">
          {/* Clean vertical rail connecting the recorded facts. */}
          <span
            aria-hidden="true"
            className="absolute left-[9px] top-2 bottom-2 w-px"
            style={{ backgroundColor: "var(--color-mineral)", opacity: 0.35 }}
          />
          <ul className="space-y-3.5">
            {ROWS.map((row) => (
              <li key={row.label} className="relative">
                <span
                  aria-hidden="true"
                  className="absolute left-[-1.375rem] top-[6px] h-2 w-2 rounded-full"
                  style={{
                    background: row.emphasis ? "var(--color-mineral)" : "var(--color-wash)",
                    boxShadow: "0 0 0 2px white",
                  }}
                />
                <p className="text-[0.75rem] uppercase tracking-[0.08em] text-muted">
                  {row.label}
                </p>
                <p
                  className={`mt-0.5 text-[0.9375rem] ${
                    row.emphasis ? "font-semibold text-ink" : "text-ink"
                  }`}
                >
                  {row.value}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </ProductFrame>
  );
}

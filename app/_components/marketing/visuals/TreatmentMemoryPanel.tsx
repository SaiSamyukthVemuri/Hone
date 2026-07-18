"use client";

import { useEffect, useState } from "react";
import { ProductFrame } from "../ProductFrame";

// The signature product visual: a coded "Before today" briefing (the real
// LIVE_FOR_ALL_ONBOARDED capability), assembled once on mount — each fact
// settles in, then an SVG "memory thread" draws to connect them. All data is
// anonymized demo data. Reduced motion collapses to the final composed state
// via globals.css. The frame box is reserved, so there is zero layout shift.

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
  const [run, setRun] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setRun(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <ProductFrame className={run ? "marketing-assemble-run" : undefined}>
      <div className="px-5 pb-5 pt-4 sm:px-6 sm:pb-6">
        <div className="flex items-baseline justify-between">
          <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-mineral">
            Before today
          </p>
          <p className="text-[0.8125rem] text-muted">Maya R. · returning</p>
        </div>

        <div className="relative mt-4 pl-6">
          {/* Memory thread down the left rail. */}
          <svg
            className="pointer-events-none absolute left-[7px] top-2 h-[calc(100%-1rem)] w-3"
            viewBox="0 0 8 300"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <line
              data-thread
              x1="4"
              y1="0"
              x2="4"
              y2="300"
              stroke="var(--color-mineral)"
              strokeWidth="1.5"
              strokeLinecap="round"
              style={{ ["--mk-thread-len" as string]: "300" }}
            />
          </svg>

          <ul className="space-y-3.5">
            {ROWS.map((row, i) => (
              <li
                key={row.label}
                data-assemble
                style={{ ["--mk-assemble-delay" as string]: `${140 + i * 130}ms` }}
                className="relative"
              >
                <span
                  aria-hidden="true"
                  className="absolute -left-6 top-1.5 h-2 w-2 rounded-full"
                  style={{
                    background: row.emphasis ? "var(--color-mineral)" : "var(--color-wash)",
                    outline: "2px solid white",
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

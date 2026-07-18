import { ProductFrame } from "../ProductFrame";

// Coded, static session/procedure-record preview (anonymized demo data) for the
// charting/records feature page. Represents the real charting surface — machine
// settings, structured probe + lot, minutes, tolerance — nothing invented.

const ROWS: { label: string; value: string }[] = [
  { label: "Area", value: "Upper lip · midline" },
  { label: "Mode", value: "Blend · 27 MHz · Energy 3" },
  { label: "Probe", value: "F3 · Lot L-204" },
  { label: "Minutes", value: "18" },
  { label: "Tolerance", value: "Tolerated well" },
  { label: "For next visit", value: "Increase spacing" },
];

export function SessionRecordPreview() {
  return (
    <ProductFrame label="Example treatment record">
      <div className="px-5 pb-5 pt-4 sm:px-6">
        <div className="flex items-baseline justify-between">
          <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-mineral">
            Session record
          </p>
          <p className="text-[0.8125rem] text-muted">Jordan L. · Tue</p>
        </div>
        <dl className="mt-4 divide-y divide-[color:var(--color-hairline)]">
          {ROWS.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-[0.75rem] uppercase tracking-[0.08em] text-muted">
                {r.label}
              </dt>
              <dd className="text-right text-[0.9375rem] text-ink">{r.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </ProductFrame>
  );
}

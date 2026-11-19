import Link from "next/link";

import { localDateString } from "@/lib/booking/tz";

import { SectionLabel } from "@/components/ui/section-label";
import { INSURER_FIELD_GAPS } from "@/lib/clinical-records/insurer-field-gaps";
import { MONEY_FORMS } from "@/lib/dashboard/other-money-forms";
import {
  ADJUSTMENT_KINDS,
  AMOUNT_KINDS,
  COLLECTED_KINDS,
  type StatementBucket,
  type StatementKind,
} from "@/lib/finance/statement";
import {
  INSURER_BLOCK_NOTE,
  INSURER_NOT_RECORDED,
  STATEMENT_ADJUSTMENTS_NOTE,
  STATEMENT_FRAMING,
  STATEMENT_METHOD_LABELS,
  STATEMENT_NO_TOTAL,
  STATEMENT_UNNAMED_PRACTITIONER,
  STATEMENT_OUTSIDE_SCOPE,
  STATEMENT_PARTIAL_REFUND_NOTE,
  STATEMENT_PRACTITIONER_RULE,
  STATEMENT_UNRESOLVED_NOTE,
  STATEMENT_WRITE_OFFS_NOTE,
  unreadableFormsLine,
} from "@/lib/finance/statement-copy";
import { shiftYearMonth } from "@/lib/finance/statement-period";
import type { StatementView as View } from "@/lib/finance/statement-read";

const UNAVAILABLE: Record<string, string> = {
  read_failed: "The statement could not be read, so nothing is shown. No figure is guessed. Try again.",
  too_many_appointments: "This month has more appointments than this statement can read exactly, so it shows nothing rather than part of a month.",
  currency_unknown: "This studio's payment currency is not set, so money cannot be totalled. Nothing is shown.",
};

function Rows({ bucket, kinds, format }: { bucket: StatementBucket; kinds: readonly StatementKind[]; format: (c: number) => string }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {kinds.map((k) => (
          <tr key={k} className="border-t border-line">
            <th scope="row" className="py-2 pr-3 text-left font-normal text-fg">
              {STATEMENT_METHOD_LABELS[k]}
            </th>
            <td className="py-2 pr-3 text-right text-fg-muted">{bucket.kinds[k].count} {bucket.kinds[k].count === 1 ? "row" : "rows"}</td>
            <td className="py-2 text-right tabular-nums text-fg">{AMOUNT_KINDS.includes(k) ? format(bucket.kinds[k].cents) : STATEMENT_NO_TOTAL}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Section({ bucket, format }: { bucket: StatementBucket; format: (c: number) => string }) {
  return (
    <div className="space-y-4">
      <div>
        <SectionLabel>Collected</SectionLabel>
        <Rows bucket={bucket} kinds={COLLECTED_KINDS} format={format} />
        <p className="mt-2 text-sm font-medium text-fg">Collected in total: {format(bucket.collectedCents)}</p>
      </div>
      <div>
        <SectionLabel>Adjustments</SectionLabel>
        <Rows bucket={bucket} kinds={ADJUSTMENT_KINDS} format={format} />
      </div>
      <div>
        <SectionLabel>Not totalled</SectionLabel>
        <Rows bucket={bucket} kinds={["unresolved", "other_currency", "excluded", "unreadable", "still_owes_note"]} format={format} />
      </div>
    </div>
  );
}

export function StatementView({ view, currency, format }: { view: View; currency: string | null; format: (c: number) => string }) {
  if (view.access === "refused") {
    return <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">Only the studio owner can see the money statement.</section>;
  }
  if (!view.ok) {
    return <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">{UNAVAILABLE[view.reason]}</section>;
  }
  const { statement } = view;
  const nameOf = (id: string) => view.visitInfo[id];
  const prev = shiftYearMonth(view.month, -1);
  const next = shiftYearMonth(view.month, 1);
  const r = statement.reconciliation;
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-fg">Money statement: {view.label}</h1>
        <p className="text-sm text-fg-muted">
          Visits that started {view.startLocal} to the end of the month, in the studio&apos;s timezone ({view.timezone}). Currency: {currency?.toUpperCase()}.
        </p>
        <p className="text-sm text-fg">{STATEMENT_FRAMING}</p>
        <form method="get" action="/financials/statement" className="flex items-end gap-2 text-sm" aria-label="Choose a month">
          <label className="flex flex-col gap-1 text-fg">
            Month
            <input type="month" name="month" defaultValue={view.month} className="rounded border border-line px-2 py-1" />
          </label>
          <button type="submit" className="rounded border border-line px-3 py-1">Show month</button>
        </form>
        <nav className="flex gap-4 text-sm" aria-label="Month">
          <Link href={`/financials/statement?month=${prev}`} className="underline">Previous month</Link>
          <Link href={`/financials/statement?month=${next}`} className="underline">Next month</Link>
        </nav>
      </header>

      <section className="space-y-3" aria-labelledby="stmt-all">
        <h2 id="stmt-all" className="text-lg font-medium text-fg">All practitioners</h2>
        <Section bucket={statement.all} format={format} />
        <p className="text-sm text-fg-muted">{STATEMENT_ADJUSTMENTS_NOTE} {STATEMENT_WRITE_OFFS_NOTE}</p>
        <p className="text-sm text-fg-muted">{STATEMENT_UNRESOLVED_NOTE} {STATEMENT_PARTIAL_REFUND_NOTE}</p>
      </section>

      <section className="space-y-3" aria-labelledby="stmt-prac">
        <h2 id="stmt-prac" className="text-lg font-medium text-fg">By practitioner</h2>
        <p className="text-sm text-fg-muted">{STATEMENT_PRACTITIONER_RULE}</p>
        {statement.byPractitioner.length === 0 ? <p className="text-sm text-fg">No recorded money for visits this month.</p> : null}
        {statement.byPractitioner.map((p) => (
          <div key={p.practitionerId ?? "none"} className="rounded-lg border border-line p-4">
            <h3 className="text-base font-medium text-fg">{p.practitionerId === null ? "Unattributed" : view.practitionerNames[p.practitionerId] ?? STATEMENT_UNNAMED_PRACTITIONER}</h3>
            <Section bucket={p.bucket} format={format} />
          </div>
        ))}
      </section>

      <section className="space-y-3" aria-labelledby="stmt-visits">
        <h2 id="stmt-visits" className="text-lg font-medium text-fg">Visits</h2>
        {statement.visits.length === 0 ? <p className="text-sm text-fg">No visit has recorded money this month.</p> : null}
        {statement.visits.map((v) => (
          <details key={v.appointmentId} className="rounded-lg border border-line p-3">
            <summary className="cursor-pointer text-sm text-fg">
              {localDateString(new Date(v.startsAt), view.timezone)}: {nameOf(v.appointmentId)?.clientName}
              {nameOf(v.appointmentId)?.serviceName ? `, ${nameOf(v.appointmentId)?.serviceName}` : ""}
            </summary>
            <ul className="mt-2 space-y-1 text-sm text-fg">
              {v.lines.map((l, i) => (
                <li key={i}>{STATEMENT_METHOD_LABELS[l.kind]}: {AMOUNT_KINDS.includes(l.kind) && l.cents !== null ? format(l.cents) : STATEMENT_NO_TOTAL}</li>
              ))}
            </ul>
            <div className="mt-3 border-t border-line pt-2">
              <SectionLabel>Insurer details</SectionLabel>
              <ul className="mt-1 space-y-1 text-sm text-fg">
                {INSURER_FIELD_GAPS.map((g) => (
                  <li key={g.key}>{g.label}: {INSURER_NOT_RECORDED}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-fg-muted">{INSURER_BLOCK_NOTE}</p>
            </div>
          </details>
        ))}
      </section>

      <footer className="space-y-2 text-sm text-fg-muted">
        <p>
          Reconciliation: {r.rowsClassified} money {r.rowsClassified === 1 ? "row" : "rows"} placed, each in exactly one line above
          {r.rowsWithoutAppointment > 0 ? `, ${r.rowsWithoutAppointment} not matched to a visit shown as Unattributed` : ""}.
        </p>
        <p>{STATEMENT_OUTSIDE_SCOPE}</p>
        <p>{unreadableFormsLine(MONEY_FORMS)}</p>
      </footer>
    </div>
  );
}

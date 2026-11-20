import Link from "next/link";
import type { ReactNode } from "react";

import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";

import { MonthControls, SUMMARY_TONE } from "../statements/statements-chrome";

import { formatLocalDateLabel, localDateString, localTimeString12h } from "@/lib/booking/tz";

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
import { bucketMethodBreakdown, SHORT_METHOD_LABEL, studioVisitStatus, visitCollectedCents, type VisitStatus } from "@/lib/finance/statement-methods";
import { clientStatementHref } from "@/lib/finance/statement-screen";
import { latestFirst, slicePage } from "@/lib/finance/statement-paging";
import type { StatementView as View } from "@/lib/finance/statement-read";
import type { YearMonth } from "@/lib/finance/statement-period";

const UNAVAILABLE: Record<string, string> = {
  read_failed: "The statement could not be read, so nothing is shown. No figure is guessed. Try again.",
  too_many_appointments: "This month has more appointments than this statement can read exactly, so it shows nothing rather than part of a month.",
  currency_unknown: "This studio's payment currency is not set, so money cannot be totalled. Nothing is shown.",
  month_out_of_range: "That month is outside the range this statement covers (January 2000 to the current month). Nothing is shown.",
};

function Rows({ bucket, kinds, format }: { bucket: StatementBucket; kinds: readonly StatementKind[]; format: (c: number) => string }) {
  return (
    <table className="w-full overflow-hidden rounded-xl border border-line bg-surface text-sm">
      <tbody>
        {kinds.map((k) => (
          <tr key={k} className="border-t border-line first:border-t-0">
            <th scope="row" className="px-4 py-2.5 text-left font-normal text-fg">
              {STATEMENT_METHOD_LABELS[k]}
            </th>
            <td className="px-3 py-2.5 text-right text-fg-muted">{bucket.kinds[k].count} {bucket.kinds[k].count === 1 ? "row" : "rows"}</td>
            <td className="px-4 py-2.5 text-right tabular-nums text-fg">{AMOUNT_KINDS.includes(k) ? format(bucket.kinds[k].cents) : STATEMENT_NO_TOTAL}</td>
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
        <p className={cx("mt-2 rounded-xl px-4 py-3 text-base font-semibold tabular-nums text-fg", SUMMARY_TONE)}>Collected in total: {format(bucket.collectedCents)}</p>
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

// ---- The summary card: the studio's collected total at display size and how it was paid. ---------------------------------------------------------
// The figures are the bucket's own. The proportional bar and the method list appear ONLY when the non-zero methods add up to the collected total to the
// cent (bucketMethodBreakdown); with nothing collected, or segments that cannot be explained, the card says so in words and draws no bar.
function splitCurrency(text: string): { amount: string; unit: string | null } {
  const m = /^(.*\d) ([A-Z]{3})$/.exec(text);
  return m ? { amount: m[1], unit: m[2] } : { amount: text, unit: null };
}

function SummaryCard({ bucket, visitCount, monthLabel, studioName, format }: { bucket: StatementBucket; visitCount: number; monthLabel: string; studioName?: string | null; format: (c: number) => string }) {
  const methods = bucketMethodBreakdown(bucket);
  const { amount, unit } = splitCurrency(format(bucket.collectedCents));
  return (
    <section aria-label="Summary" className={cx("grid items-center gap-[30px] rounded-[14px] px-[18px] py-[18px] min-[781px]:px-[30px] min-[781px]:py-[25px] max-[540px]:grid-cols-1 sm:grid-cols-2", SUMMARY_TONE)}>
      <div>
        {studioName ? <p className="font-semibold text-fg">{studioName}</p> : null}
        <p className="text-[#5d685f]">{monthLabel} · Total collected</p>
        <p className="mt-1 text-[clamp(34px,5vw,54px)] font-semibold leading-[1.15] tracking-[-2.8px] tabular-nums text-fg max-[540px]:text-[38px]">
          {amount}
          {unit ? <small className="ml-2 text-base font-normal tracking-normal text-[#5d685f]">{unit}</small> : null}
        </p>
        <p className="text-sm text-[#5d685f]">{visitCount} {visitCount === 1 ? "visit" : "visits"} with recorded money</p>
      </div>
      <div className="border-[#c5d2c3] sm:border-l sm:pl-[30px] max-[540px]:border-t max-[540px]:pt-3">
        <h2 className="text-base font-semibold text-fg">Collected by method</h2>
        {methods ? (
          <>
            <div className="my-3 flex h-[7px] overflow-hidden rounded-lg bg-[#d5dfd2]" aria-hidden="true">
              {methods.map((m, i) => <span key={m.kind} className="h-full bg-[#3f6b52]" style={{ width: `${(m.cents / bucket.collectedCents) * 100}%`, opacity: 1 - i * 0.22 }} />)}
            </div>
            <ul className="space-y-1 text-fg">
              {methods.map((m) => <li key={m.kind} className="flex justify-between gap-3"><span>{SHORT_METHOD_LABEL[m.kind] ?? m.label}</span><span className="tabular-nums">{splitCurrency(format(m.cents)).amount}</span></li>)}
            </ul>
          </>
        ) : bucket.collectedCents === 0 ? (
          <p className="mt-2 text-sm text-[#5d685f]">No recorded money for visits this month.</p>
        ) : (
          <p className="mt-2 text-sm text-[#5d685f]">The full payment breakdown below lists every line.</p>
        )}
      </div>
    </section>
  );
}

// ---- The visits table ---------------------------------------------------------------------------------------------------------------------------
const LINE_GRID = "grid grid-cols-[52px_1fr_1fr_74px_24px] items-center gap-1.5 px-2 py-3 text-xs min-[781px]:grid-cols-[83px_minmax(145px,1.4fr)_minmax(110px,1fr)_minmax(140px,1.1fr)_105px_26px] min-[781px]:gap-3 min-[781px]:px-[18px] min-[781px]:py-[14px] min-[781px]:text-sm";
const TAG = "inline-block rounded-[20px] px-[9px] py-0.5 text-xs max-[540px]:px-[5px] max-[540px]:text-[11px]";

function shortDate(ymd: string): string {
  return formatLocalDateLabel(ymd).replace(/,\s*\d{4}$/, "");
}

type OkView = Extract<View, { ok: true }>;
type VisitT = OkView["statement"]["visits"][number];
// A row of the visit table: a visit with recorded money, or a COMPLETED visit with no payment recorded (no lines, no amount; in no total).
type Row = VisitT & { noPayment: boolean };

function VisitRow({ v, view, format }: { v: Row; view: OkView; format: (c: number) => string }) {
  const info = view.visitInfo[v.appointmentId];
  const when = new Date(v.startsAt);
  const ymd = localDateString(when, view.timezone);
  const status: VisitStatus = v.noPayment ? { label: "No payment recorded", tone: "neutral" } : studioVisitStatus(v.lines, view.settlementQuotes[v.appointmentId] ?? null);
  const collected = v.noPayment ? null : visitCollectedCents(v.lines);
  // The short method words under the pill ("Card", "E-transfer"). A still-owing note or a waiver is kept in its full words BESIDE money (the pill alone
  // would not say it); with no money the pill already says it, so it is not repeated.
  const methods = v.lines.filter((l) => (COLLECTED_KINDS.includes(l.kind) && l.cents !== null) || (collected !== null && (l.kind === "still_owes_note" || l.kind === "waived")));
  // Under the client on a phone the reference shows only the length ("60 min"); the service name is the fallback when no length is known.
  const serviceText = info?.minutes ? `${info.minutes} min` : info?.serviceName ?? "";
  return (
    <details className="group border-t border-[#e6e8e3] first:border-t-0">
      <summary className={cx(LINE_GRID, "cursor-pointer list-none [&::-webkit-details-marker]:hidden", FOCUS_RING)}>
        <span>
          <time dateTime={ymd}>{shortDate(ymd)}</time>
          <span className="block text-xs text-[#637067]">{localTimeString12h(when, view.timezone)}</span>
        </span>
        <span>
          {info?.clientId ? (
            <Link href={clientStatementHref(info.clientId, view.month as YearMonth, "month")} className="text-[#31573d] underline underline-offset-2">{info.clientName}</Link>
          ) : (
            <span className="text-fg">{info?.clientName}</span>
          )}
          {serviceText ? <span className="block text-xs text-[#5d685f] min-[781px]:hidden">{serviceText}</span> : null}
        </span>
        <span className="hidden text-fg min-[781px]:block">{info?.serviceName ?? ""}{info?.serviceName && info.minutes ? <small className="ml-1 text-xs text-[#5d685f]">· {info.minutes} min</small> : null}</span>
        <span>
          <span className={cx(TAG, status.tone === "paid" ? "bg-[#eaf2e9] text-[#31573d]" : "bg-[#f3eee4] text-[#675534]")}>{status.label}</span>
          {status.reason ? <span className="block text-xs text-[#5d685f]">{status.reason}</span> : null}
          {methods.map((l, i) => <span key={i} className="block text-xs text-[#5d685f]">{SHORT_METHOD_LABEL[l.kind] ?? STATEMENT_METHOD_LABELS[l.kind]}</span>)}
        </span>
        <span className="text-right font-medium tabular-nums text-fg max-[780px]:text-[13px]">{collected === null ? <><span aria-hidden="true">—</span><span className="sr-only">{STATEMENT_NO_TOTAL}</span></> : splitCurrency(format(collected)).amount}</span>
        <span aria-hidden="true" className="inline-flex size-[26px] items-center justify-center rounded-lg border border-[#d6dbd3] bg-white text-fg group-open:bg-[#edf1eb]">
          <span className="group-open:hidden">+</span>
          <span className="hidden group-open:inline">−</span>
        </span>
      </summary>
      <div className="border-t border-[#e6e8e3] bg-[#f8faf6] px-[22px] py-3 text-sm text-fg">
        {v.noPayment ? <p>No payment recorded for this visit.</p> : null}
        <ul className="space-y-1">
          {v.lines.map((l, i) => (
            <li key={i}>{STATEMENT_METHOD_LABELS[l.kind]}: {AMOUNT_KINDS.includes(l.kind) && l.cents !== null ? format(l.cents) : STATEMENT_NO_TOTAL}</li>
          ))}
        </ul>
        <div className="mt-3 border-t border-[#e6e8e3] pt-2">
          <SectionLabel>Insurer details</SectionLabel>
          <ul className="mt-1 space-y-1">
            {INSURER_FIELD_GAPS.map((g) => (
              <li key={g.key}>{g.label}: {INSURER_NOT_RECORDED}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-[#5d685f]">{INSURER_BLOCK_NOTE}</p>
        </div>
      </div>
    </details>
  );
}

const PAGER_LINK = cx("inline-flex items-center rounded-lg border border-[#d6dbd3] bg-white px-3 text-sm text-fg hover:bg-[#edf1eb]", CONTROL_MIN_TOUCH, FOCUS_RING);
const PAGER_OFF = cx("inline-flex items-center rounded-lg border border-[#d6dbd3] bg-white px-3 text-sm text-fg opacity-35", CONTROL_MIN_TOUCH);

export function StatementView({
  view,
  currency,
  format,
  maxMonth,
  notice,
  page = 1,
  tabs,
  studioName,
}: {
  view: View;
  currency: string | null;
  format: (c: number) => string;
  maxMonth?: string;
  notice?: string | null;
  page?: number;
  tabs?: ReactNode;
  studioName?: string | null;
}) {
  if (view.access === "refused") {
    return <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">Only the studio owner can see the money statement.</section>;
  }
  if (!view.ok) {
    // The Studio and Clients tabs stay on the error screen, so an owner whose Studio read failed can still reach Clients.
    return (
      <div className="space-y-6">
        {tabs}
        <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg">{UNAVAILABLE[view.reason]}</section>
      </div>
    );
  }
  const { statement } = view;
  const r = statement.reconciliation;
  // Latest first, as the reference draws it. The ORDER only decides which visits fall on which page: the totals, the counts and every figure above are
  // computed from the whole list and cannot depend on it or on the page being viewed.
  // Completed visits with no payment recorded join the table as rows with no amount. They are a LISTING only: the summary, the breakdown and every count of
  // money above are computed from statement.visits and statement.all, which never include them.
  const rows: Row[] = [
    ...statement.visits.map((v) => ({ ...v, noPayment: false })),
    ...view.noPaymentVisits.map((n) => ({ appointmentId: n.appointmentId, startsAt: n.startsAt, practitionerId: n.practitionerId, lines: [], noPayment: true })),
  ];
  const ordered = rows.sort(latestFirst);
  const pg = slicePage(ordered, page);
  const pageHref = (n: number) => `/financials/statement?month=${view.month}${n > 1 ? `&page=${n}` : ""}`;
  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <p className="text-sm text-[#5d685f]">Business &nbsp;/&nbsp; Statements</p>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-[clamp(32px,4vw,46px)] font-bold leading-[1.07] tracking-[-2px] text-fg">Monthly statements</h1>
          <MonthControls base="/financials/statement" month={view.month as YearMonth} maxMonth={(maxMonth ?? "9999-12") as YearMonth} />
        </div>
        {tabs}
        {notice ? <p className="text-sm text-fg" role="status">{notice}</p> : null}
      </header>

      <SummaryCard bucket={statement.all} visitCount={statement.visits.length} monthLabel={view.label} studioName={studioName} format={format} />

      <details className="rounded-xl border border-[#dbe0d8] bg-white px-[22px] py-4 max-[540px]:px-3">
        <summary className={cx("cursor-pointer font-semibold text-fg", FOCUS_RING)}>Full payment breakdown</summary>
        <div className="mt-4 space-y-8">
          <section className="space-y-3" aria-labelledby="stmt-all">
            <h2 id="stmt-all" className="text-[21px] font-semibold tracking-[-0.65px] text-fg">All practitioners</h2>
            <Section bucket={statement.all} format={format} />
            <p className="text-sm text-fg-muted">{STATEMENT_ADJUSTMENTS_NOTE} {STATEMENT_WRITE_OFFS_NOTE}</p>
            <p className="text-sm text-fg-muted">{STATEMENT_UNRESOLVED_NOTE} {STATEMENT_PARTIAL_REFUND_NOTE}</p>
          </section>

          <section className="space-y-3" aria-labelledby="stmt-prac">
            <h2 id="stmt-prac" className="text-[21px] font-semibold tracking-[-0.65px] text-fg">By practitioner</h2>
            <p className="text-sm text-fg-muted">{STATEMENT_PRACTITIONER_RULE}</p>
            {statement.byPractitioner.length === 0 ? <p className="text-sm text-fg">No recorded money for visits this month.</p> : null}
            {statement.byPractitioner.map((p) => (
              <div key={p.practitionerId ?? "none"} className="rounded-xl border border-[#dbe0d8] bg-white p-4">
                <h3 className="text-base font-medium text-fg">{p.practitionerId === null ? "Unattributed" : view.practitionerNames[p.practitionerId] ?? STATEMENT_UNNAMED_PRACTITIONER}</h3>
                <Section bucket={p.bucket} format={format} />
              </div>
            ))}
          </section>
        </div>
      </details>

      <section aria-labelledby="stmt-visits" className="mt-[29px]">
        <div className="mb-[13px]">
          <h2 id="stmt-visits" className="text-[21px] font-semibold tracking-[-0.65px] text-fg">Visits</h2>
          <p className="text-sm text-[#5d685f]">{view.label} · Latest first</p>
        </div>
        {statement.visits.length === 0 ? <p className="text-sm text-fg">No visit has recorded money this month.</p> : null}
        {rows.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-[#dbe0d8] bg-white">
            <div className={cx(LINE_GRID, "bg-[#f1f3ef] !text-xs font-semibold text-[#637067]")} aria-hidden="true">
              <span>Date</span><span>Client</span><span className="hidden min-[781px]:block">Service</span><span>Payment</span><span className="text-right">Collected</span><span />
            </div>
            {pg.items.map((v) => <VisitRow key={v.appointmentId} v={v} view={view} format={format} />)}
          </div>
        ) : null}
        {view.noPaymentVisits.length > 0 ? <p className="mt-3 text-sm text-[#5d685f]">Completed visits with no payment recorded are listed without an amount. They are not in any total above.</p> : null}
        {pg.pages > 1 || pg.total > pg.items.length ? (
          <nav aria-label="Visit pages" className="mt-3 flex items-center justify-end gap-2.5">
            <span className="text-sm text-[#5d685f]">{pg.from}–{pg.to} of {pg.total}</span>
            {pg.page > 1 ? <Link href={pageHref(pg.page - 1)} className={PAGER_LINK}>Previous</Link> : <span className={PAGER_OFF} aria-disabled="true">Previous</span>}
            {pg.page < pg.pages ? <Link href={pageHref(pg.page + 1)} className={PAGER_LINK}>Next</Link> : <span className={PAGER_OFF} aria-disabled="true">Next</span>}
          </nav>
        ) : null}
      </section>

      <footer className="space-y-2 text-sm text-fg-muted">
        <p>
          Visits that started {view.startLocal} to the end of the month, in the studio&apos;s timezone ({view.timezone}). Currency: {currency?.toUpperCase()}.
        </p>
        <p>{STATEMENT_FRAMING}</p>
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

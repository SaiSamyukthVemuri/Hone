import { PendingLink } from "@/components/pending-link";
import { MONEY_LABELS, moneyRows, statementMoneySummary } from "@/lib/billing/visit-money";
import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import {
  FEE_REASON_COPY,
  NOT_COMPLETED_COPY,
  TOTAL_PAID_DEFINITION,
  awaitingVisitLine,
  formatLocalDate,
  paidSummaryLine,
  partialRefundedCents,
  refundPendingCents,
  visitCountPhrase,
  type DocumentVisit,
  type StatementDocument,
} from "@/lib/finance/statement-document";
import { offDocumentMoneyNotice } from "@/lib/finance/statement-directory";
import type { YearMonth } from "@/lib/finance/statement-period";
import {
  FEE_ITEM_STATE_LABEL,
  FINDER_TOO_MANY,
  STATEMENT_READ_UNAVAILABLE,
  VISIT_STATE_LABEL,
  balanceText,
  clientStatementHref,
  clientsListHref,
  moneyLineTexts,
  scopeHeading,
  statementExportHref,
  statementPrintHref,
  visitFeeWithBasis,
  type ClientView,
} from "@/lib/finance/statement-screen";

import { COLLECTED_KINDS } from "@/lib/finance/statement";
import { documentVisitTone, methodBreakdown, SHORT_METHOD_LABEL, visitCollectedCents } from "@/lib/finance/statement-methods";
import { formatClock12h, splitCurrency } from "@/lib/finance/statement-money";
import { latestFirst } from "@/lib/finance/statement-paging";

import type { ReactNode } from "react";

import { ClientFinder } from "./client-finder";
import type { ClientsViewProps } from "./clients-view";
import { MonthControls, PILL_TONE, SEGMENT_GROUP, SUMMARY_TONE, segmentClass } from "./statements-chrome";

export type ClientStatementViewProps = {
  document: StatementDocument;
  month: YearMonth;
  monthLabel: string;
  maxMonth: YearMonth;
  view: ClientView;
  notice: string | null;
  offDocumentWithMoney: number;
  format: (cents: number) => string;
  /** The Studio / Clients tabs, drawn above the statement as on the other statements screens. */
  tabs?: ReactNode;
  /** The data behind "Find a client"; absent draws no box. */
  finder?: ClientsViewProps["finder"];
  /** The studio's name, shown under the total beside the visit count (as the approved design). Absent draws only the count. */
  studioName?: string | null;
};

// The pill's words come from VISIT_STATE_LABEL, unchanged; only the paid state is drawn green, the others in the Studio tab's neutral tan.
const TAG = "inline-block rounded-[20px] px-[9px] py-0.5 text-xs max-[540px]:px-[5px] max-[540px]:text-[11px]";
// date | visit | payment | collected | toggle: the Studio tab's row shape, narrower because the client is already known.
const LINE_GRID = "grid grid-cols-[58px_minmax(0,1fr)_minmax(0,92px)_60px_24px] items-center gap-1.5 px-2 py-3 text-xs min-[781px]:grid-cols-[110px_minmax(145px,1.4fr)_minmax(140px,1.1fr)_105px_26px] min-[781px]:gap-3 min-[781px]:px-[18px] min-[781px]:py-[14px] min-[781px]:text-sm";
const PRIMARY = cx("inline-flex items-center rounded-lg border border-accent bg-accent px-3 text-sm font-medium text-on-accent hover:border-accent-hover hover:bg-accent-hover", CONTROL_MIN_TOUCH, FOCUS_RING);
const ACTION = cx("inline-flex items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-sunken", CONTROL_MIN_TOUCH, FOCUS_RING);

/** "Nov 19" within one month; "Nov 19, 2026" across the full history (the year is needed there). */
function dateText(localDate: string, view: ClientView): string {
  const full = formatLocalDate(localDate);
  return view === "month" ? full.replace(/,\s*\d{4}$/, "") : full;
}

/** One visit: the Studio tab's row (date over time, service and minutes, the unchanged status words with the method beneath, collected, "+"), with everything else in the expander. */
function VisitRow({ v, view, format }: { v: DocumentVisit; view: ClientView; format: (c: number) => string }) {
  const lines = moneyLineTexts(v, format);
  const collected = visitCollectedCents(v.lines);
  const methods = v.lines.filter((l) => COLLECTED_KINDS.includes(l.kind) && l.cents !== null);
  return (
    <details className="group border-t border-line first:border-t-0">
      <summary className={cx(LINE_GRID, "cursor-pointer list-none [&::-webkit-details-marker]:hidden", FOCUS_RING)}>
        <span>
          <time dateTime={v.localDate}>{dateText(v.localDate, view)}</time>
          <span className="block text-xs text-fg-muted">{formatClock12h(v.localTime)}</span>
        </span>
        <span className="text-fg">
          {v.serviceName ?? "Service not recorded"}
          {v.serviceName && v.scheduledMinutes ? <small className="ml-1 text-xs text-fg-muted">· {v.scheduledMinutes} min</small> : null}
        </span>
        <span>
          <span className={cx(TAG, PILL_TONE[documentVisitTone(v.state)])}>{VISIT_STATE_LABEL[v.state]}</span>
          {methods.map((l, i) => <span key={i} className="block text-xs text-fg-muted">{(SHORT_METHOD_LABEL as Record<string, string | undefined>)[l.kind] ?? l.kind}</span>)}
        </span>
        <span className="text-right font-medium tabular-nums text-fg max-[780px]:text-[13px]">
          {collected === null ? <><span aria-hidden="true">—</span><span className="sr-only">No amount</span></> : splitCurrency(format(collected)).amount}
        </span>
        <span aria-hidden="true" className="inline-flex size-[26px] items-center justify-center rounded-lg border border-line-strong bg-white text-fg group-open:bg-surface-sunken">
          <span className="group-open:hidden">+</span>
          <span className="hidden group-open:inline">−</span>
        </span>
      </summary>
      <dl className="space-y-1 border-t border-line bg-surface-sunken px-[22px] py-3 text-sm text-fg">
        <div className="flex gap-2"><dt className="w-24 shrink-0 text-fg-muted">Duration</dt><dd>{v.scheduledMinutes ? `${v.scheduledMinutes} min` : "Duration not recorded"}</dd></div>
        <div className="flex gap-2"><dt className="w-24 shrink-0 text-fg-muted">Practitioner</dt><dd>{v.practitionerName ?? "Practitioner not recorded"}</dd></div>
        <div className="flex gap-2"><dt className="w-24 shrink-0 text-fg-muted">Fee</dt><dd>{visitFeeWithBasis(v, format)}</dd></div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-fg-muted">Payment</dt>
          <dd>{lines.length === 0 ? "No payment recorded" : lines.map((t, i) => <div key={i}>{t}</div>)}</dd>
        </div>
      </dl>
    </details>
  );
}

export function ClientStatementView({ document: doc, month, monthLabel, maxMonth, view, notice, offDocumentWithMoney, format, tabs, finder, studioName }: ClientStatementViewProps) {
  const balance = balanceText(doc.balanceDue, format);
  const off = offDocumentMoneyNotice(offDocumentWithMoney);
  const byId = new Map(doc.visits.map((v) => [v.appointmentId, v]));
  const awaitingLines = doc.awaiting.map((a) => byId.get(a.appointmentId)).filter((v): v is DocumentVisit => v !== undefined).map((v) => ({ id: v.appointmentId, text: awaitingVisitLine(v, format) }));
  const clientId = doc.client.id;
  const { name: clientName } = doc.client; // the document model's resolved display name, read once
  const methods = methodBreakdown(doc);
  // Latest first, as the approved design draws it. A DISPLAY order only: the document, its totals, the CSV and the print page keep their own order.
  const visits = [...doc.visits].sort(latestFirst);
  // Collected / Refunded / Net come from the ONE helper checkout and the visit page use (lib/billing/visit-money.ts).
  const money = statementMoneySummary(doc.totals, partialRefundedCents(doc), doc.awaiting.length, refundPendingCents(doc));
  const total = splitCurrency(format(money.collectedCents));
  const scope = scopeHeading(doc, monthLabel);
  const refundedOrWaived = doc.totals.refundedCents > 0 || doc.totals.waivedCents > 0;

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <p className="text-sm text-fg-muted">Business &nbsp;/&nbsp; Statements</p>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-[clamp(32px,4vw,46px)] font-bold leading-[1.07] tracking-[-2px] text-fg">Client statement</h1>
          {view === "month" ? <MonthControls base={`/financials/statements/${encodeURIComponent(clientId)}`} month={month} maxMonth={maxMonth} /> : null}
        </div>
        {tabs || finder ? (
          <div className="flex flex-wrap items-start gap-3">
            {tabs}
            {finder ? (
              <section aria-labelledby="stmt-find" className="min-w-0 flex-1 basis-60 md:max-w-sm">
                <h2 id="stmt-find" className="sr-only">Find a client</h2>
                {finder.state === "ok" ? <ClientFinder month={month} monthLabel={monthLabel} clients={finder.clients} monthVisits={null} showMonthCount={false} lastVisits={finder.lastVisits} /> : <p className="text-sm text-fg">{finder.state === "too_many" ? FINDER_TOO_MANY : STATEMENT_READ_UNAVAILABLE.read_failed}</p>}
              </section>
            ) : null}
          </div>
        ) : (
          <PendingLink href={clientsListHref(month)} className={cx("inline-flex items-center text-sm text-fg-muted underline decoration-line-strong underline-offset-4 hover:text-fg", CONTROL_MIN_TOUCH, FOCUS_RING)}>
            Back to Clients ({monthLabel})
          </PendingLink>
        )}
        <nav aria-label="Statement period" className={SEGMENT_GROUP}>
          {([["history", "Full history"], ["month", "One month"]] as const).map(([key, label]) => (
            <PendingLink key={key} href={clientStatementHref(clientId, month, key)} aria-current={key === view ? "page" : undefined} className={segmentClass(key === view)}>
              {label}
            </PendingLink>
          ))}
        </nav>
        {notice ? <p className="text-sm text-fg" role="status">{notice}</p> : null}
      </header>

      <section aria-labelledby="cs-summary" className={cx("grid items-center gap-[30px] rounded-[14px] px-[18px] py-[18px] min-[781px]:px-[30px] min-[781px]:py-[25px] max-[540px]:grid-cols-1", methods ? "sm:grid-cols-2" : "", SUMMARY_TONE)}>
        <h2 id="cs-summary" className="sr-only">Summary</h2>
        <div>
          <p className="font-semibold text-fg">{clientName}</p>
          <p className="text-fg-muted">{scope} · {MONEY_LABELS.collected}</p>
          {/* The figure is shown large for scanning; the verified sentence below carries the same number and is what a screen reader reads. */}
          <p aria-hidden="true" data-testid="statement-money-collected" className="mt-1 text-[clamp(34px,5vw,54px)] font-semibold leading-[1.15] tracking-[-2.8px] tabular-nums text-fg max-[540px]:text-[38px]">
            {total.amount}
            {total.unit ? <small className="ml-2 text-base font-normal tracking-normal text-fg-muted">{total.unit}</small> : null}
          </p>
          <p className="sr-only">{paidSummaryLine(doc, format)}</p>
          <dl className="mt-2 grid max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm text-fg" data-testid="statement-money">
            {moneyRows(money, { statement: true }).rows.filter((r) => r.key !== "collected").map((r) => (
              <div key={r.key} className="contents"><dt className={r.key === "net" ? "font-semibold" : undefined}>{r.label}</dt><dd className="text-right tabular-nums" data-testid={`statement-money-${r.key}`}>{splitCurrency(format(r.cents)).amount}</dd></div>
            ))}
          </dl>
          {moneyRows(money, { statement: true }).notFinalNote ? <p role="status" data-testid="statement-money-not-final" className="mt-1 max-w-xs text-sm text-fg-muted">{moneyRows(money, { statement: true }).notFinalNote}</p> : null}
          <p className="text-sm text-fg-muted">{visitCountPhrase(doc.totals.visitCount)}{studioName ? ` · ${studioName}` : ""}</p>
        </div>
        {methods ? (
          <div className="border-line sm:border-l sm:pl-[30px] max-[540px]:border-t max-[540px]:pt-3">
            <h3 className="text-base font-semibold text-fg">Collected by method</h3>
            <div className="my-3 flex h-[7px] overflow-hidden rounded-lg bg-line" aria-hidden="true">
              {methods.map((m, i) => <span key={m.kind} className="h-full bg-fg" style={{ width: `${(m.cents / doc.totals.paidCents) * 100}%`, opacity: 1 - i * 0.22 }} />)}
            </div>
            <ul className="space-y-1 text-fg">
              {methods.map((m) => (
                <li key={m.kind} className="flex justify-between gap-3"><span>{(SHORT_METHOD_LABEL as Record<string, string | undefined>)[m.kind] ?? m.label}</span><span className="tabular-nums">{splitCurrency(format(m.cents)).amount}</span></li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {awaitingLines.length > 0 || refundedOrWaived || off ? (
        <div className="space-y-2 text-sm text-fg">
          {awaitingLines.length > 0 ? <ul className="space-y-1">{awaitingLines.map((l) => <li key={l.id}>{l.text}</li>)}</ul> : null}
          {refundedOrWaived ? (
            <p className="text-fg-muted">
              {doc.totals.refundedCents > 0 ? `${format(doc.totals.refundedCents)} refunded` : ""}
              {doc.totals.refundedCents > 0 && doc.totals.waivedCents > 0 ? " · " : ""}
              {doc.totals.waivedCents > 0 ? `${format(doc.totals.waivedCents)} waived` : ""}. Net is Collected less Refunded; waivers are not part of either.
            </p>
          ) : null}
          {off ? <p role="status">{off}</p> : null}
        </div>
      ) : null}

      <details className="rounded-xl border border-line bg-white px-[22px] py-4 max-[540px]:px-3">
        <summary className={cx("cursor-pointer font-semibold text-fg", FOCUS_RING)}>Full payment breakdown</summary>
        <div className="mt-4 space-y-3 text-sm text-fg">
          {methods ? (
            <ul className="space-y-1">
              {methods.map((m) => <li key={m.kind} className="flex justify-between gap-3"><span>{m.label}</span><span className="tabular-nums">{format(m.cents)}</span></li>)}
            </ul>
          ) : null}
          <p>{balance.text}{balance.hint ? ` ${balance.hint}` : ""}</p>
          <p className="text-xs text-fg-muted">{TOTAL_PAID_DEFINITION}</p>
        </div>
      </details>

      <section aria-labelledby="cs-visits" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="cs-visits" className="text-[21px] font-semibold tracking-[-0.65px] text-fg">Client visits</h2>
            <p className="text-sm text-fg-muted">{scope} · Latest first</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Plain links: the CSV is a file download, the print page is a printable view. Neither writes, charges or messages anyone. */}
            <a href={statementExportHref(clientId, month, view)} className={ACTION}>Export CSV</a>
            <PendingLink href={statementPrintHref(clientId, month, view)} className={PRIMARY}>Print / Save as PDF</PendingLink>
          </div>
        </div>
        {doc.visits.length === 0 ? <p className="text-sm text-fg">No visits in this period.</p> : null}
        {doc.visits.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-line bg-white">
            <div className={cx(LINE_GRID, "bg-surface-sunken !text-xs font-semibold text-fg-muted")} aria-hidden="true">
              <span>Date</span><span>Visit</span><span>Payment</span><span className="text-right">Collected</span><span />
            </div>
            {visits.map((v) => <VisitRow key={v.appointmentId} v={v} view={view} format={format} />)}
          </div>
        ) : null}
      </section>

      {doc.feeItems.length > 0 ? (
        <section aria-labelledby="cs-fees" className="space-y-3">
          <h2 id="cs-fees" className="text-xl font-semibold tracking-tight text-fg">Fees and other payments</h2>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface text-sm text-fg">
            {doc.feeItems.map((f) => (
              <li key={f.appointmentId} className="px-4 py-3">
                {formatLocalDate(f.localDate)} · {FEE_REASON_COPY[f.reason]} · {visitFeeWithBasis(f, format)} · {FEE_ITEM_STATE_LABEL[f.state]}
                {moneyLineTexts(f, format).length > 0 ? ` · ${moneyLineTexts(f, format).join(" · ")}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view === "history" && doc.notCompleted.length > 0 ? (
        <section aria-labelledby="cs-nc" className="space-y-3">
          <h2 id="cs-nc" className="text-xl font-semibold tracking-tight text-fg">{NOT_COMPLETED_COPY}</h2>
          <p className="text-sm text-fg-muted">Past bookings that were never marked completed. They carry no charge and are not counted in any total.</p>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface text-sm text-fg">
            {doc.notCompleted.map((n) => (
              <li key={n.appointmentId} className="px-4 py-3">{formatLocalDate(n.localDate)}, {n.localTime} · {n.serviceName ?? "Service not recorded"} · {n.practitionerName ?? "Practitioner not recorded"}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

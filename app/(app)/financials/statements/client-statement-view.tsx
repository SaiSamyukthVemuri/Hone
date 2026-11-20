import { PendingLink } from "@/components/pending-link";
import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import { StatusPill, type StatusTone } from "@/components/ui/status-pill";
import {
  FEE_REASON_COPY,
  NOT_COMPLETED_COPY,
  TOTAL_PAID_DEFINITION,
  awaitingVisitLine,
  formatLocalDate,
  paidSummaryLine,
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
  visitFeeBasis,
  visitFeeText,
  visitFeeWithBasis,
  type ClientView,
} from "@/lib/finance/statement-screen";

import { methodBreakdown, SHORT_METHOD_LABEL } from "@/lib/finance/statement-methods";
import { formatClock12h, splitCurrency } from "@/lib/finance/statement-money";
import { latestFirst } from "@/lib/finance/statement-paging";

import type { ReactNode } from "react";

import { ClientFinder } from "./client-finder";
import type { ClientsViewProps } from "./clients-view";
import { MonthControls, SEGMENT_GROUP, SUMMARY_TONE, segmentClass } from "./statements-chrome";

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
};

// The tone is presentation only; the WORDS come from VISIT_STATE_LABEL, unchanged.
const STATE_TONE: Record<DocumentVisit["state"], StatusTone> = { paid: "success", unknown: "warning", confirmed_unpaid: "warning", adjusted: "neutral", no_charge: "neutral" };
const PILL = "!normal-case !tracking-normal !text-xs px-2.5 py-1"; // the shared pill is small capitals; the statement wants readable sentence case
const PRIMARY = cx("inline-flex items-center rounded-lg border border-[#1f3d2e] bg-[#1f3d2e] px-3 text-sm font-medium text-white hover:bg-[#2a5240]", CONTROL_MIN_TOUCH, FOCUS_RING);
const ACTION = cx("inline-flex items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-sunken", CONTROL_MIN_TOUCH, FOCUS_RING);

/** The expandable part of a visit: everything the row does not show, exactly as before. */
function VisitDetails({ v, format }: { v: DocumentVisit; format: (c: number) => string }) {
  const lines = moneyLineTexts(v, format);
  return (
    <details className="group">
      <summary className={cx("inline-flex cursor-pointer list-none items-center gap-1 text-sm text-fg underline decoration-line-strong underline-offset-4", CONTROL_MIN_TOUCH, FOCUS_RING)}>
        Details
      </summary>
      <dl className="mt-1 space-y-1 pb-2 text-sm text-fg">
        <div className="flex gap-2"><dt className="w-24 shrink-0 text-fg-muted">Duration</dt><dd>{v.scheduledMinutes ? `${v.scheduledMinutes} min` : "Duration not recorded"}</dd></div>
        <div className="flex gap-2"><dt className="w-24 shrink-0 text-fg-muted">Practitioner</dt><dd>{v.practitionerName ?? "Practitioner not recorded"}</dd></div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-fg-muted">Payment</dt>
          <dd>{lines.length === 0 ? "No payment recorded" : lines.map((t, i) => <div key={i}>{t}</div>)}</dd>
        </div>
      </dl>
    </details>
  );
}

export function ClientStatementView({ document: doc, month, monthLabel, maxMonth, view, notice, offDocumentWithMoney, format, tabs, finder }: ClientStatementViewProps) {
  const balance = balanceText(doc.balanceDue, format);
  const off = offDocumentMoneyNotice(offDocumentWithMoney);
  const byId = new Map(doc.visits.map((v) => [v.appointmentId, v]));
  const awaitingLines = doc.awaiting.map((a) => byId.get(a.appointmentId)).filter((v): v is DocumentVisit => v !== undefined).map((v) => ({ id: v.appointmentId, text: awaitingVisitLine(v, format) }));
  const clientId = doc.client.id;
  const { name: clientName } = doc.client; // the document model's resolved display name, read once
  const methods = methodBreakdown(doc);
  // Latest first, as the approved design draws it. A DISPLAY order only: the document, its totals, the CSV and the print page keep their own order.
  const visits = [...doc.visits].sort(latestFirst);
  const total = splitCurrency(format(doc.totals.paidCents));

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <p className="text-sm text-[#5d685f]">Business &nbsp;/&nbsp; Statements</p>
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
                {finder.state === "ok" ? <ClientFinder month={month} monthLabel={monthLabel} clients={finder.clients} monthVisits={null} lastVisits={finder.lastVisits} /> : <p className="text-sm text-fg">{finder.state === "too_many" ? FINDER_TOO_MANY : STATEMENT_READ_UNAVAILABLE.read_failed}</p>}
              </section>
            ) : null}
          </div>
        ) : (
          <PendingLink href={clientsListHref(month)} className={cx("inline-flex items-center text-sm text-fg-muted underline decoration-line-strong underline-offset-4 hover:text-fg", CONTROL_MIN_TOUCH, FOCUS_RING)}>
            Back to Clients ({monthLabel})
          </PendingLink>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <nav aria-label="Statement period" className={SEGMENT_GROUP}>
            {([["month", monthLabel], ["history", "Full history"]] as const).map(([key, label]) => (
              <PendingLink key={key} href={clientStatementHref(clientId, month, key)} aria-current={key === view ? "page" : undefined} className={segmentClass(key === view)}>
                {label}
              </PendingLink>
            ))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* Plain links: the CSV is a file download, the print page is a printable view. Neither writes, charges or messages anyone. */}
            <a href={statementExportHref(clientId, month, view)} className={ACTION}>Export CSV</a>
            <PendingLink href={statementPrintHref(clientId, month, view)} className={PRIMARY}>Print / Save as PDF</PendingLink>
          </div>
        </div>
        {notice ? <p className="text-sm text-fg" role="status">{notice}</p> : null}
      </header>

      <section aria-labelledby="cs-summary" className={cx("rounded-2xl p-5 md:p-6", SUMMARY_TONE)}>
        <h2 id="cs-summary" className="sr-only">Summary</h2>
        <div className={cx("grid gap-5", methods ? "md:grid-cols-2 md:gap-8" : "")}>
          <div className="space-y-2">
            <p className="text-sm text-fg-muted">{clientName} · {scopeHeading(doc, monthLabel)}</p>
            {/* The figure is shown large for scanning; the verified sentence below carries the same number and is what a screen reader reads. */}
            <p aria-hidden="true" className="text-[clamp(34px,5vw,54px)] font-semibold leading-[1.15] tracking-[-2.8px] tabular-nums text-fg">
              {total.amount}
              {total.unit ? <small className="ml-2 text-base font-normal tracking-normal text-[#5d685f]">{total.unit}</small> : null}
            </p>
            <p className="text-base font-medium text-fg">{paidSummaryLine(doc, format)}</p>
            <p className="text-sm text-fg-muted">{visitCountPhrase(doc.totals.visitCount)}</p>
          </div>
          {methods ? (
            <div className="space-y-2 md:border-l md:border-line md:pl-8">
              <p className="text-sm font-medium text-fg">How it was paid</p>
              <div className="flex h-[7px] overflow-hidden rounded-lg bg-[#d5dfd2]" aria-hidden="true">
                {methods.map((m, i) => <span key={m.kind} className="h-full bg-[#3f6b52]" style={{ width: `${(m.cents / doc.totals.paidCents) * 100}%`, opacity: 1 - i * 0.22 }} />)}
              </div>
              <ul className="space-y-1 text-sm text-fg">
                {methods.map((m) => (
                  <li key={m.kind} className="flex justify-between gap-3"><span>{(SHORT_METHOD_LABEL as Record<string, string | undefined>)[m.kind] ?? m.label}</span><span className="tabular-nums">{splitCurrency(format(m.cents)).amount}</span></li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="mt-4 space-y-2 border-t border-line pt-4">
          <p className="text-sm text-fg">{balance.text}{balance.hint ? ` ${balance.hint}` : ""}</p>
          {awaitingLines.length > 0 ? (
            <ul className="space-y-1 text-sm text-fg">
              {awaitingLines.map((l) => <li key={l.id}>{l.text}</li>)}
            </ul>
          ) : null}
          {doc.totals.refundedCents > 0 || doc.totals.waivedCents > 0 ? (
            <p className="text-sm text-fg-muted">
              {doc.totals.refundedCents > 0 ? `${format(doc.totals.refundedCents)} refunded` : ""}
              {doc.totals.refundedCents > 0 && doc.totals.waivedCents > 0 ? " · " : ""}
              {doc.totals.waivedCents > 0 ? `${format(doc.totals.waivedCents)} waived` : ""}. Refunds and waivers are not part of the total paid.
            </p>
          ) : null}
          <p className="text-xs text-fg-muted">{TOTAL_PAID_DEFINITION}</p>
          {off ? <p className="text-sm text-fg" role="status">{off}</p> : null}
        </div>
      </section>

      <section aria-labelledby="cs-visits" className="space-y-3">
        <h2 id="cs-visits" className="text-xl font-semibold tracking-tight text-fg">Visits</h2>
        {doc.visits.length === 0 ? <p className="text-sm text-fg">No visits in this period.</p> : null}
        {doc.visits.length > 0 ? (
          <>
            <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface md:block">
              <table className="w-full text-sm">
                <caption className="sr-only">Visits for {doc.client.name}</caption>
                <thead>
                  <tr className="bg-surface-sunken text-left text-xs font-semibold text-fg-muted">
                    <th scope="col" className="px-4 py-2.5">Date and time</th>
                    <th scope="col" className="px-3 py-2.5">Service</th>
                    <th scope="col" className="px-3 py-2.5">Payment status</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Amount</th>
                    <th scope="col" className="px-4 py-2.5">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {visits.map((v) => (
                    <tr key={v.appointmentId} className="border-t border-line align-top">
                      <td className="whitespace-nowrap px-4 py-3 text-fg">{`${formatLocalDate(v.localDate)}, ${formatClock12h(v.localTime)}`}</td>
                      <td className="px-3 py-3 text-fg">{v.serviceName ?? "Service not recorded"}</td>
                      <td className="px-3 py-3"><StatusPill tone={STATE_TONE[v.state]} className={PILL}>{VISIT_STATE_LABEL[v.state]}</StatusPill></td>
                      <td className="whitespace-nowrap px-3 py-3 text-right font-medium tabular-nums text-fg">{splitCurrency(visitFeeText(v, format)).amount}{visitFeeBasis(v) ? <div className="text-xs font-normal text-fg-muted">{visitFeeBasis(v)}</div> : null}</td>
                      <td className="px-4 py-1"><VisitDetails v={v} format={format} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface md:hidden">
              {visits.map((v) => (
                <li key={v.appointmentId} className="space-y-1 px-3 py-3 text-sm text-fg">
                  <div className="flex items-start justify-between gap-3">
                    <span>{`${formatLocalDate(v.localDate)}, ${formatClock12h(v.localTime)}`}</span>
                    <span className="font-medium tabular-nums">{visitFeeWithBasis(v, format)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-fg-muted">{v.serviceName ?? "Service not recorded"}</span>
                    <StatusPill tone={STATE_TONE[v.state]} className={PILL}>{VISIT_STATE_LABEL[v.state]}</StatusPill>
                  </div>
                  <VisitDetails v={v} format={format} />
                </li>
              ))}
            </ul>
          </>
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

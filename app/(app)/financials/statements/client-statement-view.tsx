import { PendingLink } from "@/components/pending-link";
import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import {
  FEE_REASON_COPY,
  NOT_COMPLETED_COPY,
  TOTAL_PAID_DEFINITION,
  awaitingVisitLine,
  formatLocalDate,
  paidSummaryLine,
  type DocumentVisit,
  type StatementDocument,
} from "@/lib/finance/statement-document";
import { offDocumentMoneyNotice } from "@/lib/finance/statement-directory";
import type { YearMonth } from "@/lib/finance/statement-period";
import {
  FEE_ITEM_STATE_LABEL,
  VISIT_STATE_LABEL,
  balanceText,
  clientStatementHref,
  clientsListHref,
  moneyLineTexts,
  visitFeeText,
  type ClientView,
} from "@/lib/finance/statement-screen";

import { MonthControls } from "./statements-chrome";

export type ClientStatementViewProps = {
  document: StatementDocument;
  month: YearMonth;
  monthLabel: string;
  maxMonth: YearMonth;
  view: ClientView;
  notice: string | null;
  offDocumentWithMoney: number;
  format: (cents: number) => string;
};

function VisitCells({ v, format }: { v: DocumentVisit; format: (c: number) => string }) {
  const lines = moneyLineTexts(v, format);
  return (
    <>
      <span>{formatLocalDate(v.localDate)}, {v.localTime}</span>
      <span>{v.serviceName ?? "Service not recorded"}</span>
      <span>{v.scheduledMinutes ? `${v.scheduledMinutes} min` : "Duration not recorded"}</span>
      <span>{v.practitionerName ?? "Practitioner not recorded"}</span>
      <span>{VISIT_STATE_LABEL[v.state]}</span>
      <span>{lines.length === 0 ? "No payment recorded" : lines.join(" · ")}</span>
      <span>{visitFeeText(v, format)}</span>
    </>
  );
}

export function ClientStatementView({ document: doc, month, monthLabel, maxMonth, view, notice, offDocumentWithMoney, format }: ClientStatementViewProps) {
  const balance = balanceText(doc.balanceDue, format);
  const off = offDocumentMoneyNotice(offDocumentWithMoney);
  const byId = new Map(doc.visits.map((v) => [v.appointmentId, v]));
  const awaitingLines = doc.awaiting.map((a) => byId.get(a.appointmentId)).filter((v): v is DocumentVisit => v !== undefined).map((v) => ({ id: v.appointmentId, text: awaitingVisitLine(v, format) }));
  const clientId = doc.client.id;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <PendingLink href={clientsListHref(month)} className={cx("inline-flex items-center text-sm underline", CONTROL_MIN_TOUCH, FOCUS_RING)}>
          Back to Clients ({monthLabel})
        </PendingLink>
        <h1 className="text-2xl font-semibold text-fg">{doc.client.name}</h1>
        <nav aria-label="Statement period" className="flex gap-1 border-b border-line">
          {([["month", monthLabel], ["history", "Full history"]] as const).map(([key, label]) => (
            <PendingLink
              key={key}
              href={clientStatementHref(clientId, month, key)}
              aria-current={key === view ? "page" : undefined}
              className={cx("px-4 text-sm", CONTROL_MIN_TOUCH, FOCUS_RING, key === view ? "border-b-2 border-fg font-medium text-fg" : "text-fg-muted underline")}
            >
              {label}
            </PendingLink>
          ))}
        </nav>
        {view === "month" ? <MonthControls base={`/financials/statements/${encodeURIComponent(clientId)}`} month={month} maxMonth={maxMonth} /> : null}
        {notice ? <p className="text-sm text-fg" role="status">{notice}</p> : null}
      </header>

      <section aria-labelledby="cs-summary" className="space-y-2">
        <h2 id="cs-summary" className="sr-only">Summary</h2>
        <p className="text-xl font-medium text-fg">{paidSummaryLine(doc, format)}</p>
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
      </section>

      <section aria-labelledby="cs-visits" className="space-y-3">
        <h2 id="cs-visits" className="text-lg font-medium text-fg">Visits</h2>
        {doc.visits.length === 0 ? <p className="text-sm text-fg">No visits in this period.</p> : null}
        {doc.visits.length > 0 ? (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <caption className="sr-only">Visits for {doc.client.name}</caption>
                <thead>
                  <tr className="text-left text-fg-muted">
                    {["Date and time", "Service", "Duration", "Practitioner", "Payment status", "Payment", "Fee"].map((h) => <th key={h} scope="col" className="py-2 pr-3 font-normal">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {doc.visits.map((v) => (
                    <tr key={v.appointmentId} className="border-t border-line align-top">
                      {[
                        `${formatLocalDate(v.localDate)}, ${v.localTime}`,
                        v.serviceName ?? "Service not recorded",
                        v.scheduledMinutes ? `${v.scheduledMinutes} min` : "Duration not recorded",
                        v.practitionerName ?? "Practitioner not recorded",
                        VISIT_STATE_LABEL[v.state],
                      ].map((c, i) => <td key={i} className="py-2 pr-3 text-fg">{c}</td>)}
                      <td className="py-2 pr-3 text-fg">{moneyLineTexts(v, format).length === 0 ? "No payment recorded" : moneyLineTexts(v, format).map((t, i) => <div key={i}>{t}</div>)}</td>
                      <td className="py-2 text-fg">{visitFeeText(v, format)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="space-y-3 md:hidden">
              {doc.visits.map((v) => (
                <li key={v.appointmentId} className="grid gap-1 rounded-lg border border-line p-3 text-sm text-fg">
                  <VisitCells v={v} format={format} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      {doc.feeItems.length > 0 ? (
        <section aria-labelledby="cs-fees" className="space-y-3">
          <h2 id="cs-fees" className="text-lg font-medium text-fg">Fees and other payments</h2>
          <ul className="space-y-2 text-sm text-fg">
            {doc.feeItems.map((f) => (
              <li key={f.appointmentId} className="rounded-lg border border-line p-3">
                {formatLocalDate(f.localDate)} · {FEE_REASON_COPY[f.reason]} · {visitFeeText(f, format)} · {FEE_ITEM_STATE_LABEL[f.state]}
                {moneyLineTexts(f, format).length > 0 ? ` · ${moneyLineTexts(f, format).join(" · ")}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view === "history" && doc.notCompleted.length > 0 ? (
        <section aria-labelledby="cs-nc" className="space-y-3">
          <h2 id="cs-nc" className="text-lg font-medium text-fg">{NOT_COMPLETED_COPY}</h2>
          <p className="text-sm text-fg-muted">Past bookings that were never marked completed. They carry no charge and are not counted in any total.</p>
          <ul className="space-y-1 text-sm text-fg">
            {doc.notCompleted.map((n) => (
              <li key={n.appointmentId}>{formatLocalDate(n.localDate)}, {n.localTime} · {n.serviceName ?? "Service not recorded"} · {n.practitionerName ?? "Practitioner not recorded"}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

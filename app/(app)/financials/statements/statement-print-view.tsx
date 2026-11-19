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
import { STATEMENT_NOT_AN_INVOICE, scopeLabel } from "@/lib/finance/statement-csv";
import { FEE_ITEM_STATE_LABEL, VISIT_STATE_LABEL, balanceText, moneyLineTexts, visitFeeText } from "@/lib/finance/statement-screen";

import { PrintButton } from "./print-button";

// The printable statement. The same document as the screen, in one plain table that prints cleanly. The app's header, navigation and footer are
// hidden by the print stylesheet below (it exists only while this page is mounted). A fixed label says what this is NOT, until issued invoices exist.
export const PRINT_CSS = `
@media print {
  /* the app shell's header, footer and navigation go; the statement's OWN header (marked) stays */
  header:not([data-statement-header]), footer, nav, [data-print-hide] { display: none !important; }
  main { padding: 0 !important; }
  tr, li { break-inside: avoid; }
  thead { display: table-header-group; }
  a { color: inherit; text-decoration: none; }
}`;

export type StatementPrintViewProps = { document: StatementDocument; offDocumentWithMoney: number; backHref: string; format: (cents: number) => string };

function visitRow(v: DocumentVisit, format: (c: number) => string) {
  const lines = moneyLineTexts(v, format);
  return [
    `${formatLocalDate(v.localDate)}, ${v.localTime}`,
    v.serviceName ?? "Service not recorded",
    v.scheduledMinutes ? `${v.scheduledMinutes} min` : "Duration not recorded",
    v.practitionerName ?? "Practitioner not recorded",
    VISIT_STATE_LABEL[v.state],
    lines.length === 0 ? "No payment recorded" : lines.join(" · "),
    visitFeeText(v, format),
  ];
}

export function StatementPrintView({ document: doc, offDocumentWithMoney, backHref, format }: StatementPrintViewProps) {
  const balance = balanceText(doc.balanceDue, format);
  const off = offDocumentMoneyNotice(offDocumentWithMoney);
  const byId = new Map(doc.visits.map((v) => [v.appointmentId, v]));
  const awaiting = doc.awaiting.map((a) => byId.get(a.appointmentId)).filter((v): v is DocumentVisit => v !== undefined);

  return (
    <div className="space-y-5 text-fg">
      <style>{PRINT_CSS}</style>
      <div data-print-hide className="flex items-center gap-4">
        <a href={backHref} className="text-sm underline">Back to the statement</a>
        <PrintButton />
      </div>
      <header data-statement-header className="space-y-1 border-b border-line pb-3">
        <p className="text-sm font-semibold uppercase tracking-wide">{STATEMENT_NOT_AN_INVOICE}</p>
        <h1 className="text-2xl font-semibold">{doc.client.name}</h1>
        <p className="text-sm">{doc.attribution}</p>
        <p className="text-sm text-fg-muted">{scopeLabel(doc.scope)} · Prepared {formatLocalDate(doc.preparedOn)}</p>
      </header>

      <section aria-label="Summary" className="space-y-2">
        <p className="text-xl font-medium">{paidSummaryLine(doc, format)}</p>
        <p className="text-sm">{balance.text}{balance.hint ? ` ${balance.hint}` : ""}</p>
        {awaiting.length > 0 ? <ul className="space-y-1 text-sm">{awaiting.map((v) => <li key={v.appointmentId}>{awaitingVisitLine(v, format)}</li>)}</ul> : null}
        <p className="text-xs text-fg-muted">{TOTAL_PAID_DEFINITION}</p>
        {off ? <p className="text-sm">{off}</p> : null}
      </section>

      <section aria-label="Visits" className="space-y-2">
        <h2 className="text-lg font-medium">Visits</h2>
        {doc.visits.length === 0 ? (
          <p className="text-sm">No visits in this period.</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Visits for {doc.client.name}</caption>
            <thead>
              <tr className="text-left text-fg-muted">{["Date and time", "Service", "Duration", "Practitioner", "Payment status", "Payment", "Fee"].map((h) => <th key={h} scope="col" className="py-1 pr-3 font-normal">{h}</th>)}</tr>
            </thead>
            <tbody>
              {doc.visits.map((v) => (
                <tr key={v.appointmentId} className="border-t border-line align-top">
                  {visitRow(v, format).map((c, i) => <td key={i} className="py-1 pr-3">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {doc.feeItems.length > 0 ? (
        <section aria-label="Fees and other payments" className="space-y-2">
          <h2 className="text-lg font-medium">Fees and other payments</h2>
          <ul className="space-y-1 text-sm">
            {doc.feeItems.map((f) => (
              <li key={f.appointmentId}>
                {formatLocalDate(f.localDate)} · {FEE_REASON_COPY[f.reason]} · {visitFeeText(f, format)} · {FEE_ITEM_STATE_LABEL[f.state]}
                {moneyLineTexts(f, format).length > 0 ? ` · ${moneyLineTexts(f, format).join(" · ")}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {doc.notCompleted.length > 0 ? (
        <section aria-label={NOT_COMPLETED_COPY} className="space-y-2">
          <h2 className="text-lg font-medium">{NOT_COMPLETED_COPY}</h2>
          <p className="text-sm text-fg-muted">Past bookings that were never marked completed. They carry no charge and are not counted in any total.</p>
          <ul className="space-y-1 text-sm">{doc.notCompleted.map((n) => <li key={n.appointmentId}>{formatLocalDate(n.localDate)}, {n.localTime} · {n.serviceName ?? "Service not recorded"} · {n.practitionerName ?? "Practitioner not recorded"}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

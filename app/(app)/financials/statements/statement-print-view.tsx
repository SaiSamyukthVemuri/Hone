import {
  FEE_REASON_COPY,
  NOT_COMPLETED_COPY,
  TOTAL_PAID_DEFINITION,
  awaitingVisitLine,
  formatLocalDate,
  paidSummaryLine,
  partialRefundedCents,
  type DocumentVisit,
  type StatementDocument,
} from "@/lib/finance/statement-document";
import { offDocumentMoneyNotice } from "@/lib/finance/statement-directory";
import { STATEMENT_NOT_AN_INVOICE, scopeLabel } from "@/lib/finance/statement-csv";
import { COLLECTED_KINDS, AMOUNT_KINDS } from "@/lib/finance/statement";
import { STATEMENT_METHOD_LABELS, STATEMENT_NO_TOTAL } from "@/lib/finance/statement-copy";
import { SHORT_METHOD_LABEL, visitCollectedCents } from "@/lib/finance/statement-methods";
import { formatClock12h, splitCurrency } from "@/lib/finance/statement-money";
import { latestFirst } from "@/lib/finance/statement-paging";
import { FEE_ITEM_STATE_LABEL, VISIT_STATE_LABEL, balanceText, moneyLineTexts, visitFeeWithBasis } from "@/lib/finance/statement-screen";

import { MONEY_LABELS, statementMoneySummary } from "@/lib/billing/visit-money";
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

export type StatementPrintViewProps = {
  document: StatementDocument;
  offDocumentWithMoney: number;
  backHref: string;
  format: (cents: number) => string;
  /** The studio's IANA timezone ("America/Toronto"); the paper says "Toronto time". Absent: the line leaves it out. */
  timezone?: string | null;
  /** The studio's payment currency ("cad"); the paper says "CAD" once in its header. Absent: the line leaves it out. */
  currency?: string | null;
  /** The month's label ("November 2026"), for the scope line of a one-month statement. Absent: the document's own scope label is used. */
  monthLabel?: string | null;
};

/** The paper's payment lines for one visit: "Card · Collected · $120.00" for collected money; every other line (a refund, a waiver, a still-owing note, an unresolved or unreadable one) keeps its full verified wording. */
function paymentLines(v: DocumentVisit, format: (c: number) => string): string[] {
  const out: string[] = [];
  for (const l of v.lines) {
    if (l.kind === "excluded") continue;
    const amount = AMOUNT_KINDS.includes(l.kind) && l.cents !== null ? splitCurrency(format(l.cents)).amount : null;
    if (COLLECTED_KINDS.includes(l.kind) && amount !== null) out.push(`${(SHORT_METHOD_LABEL as Record<string, string | undefined>)[l.kind] ?? STATEMENT_METHOD_LABELS[l.kind]} · Collected · ${amount}`);
    else out.push(`${STATEMENT_METHOD_LABELS[l.kind]}: ${amount ?? STATEMENT_NO_TOTAL}`);
  }
  return out;
}

function cityTime(tz: string | null | undefined): string | null {
  if (!tz) return null;
  const city = tz.split("/").pop()?.replace(/_/g, " ");
  return city ? `${city} time` : null;
}

export function StatementPrintView({ document: doc, offDocumentWithMoney, backHref, format, timezone, currency, monthLabel }: StatementPrintViewProps) {
  const balance = balanceText(doc.balanceDue, format);
  const off = offDocumentMoneyNotice(offDocumentWithMoney);
  const byId = new Map(doc.visits.map((v) => [v.appointmentId, v]));
  const awaiting = doc.awaiting.map((a) => byId.get(a.appointmentId)).filter((v): v is DocumentVisit => v !== undefined);
  // Latest first, as the approved paper. A DISPLAY order only: the document and the CSV keep their own order.
  const visits = [...doc.visits].sort(latestFirst);
  const meta = [`${doc.totals.visitCount} ${doc.totals.visitCount === 1 ? "visit" : "visits"}`, cityTime(timezone), currency ? currency.toUpperCase() : null].filter(Boolean).join(" · ");
  const scope = monthLabel && doc.scope.kind === "month" ? monthLabel : scopeLabel(doc.scope);
  const money = statementMoneySummary(doc.totals, partialRefundedCents(doc), doc.awaiting.length);
  const amt = (cents: number) => splitCurrency(format(cents)).amount; // the currency is stated once, in the header line

  return (
    <div className="space-y-5 text-fg">
      <style>{PRINT_CSS}</style>
      <div data-print-hide className="flex items-center gap-4">
        <a href={backHref} className="text-sm underline">Back to the statement</a>
        <PrintButton />
      </div>
      <header data-statement-header className="space-y-1 border-b border-line pb-3">
        <p className="text-sm font-semibold uppercase tracking-wide">{STATEMENT_NOT_AN_INVOICE}</p>
        <h1 className="text-2xl font-semibold">Client statement</h1>
        <h2 className="text-lg font-medium">{doc.client.name}</h2>
        <p className="text-sm">{scope}</p>
        <p className="text-sm text-fg-muted">{meta}</p>
        <p className="text-sm">{doc.attribution}</p>
        <p className="text-sm text-fg-muted">Prepared {formatLocalDate(doc.preparedOn)}</p>
      </header>

      <section aria-label="Summary" className="space-y-2">
        <p className="text-xl font-semibold">{`${MONEY_LABELS.collected} ${amt(money.collectedCents)}`}</p>
        <p className="text-sm">{`${MONEY_LABELS.refunded} ${amt(money.refundedCents)} · ${MONEY_LABELS.net} ${amt(money.netCents)}`}</p>
        <p className="text-sm">{paidSummaryLine(doc, format)}</p>
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
              <tr className="text-left font-semibold">
                <th scope="col" className="py-1 pr-3">Date &amp; time</th>
                <th scope="col" className="py-1 pr-3">Visit</th>
                <th scope="col" className="py-1 pr-3">Payment details</th>
                <th scope="col" className="py-1 text-right">Paid</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => {
                const collected = visitCollectedCents(v.lines);
                const lines = paymentLines(v, format);
                return (
                  <tr key={v.appointmentId} className="border-t border-line align-top">
                    <td className="py-1 pr-3"><span className="block">{formatLocalDate(v.localDate)}</span><span className="block text-fg-muted">{formatClock12h(v.localTime)}</span></td>
                    <td className="py-1 pr-3">
                      <span className="block">{v.serviceName ?? "Service not recorded"}{v.serviceName && v.scheduledMinutes ? ` · ${v.scheduledMinutes} min` : ""}</span>
                      <span className="block text-fg-muted">{v.practitionerName ?? "Practitioner not recorded"}</span>
                    </td>
                    <td className="py-1 pr-3">
                      {v.state !== "paid" ? <span className="block font-medium">{VISIT_STATE_LABEL[v.state]}</span> : null}
                      {lines.length === 0 ? <span className="block">No payment recorded</span> : lines.map((t, i) => <span key={i} className="block">{t}</span>)}
                    </td>
                    <td className="py-1 text-right tabular-nums">{collected === null ? "—" : splitCurrency(format(collected)).amount}</td>
                  </tr>
                );
              })}
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
                {formatLocalDate(f.localDate)} · {FEE_REASON_COPY[f.reason]} · {visitFeeWithBasis(f, format)} · {FEE_ITEM_STATE_LABEL[f.state]}
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

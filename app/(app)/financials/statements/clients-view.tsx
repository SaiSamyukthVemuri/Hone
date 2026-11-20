import { PendingLink } from "@/components/pending-link";
import { EmptyState } from "@/components/ui/empty-state";
import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import { DIRECTORY_MONTH_NOTE, offDocumentMoneyNotice, pageDirectory, type DirectoryResult } from "@/lib/finance/statement-directory";
import { splitCurrency } from "@/lib/finance/statement-money";
import type { YearMonth } from "@/lib/finance/statement-period";
import { FINDER_TOO_MANY, STATEMENT_READ_UNAVAILABLE, clientStatementHref, clientsListHref, CLIENTS_PAGE_SIZE } from "@/lib/finance/statement-screen";

import { ClientFinder, type FinderOption } from "./client-finder";
import { MonthControls, StatementsTabs } from "./statements-chrome";

export type ClientsViewProps = {
  month: YearMonth;
  monthLabel: string;
  maxMonth: YearMonth;
  timezone: string;
  notice: string | null;
  page: number;
  format: (cents: number) => string;
  directory: { ok: true; value: DirectoryResult } | { ok: false; reason: string };
  finder: { state: "ok"; clients: readonly FinderOption[]; lastVisits: Record<string, string | null> | null } | { state: "too_many" } | { state: "unavailable" };
};

/** "All confirmed" only when nothing is awaiting: no unconfirmed visit AND no unconfirmed fee item (a cancellation or no-show fee not yet confirmed). */
function rowStatusText(r: { awaitingCount: number; unconfirmedFeeCount: number }): string {
  const parts: string[] = [];
  if (r.awaitingCount > 0) parts.push(`${r.awaitingCount} ${r.awaitingCount === 1 ? "visit" : "visits"} awaiting payment confirmation`);
  if (r.unconfirmedFeeCount > 0) parts.push(`${r.unconfirmedFeeCount} ${r.unconfirmedFeeCount === 1 ? "fee" : "fees"} awaiting payment confirmation`);
  return parts.length > 0 ? parts.join(" · ") : "All confirmed";
}

export function ClientsView({ month, monthLabel, maxMonth, timezone, notice, page, format, directory, finder }: ClientsViewProps) {
  const paged = directory.ok ? pageDirectory(directory.value, page, CLIENTS_PAGE_SIZE) : null;
  // A failed monthly read must not look like "no visits": the finder then gets NO counts (null), not zeros.
  let monthVisits: Record<string, number> | null = null;
  if (directory.ok) {
    monthVisits = {};
    for (const r of directory.value.rows) monthVisits[r.clientId] = r.visitCount;
  }
  const offNotice = directory.ok ? offDocumentMoneyNotice(directory.value.reconciliation.offDocumentWithMoney) : null;

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <p className="text-sm text-[#5d685f]">Business &nbsp;/&nbsp; Statements</p>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-[clamp(32px,4vw,46px)] font-bold leading-[1.07] tracking-[-2px] text-fg">Clients this month</h1>
          <MonthControls base="/financials/statements" month={month} maxMonth={maxMonth} />
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <StatementsTabs active="clients" month={month} />
          <section aria-labelledby="stmt-find" className="min-w-0 flex-1 basis-60 md:max-w-sm">
            <h2 id="stmt-find" className="sr-only">Find a client</h2>
            {finder.state === "ok" ? (
              <ClientFinder month={month} monthLabel={monthLabel} clients={finder.clients} monthVisits={monthVisits} lastVisits={finder.lastVisits} />
            ) : (
              <p className="text-sm text-fg">{finder.state === "too_many" ? FINDER_TOO_MANY : STATEMENT_READ_UNAVAILABLE.read_failed}</p>
            )}
          </section>
        </div>
        {notice ? <p className="text-sm text-fg" role="status">{notice}</p> : null}
      </header>

      <section aria-labelledby="stmt-clients" className="space-y-3">
        <div>
          <h2 id="stmt-clients" className="text-[21px] font-semibold tracking-[-0.65px] text-fg">{monthLabel}</h2>
          {paged && paged.totals.clientCount > 0 ? <p className="text-sm text-fg-muted">{paged.totals.clientCount} {paged.totals.clientCount === 1 ? "client" : "clients"} with visits</p> : null}
        </div>
        {!directory.ok ? (
          <p className="text-sm text-fg" role="alert">{STATEMENT_READ_UNAVAILABLE[directory.reason] ?? STATEMENT_READ_UNAVAILABLE.read_failed}</p>
        ) : paged && paged.totals.clientCount === 0 ? (
          <EmptyState title={`No client visits in ${monthLabel}.`} description="A client appears here once they have a completed visit, a fee or a payment recorded in the month. Use Find a client to open anyone's full history." />
        ) : paged ? (
          <>
            <div className="overflow-x-auto rounded-xl border border-[#dbe0d8] bg-white">
              <table className="w-full text-sm">
                <caption className="sr-only">Clients with visits in {monthLabel}</caption>
                {/* The reference draws no column heads; they stay for screen readers. */}
                <thead className="sr-only">
                  <tr>
                    <th scope="col" className="px-[18px] py-3">Client</th>
                    <th scope="col" className="px-3 py-3">Visits</th>
                    <th scope="col" className="px-[18px] py-3 text-right">Total paid</th>
                    <th scope="col" className="px-[18px] py-3 text-right"><span className="sr-only">Document</span></th>
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map((r) => (
                    <tr key={r.clientId} className="border-t border-[#e6e8e3] hover:bg-[#f8faf6]">
                      <th scope="row" className="px-[18px] py-3 text-left font-normal">
                        <PendingLink href={clientStatementHref(r.clientId, month)} className={cx("inline-flex items-center font-semibold text-[#244e38] underline underline-offset-[3px]", CONTROL_MIN_TOUCH, FOCUS_RING)}>{r.name}</PendingLink>
                      </th>
                      <td className="px-3 py-3 tabular-nums text-fg">{r.visitCount} {r.visitCount === 1 ? "visit" : "visits"}</td>
                      <td className="px-[18px] py-3 text-right tabular-nums">
                        <span className="block font-medium text-fg">{splitCurrency(format(r.paidCents)).amount}</span>
                        <span className="block text-xs text-[#5d685f]">{rowStatusText(r)}</span>
                      </td>
                      <td className="px-[18px] py-3 text-right">
                        {/* The row's document action: opens that client's statement for the month, where Print / Save as PDF and Export CSV already work. */}
                        <PendingLink href={clientStatementHref(r.clientId, month)} aria-label={`Statement for ${r.name}`} className={cx("inline-flex items-center rounded-lg border border-[#d6dbd3] bg-white px-3 text-sm text-fg hover:bg-[#edf1eb]", CONTROL_MIN_TOUCH, FOCUS_RING)}>Statement</PendingLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {paged.pageCount > 1 ? (
              <nav className="flex items-center gap-4 text-sm" aria-label="Pages of clients">
                {paged.page > 1 ? <PendingLink href={clientsListHref(month, paged.page - 1)} className={cx("underline", CONTROL_MIN_TOUCH, FOCUS_RING)}>Previous page</PendingLink> : null}
                <span>Page {paged.page} of {paged.pageCount}</span>
                {paged.page < paged.pageCount ? <PendingLink href={clientsListHref(month, paged.page + 1)} className={cx("underline", CONTROL_MIN_TOUCH, FOCUS_RING)}>Next page</PendingLink> : null}
              </nav>
            ) : null}
            {/* The explanation and the month's totals, kept as a footnote under the list (the totals cover every client in the month, not only this page). */}
            <div className="space-y-1 text-sm text-fg-muted" aria-live="polite">
              <p>
                {paged.totals.clientCount} {paged.totals.clientCount === 1 ? "client" : "clients"} · {paged.totals.visitCount} {paged.totals.visitCount === 1 ? "visit" : "visits"} · {format(paged.totals.paidCents)} paid
                {paged.totals.awaitingCount > 0 ? ` · ${paged.totals.awaitingCount} ${paged.totals.awaitingCount === 1 ? "visit" : "visits"} awaiting payment confirmation` : ""}
              </p>
              <p>The counts and totals above cover every client in the month, not only this page.</p>
              <p>{DIRECTORY_MONTH_NOTE} Month and day boundaries use the studio&apos;s timezone ({timezone}).</p>
            </div>
          </>
        ) : null}
        {offNotice ? <p className="text-sm text-fg" role="status">{offNotice}</p> : null}
        {directory.ok && !directory.value.reconciliation.reconciled ? (
          <p className="text-sm text-fg" role="alert">These client totals do not match the studio statement for this month, so do not rely on them. The Studio tab shows the month&apos;s collected total.</p>
        ) : null}
      </section>
    </div>
  );
}

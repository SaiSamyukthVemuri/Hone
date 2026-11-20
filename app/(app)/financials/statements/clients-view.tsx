import { PendingLink } from "@/components/pending-link";
import { EmptyState } from "@/components/ui/empty-state";
import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import { DIRECTORY_MONTH_NOTE, offDocumentMoneyNotice, pageDirectory, type DirectoryResult } from "@/lib/finance/statement-directory";
import type { YearMonth } from "@/lib/finance/statement-period";
import { FINDER_TOO_MANY, STATEMENT_READ_UNAVAILABLE, clientStatementHref, clientsListHref, CLIENTS_PAGE_SIZE } from "@/lib/finance/statement-screen";

import { ClientFinder, type FinderOption } from "./client-finder";
import { MonthControls, StatementsTabs, SUMMARY_TONE } from "./statements-chrome";

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
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-3xl font-semibold tracking-tight text-fg">Statements</h1>
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
        <h2 id="stmt-clients" className="text-xl font-semibold tracking-tight text-fg">Clients with visits in {monthLabel}</h2>
        <p className="text-sm text-fg-muted">{DIRECTORY_MONTH_NOTE} Month and day boundaries use the studio&apos;s timezone ({timezone}).</p>
        {!directory.ok ? (
          <p className="text-sm text-fg" role="alert">{STATEMENT_READ_UNAVAILABLE[directory.reason] ?? STATEMENT_READ_UNAVAILABLE.read_failed}</p>
        ) : paged && paged.totals.clientCount === 0 ? (
          <EmptyState title={`No client visits in ${monthLabel}.`} description="A client appears here once they have a completed visit, a fee or a payment recorded in the month. Use Find a client to open anyone's full history." />
        ) : paged ? (
          <>
            <p className={cx("rounded-xl px-4 py-3 text-sm font-medium text-fg", SUMMARY_TONE)} aria-live="polite">
              {paged.totals.clientCount} {paged.totals.clientCount === 1 ? "client" : "clients"} · {paged.totals.visitCount} {paged.totals.visitCount === 1 ? "visit" : "visits"} · {format(paged.totals.paidCents)} paid
              {paged.totals.awaitingCount > 0 ? ` · ${paged.totals.awaitingCount} ${paged.totals.awaitingCount === 1 ? "visit" : "visits"} awaiting payment confirmation` : ""}
            </p>
            <div className="overflow-x-auto rounded-xl border border-line bg-surface">
              <table className="w-full text-sm">
                <caption className="sr-only">Clients with visits in {monthLabel}</caption>
                <thead>
                  <tr className="bg-surface-sunken text-left text-xs font-semibold text-fg-muted">
                    <th scope="col" className="px-4 py-2.5">Client</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Visits</th>
                    <th scope="col" className="px-3 py-2.5 text-right">Total paid</th>
                    <th scope="col" className="px-4 py-2.5">Payment status</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map((r) => (
                    <tr key={r.clientId} className="border-t border-line hover:bg-surface-sunken">
                      <th scope="row" className="px-4 py-1 text-left font-normal">
                        <PendingLink href={clientStatementHref(r.clientId, month)} className={cx("inline-flex items-center font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg", CONTROL_MIN_TOUCH, FOCUS_RING)}>{r.name}</PendingLink>
                      </th>
                      <td className="px-3 py-2 text-right tabular-nums">{r.visitCount}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{format(r.paidCents)}</td>
                      <td className="px-4 py-2 text-fg-muted">{rowStatusText(r)}</td>
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
            <p className="text-sm text-fg-muted">The counts and totals above cover every client in the month, not only this page.</p>
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

import { PendingLink } from "@/components/pending-link";
import { EmptyState } from "@/components/ui/empty-state";
import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import { DIRECTORY_MONTH_NOTE, offDocumentMoneyNotice, pageDirectory, type DirectoryResult, type FinderClient } from "@/lib/finance/statement-directory";
import type { YearMonth } from "@/lib/finance/statement-period";
import { FINDER_TOO_MANY, STATEMENT_READ_UNAVAILABLE, clientStatementHref, clientsListHref, CLIENTS_PAGE_SIZE } from "@/lib/finance/statement-screen";

import { ClientFinder } from "./client-finder";
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
  finder: { state: "ok"; clients: readonly FinderClient[]; lastVisits: Record<string, string | null> | null } | { state: "too_many" } | { state: "unavailable" };
};

export function ClientsView({ month, monthLabel, maxMonth, timezone, notice, page, format, directory, finder }: ClientsViewProps) {
  const paged = directory.ok ? pageDirectory(directory.value, page, CLIENTS_PAGE_SIZE) : null;
  const monthVisits: Record<string, number> = {};
  if (directory.ok) for (const r of directory.value.rows) monthVisits[r.clientId] = r.visitCount;
  const offNotice = directory.ok ? offDocumentMoneyNotice(directory.value.reconciliation.offDocumentWithMoney) : null;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold text-fg">Statements</h1>
        <StatementsTabs active="clients" month={month} />
        <MonthControls base="/financials/statements" month={month} maxMonth={maxMonth} />
        {notice ? <p className="text-sm text-fg" role="status">{notice}</p> : null}
      </header>

      <section aria-labelledby="stmt-find" className="space-y-2">
        <h2 id="stmt-find" className="sr-only">Find a client</h2>
        {finder.state === "ok" ? (
          <ClientFinder month={month} monthLabel={monthLabel} clients={finder.clients} monthVisits={monthVisits} lastVisits={finder.lastVisits} />
        ) : (
          <p className="text-sm text-fg">{finder.state === "too_many" ? FINDER_TOO_MANY : STATEMENT_READ_UNAVAILABLE.read_failed}</p>
        )}
      </section>

      <section aria-labelledby="stmt-clients" className="space-y-3">
        <h2 id="stmt-clients" className="text-lg font-medium text-fg">Clients with visits in {monthLabel}</h2>
        <p className="text-sm text-fg-muted">{DIRECTORY_MONTH_NOTE} Month and day boundaries use the studio&apos;s timezone ({timezone}).</p>
        {!directory.ok ? (
          <p className="text-sm text-fg" role="alert">{STATEMENT_READ_UNAVAILABLE[directory.reason] ?? STATEMENT_READ_UNAVAILABLE.read_failed}</p>
        ) : paged && paged.totals.clientCount === 0 ? (
          <EmptyState title={`No client visits in ${monthLabel}.`} description="A client appears here once they have a completed visit in the month. Use Find a client to open anyone's full history." />
        ) : paged ? (
          <>
            <p className="text-sm text-fg" aria-live="polite">
              {paged.totals.clientCount} {paged.totals.clientCount === 1 ? "client" : "clients"} · {paged.totals.visitCount} {paged.totals.visitCount === 1 ? "visit" : "visits"} · {format(paged.totals.paidCents)} paid
              {paged.totals.awaitingCount > 0 ? ` · ${paged.totals.awaitingCount} ${paged.totals.awaitingCount === 1 ? "visit" : "visits"} awaiting payment confirmation` : ""}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Clients with visits in {monthLabel}</caption>
                <thead>
                  <tr className="text-left text-fg-muted">
                    <th scope="col" className="py-2 pr-3 font-normal">Client</th>
                    <th scope="col" className="py-2 pr-3 text-right font-normal">Visits</th>
                    <th scope="col" className="py-2 pr-3 text-right font-normal">Total paid</th>
                    <th scope="col" className="py-2 font-normal">Payment status</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map((r) => (
                    <tr key={r.clientId} className="border-t border-line">
                      <th scope="row" className="py-1 pr-3 text-left font-normal">
                        <PendingLink href={clientStatementHref(r.clientId, month)} className={cx("inline-flex items-center underline", CONTROL_MIN_TOUCH, FOCUS_RING)}>{r.name}</PendingLink>
                      </th>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.visitCount}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{format(r.paidCents)}</td>
                      <td className="py-2 text-fg-muted">{r.awaitingCount > 0 ? `${r.awaitingCount} ${r.awaitingCount === 1 ? "visit" : "visits"} awaiting payment confirmation` : "All confirmed"}</td>
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

import type { ReactNode } from "react";

import { FOCUS_RING, cx } from "@/components/ui/control-base";
import {
  ANALYTICS_ACCESS_NOTE,
  BEYOND_USUAL_FILTER_NOTE,
  CLIENTS_NOT_LISTED,
  CLIENTS_POPULATION_NOTE,
  CLIENTS_PRINT_NOTE,
  CLIENTS_RECON_INTRO,
  CLIENTS_SORT_NOTE,
  FORMER_TEAM_MEMBER_LABEL,
  LIFETIME_NOTE,
  UNATTRIBUTED_LABEL,
  beyondUsualNote,
  clientsRowsLine,
} from "@/lib/business-analytics/copy";
import { clientsQuery, type ClientsParams } from "@/lib/business-analytics/clients-params";
import type { ClientChip, ClientSort, ClientsTableRow } from "@/lib/business-analytics/clients-table";
import { FIGURE_UNAVAILABLE_COPY, type Figure } from "@/lib/business-analytics/figure";
import { formatWhole } from "@/lib/business-analytics/money-format";
import type { OverviewView } from "@/lib/business-analytics/overview-model";
import { overviewQuery, type OverviewParams } from "@/lib/business-analytics/overview-params";
import { DEFAULT_BEYOND_USUAL_FACTOR } from "@/lib/business-analytics/visit-metrics";

import { BUTTON, CLIENTS_PATH, Controls, OVERVIEW_PATH, PageTitle, Tabs } from "./overview-screen";

// ===========================================================================
// Business → Analytics → Clients. PRESENTATION ONLY: every figure comes from the one view model.
// ===========================================================================
// The rows are the clients SEEN in the period, by display name. A row carries no client id, email, phone or note, and no link. Sort, chip and page are
// plain links whose address carries no personal data; there is deliberately no search (a name in an address reaches browser history and request logs).
// The table is left off the printed page, and the browser's own Print hides it with a line that says so.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shownDate(iso: string | null): string {
  const m = iso === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "Not available";
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const BIG = "text-3xl font-semibold tabular-nums tracking-tight text-fg";

export type ClientsScreenProps = {
  view: OverviewView;
  params: OverviewParams;
  clients: ClientsParams;
  notices: readonly string[];
  practitionerOptions: ReadonlyArray<{ id: string; label: string }>;
  format: (cents: number) => string;
};

function FigureCard<T>({ id, title, figure, children }: { id: string; title: string; figure: Figure<T>; children: (v: T) => ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2 rounded-xl border border-line bg-surface p-4" data-figure={id}>
      <h3 id={id} className="text-sm font-medium text-fg-muted">{title}</h3>
      {figure.available ? children(figure.value) : <p className="text-sm text-fg" role="status">{FIGURE_UNAVAILABLE_COPY[figure.reason]}</p>}
    </section>
  );
}

const CHIPS: ReadonlyArray<{ chip: ClientChip; label: string }> = [
  { chip: "all", label: "All clients" },
  { chip: "no_next_booking", label: "No next booking" },
  { chip: "beyond_usual", label: "Beyond usual interval" },
];

const COLUMNS: ReadonlyArray<{ key: string; label: string; sort?: ClientSort; align?: "right" }> = [
  { key: "name", label: "Client", sort: "name" },
  { key: "since", label: "First visit" },
  { key: "visits", label: "Visits", sort: "visits", align: "right" },
  { key: "paid", label: "Paid in period", sort: "spend", align: "right" },
  { key: "lifetime", label: "Lifetime paid", sort: "lifetime", align: "right" },
  { key: "gap", label: "Average gap", sort: "interval", align: "right" },
  { key: "last", label: "Last visit", sort: "last_visit" },
  { key: "followup", label: "Follow-up" },
];

function followUp(r: ClientsTableRow): string {
  const parts: string[] = [];
  if (r.hasNextBooking === false) parts.push("No next booking");
  if (r.beyondUsual === true) parts.push("Beyond usual interval");
  return parts.length ? parts.join(", ") : r.hasNextBooking === null ? "Not available" : "—";
}

export function ClientsScreen({ view, params, clients, notices, practitionerOptions, format }: ClientsScreenProps) {
  const base = overviewQuery(params);
  const showing =
    params.practitioner.kind === "all"
      ? "Everyone"
      : params.practitioner.kind === "unattributed"
        ? UNATTRIBUTED_LABEL
        : (practitionerOptions.find((o) => o.id === (params.practitioner as { practitionerId: string }).practitionerId)?.label ?? FORMER_TEAM_MEMBER_LABEL);
  const periodLine = `${view.currentLabel} compared with ${view.comparisonLabel}.`;
  const pageNotes = view.notes.filter((n) => n !== periodLine);
  const currencyWord = view.currency ? view.currency.toUpperCase() : null;
  const table: Figure<NonNullable<OverviewView["clientsTable"]> extends Figure<infer T> ? T : never> = view.clientsTable ?? { available: false, reason: "read_failed" };
  const href = (patch: Partial<ClientsParams>) => `${CLIENTS_PATH}${clientsQuery(base, clients, patch)}`;

  return (
    <div className="space-y-8">
      <header className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <PageTitle />
          <div className="flex flex-wrap gap-2">
            <a href={`${CLIENTS_PATH}/export.csv${base}`} className={BUTTON}>Export data</a>
          </div>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
          <Tabs current="Clients" query={base} />
          <Controls params={params} options={practitionerOptions} action={CLIENTS_PATH} hidden={[...(clients.sort !== "spend" ? [["sort", clients.sort] as const] : []), ...(clients.chip !== "all" ? [["chip", clients.chip] as const] : [])]} />
        </div>
        <div className="space-y-1">
          <p className="text-sm text-fg-muted">{periodLine}</p>
          <p className="text-sm font-medium text-fg" data-showing="">Showing: {showing}</p>
          <p className="text-sm text-fg-muted" data-population="">{CLIENTS_POPULATION_NOTE}</p>
        </div>
        {notices.length > 0 || pageNotes.length > 0 ? (
          <ul className="space-y-1 text-sm text-fg" role="status">
            {[...notices, ...pageNotes].map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </header>

      <section aria-label="Headline figures" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FigureCard id="cl-seen" title="Clients seen" figure={view.activeClients}>
          {(a) => <p className={BIG}>{a.count}</p>}
        </FigureCard>
        <FigureCard id="cl-visits" title="Completed visits" figure={view.completedVisits}>
          {(v) => <p className={BIG}>{v.count}</p>}
        </FigureCard>
        <FigureCard id="cl-collected" title="Collected (by visit date)" figure={view.collected}>
          {(c) => (
            <p className={BIG}>
              {formatWhole(c.headlineCents)}
              {currencyWord ? <span className="ml-1 text-sm font-medium text-fg-muted">{currencyWord}</span> : null}
            </p>
          )}
        </FigureCard>
        <FigureCard id="cl-beyond" title="Beyond their usual visit interval" figure={view.beyondUsual}>
          {(b) => <p className={BIG}>{b.count}</p>}
        </FigureCard>
      </section>

      <section aria-labelledby="cl-table-h" className="space-y-3" data-clients-table="">
        <h2 id="cl-table-h" className="text-xl font-semibold tracking-tight text-fg">Client insights</h2>
        <p className="hidden text-sm text-fg-muted print:block" data-print-only-note="">{CLIENTS_PRINT_NOTE}</p>
        <div className="space-y-3 print:hidden" data-print-hidden="">
          {table.available ? (
            <>
              <nav aria-label="Filter clients" className="flex flex-wrap gap-2">
                {CHIPS.map(({ chip, label }) => {
                  const n = chip === "all" ? table.value.chipCounts.all : chip === "no_next_booking" ? table.value.chipCounts.noNextBooking : table.value.chipCounts.beyondUsual;
                  return (
                    <a
                      key={chip}
                      href={href({ chip, page: 1 })}
                      aria-current={table.value.chip === chip ? "true" : undefined}
                      className={cx("inline-flex items-center rounded-full border border-line px-3 py-1 text-sm", FOCUS_RING, table.value.chip === chip ? "bg-surface-sunken font-semibold text-fg" : "bg-surface text-fg-muted")}
                    >
                      {label} ({n === null ? "not available" : n})
                    </a>
                  );
                })}
              </nav>
              <p className="text-xs text-fg-muted">{CLIENTS_SORT_NOTE}</p>
              {table.value.rows.length === 0 ? (
                <p className="rounded-xl border border-line bg-surface p-4 text-sm text-fg" role="status">{clientsRowsLine(0, 0, table.value.shown, table.value.listed)}</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-line bg-surface">
                  <table className="w-full min-w-[56rem] text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-fg-muted">
                        {COLUMNS.map((c) => (
                          <th key={c.key} scope="col" aria-sort={c.sort && c.sort === table.value.sort ? "descending" : undefined} className={cx("px-3 py-2 font-medium", c.align === "right" && "text-right")}>
                            {c.sort ? (
                              <a href={href({ sort: c.sort, page: 1 })} className={cx("underline-offset-2 hover:underline", FOCUS_RING, c.sort === table.value.sort && "font-semibold text-fg")}>{c.label}</a>
                            ) : (
                              c.label
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {table.value.rows.map((r) => (
                        <tr key={r.rowKey} className="border-b border-line last:border-0">
                          <th scope="row" className="px-3 py-2 text-left font-medium text-fg">{r.name}</th>
                          <td className="px-3 py-2 text-fg-muted">{shownDate(r.firstVisitDate)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.periodVisits}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.periodPaidCents === null ? "Not available" : format(r.periodPaidCents)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{!table.value.lifetime.available || r.lifetimePaidCents === null ? "Not available" : format(r.lifetimePaidCents)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.averageGapDays === null ? "Not available" : `${Math.round(r.averageGapDays)} days`}</td>
                          <td className="px-3 py-2 text-fg-muted">{shownDate(r.lastVisitDate)}</td>
                          <td className="px-3 py-2 text-fg-muted">{followUp(r)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted" data-clients-footnotes="">
                <p>{clientsRowsLine(table.value.rowsFrom, table.value.rowsTo, table.value.shown, table.value.listed)}</p>
                {table.value.pageCount > 1 ? (
                  <nav aria-label="Pages" className="flex gap-2">
                    {table.value.page > 1 ? <a href={href({ page: table.value.page - 1 })} rel="prev" className={cx(BUTTON, "px-3")}>Previous</a> : null}
                    <span className="self-center">Page {table.value.page} of {table.value.pageCount}</span>
                    {table.value.page < table.value.pageCount ? <a href={href({ page: table.value.page + 1 })} rel="next" className={cx(BUTTON, "px-3")}>Next</a> : null}
                  </nav>
                ) : null}
              </div>
              {table.value.notListed > 0 ? <p className="text-xs text-fg-muted">{CLIENTS_NOT_LISTED(table.value.notListed)}</p> : null}
              {!table.value.lifetime.available ? (
                <p className="text-xs text-fg" role="status" data-lifetime-unavailable="">Lifetime paid: {FIGURE_UNAVAILABLE_COPY[table.value.lifetime.reason]}</p>
              ) : (
                <p className="text-xs text-fg-muted">{LIFETIME_NOTE}</p>
              )}
              {!table.value.history.available ? (
                <p className="text-xs text-fg" role="status" data-history-unavailable="">First visit, average gap and beyond usual: {FIGURE_UNAVAILABLE_COPY[table.value.history.reason]}</p>
              ) : null}
              <p className="text-xs text-fg-muted">{beyondUsualNote(DEFAULT_BEYOND_USUAL_FACTOR)}{view.filterKind !== "all" ? ` ${BEYOND_USUAL_FILTER_NOTE}` : ""}</p>
              {table.value.seenWithoutConfirmedPayment > 0 ? (
                <p className="text-xs text-fg-muted">{plural(table.value.seenWithoutConfirmedPayment, "client seen has", "clients seen have")} no confirmed payment this period, so their paid figure is not available, not zero.</p>
              ) : null}
            </>
          ) : (
            <p className="rounded-xl border border-line bg-surface p-4 text-sm text-fg" role="status" data-figure="cl-table">{FIGURE_UNAVAILABLE_COPY[table.reason]}</p>
          )}
        </div>
      </section>

      <section aria-labelledby="cl-recon-h" className="space-y-2">
        <details className="rounded-xl border border-line bg-surface p-4" data-reconciliation="">
          <summary id="cl-recon-h" className="cursor-pointer text-sm font-medium text-fg">Paid in period: how the clients&rsquo; money adds up</summary>
          <div className="mt-3 space-y-2 text-sm">
            <p className="text-fg-muted">{CLIENTS_RECON_INTRO}</p>
            {view.clientsReconciliation && view.clientsReconciliation.available ? (
              <dl className="space-y-1" data-clients-reconciliation="">
                <ReconRow label="Paid in period across every client seen" value={format(view.clientsReconciliation.value.clientsPaidCents)} />
                <ReconRow label="Money on completed visits with no client recorded" value={format(view.clientsReconciliation.value.noClientPaidCents)} />
                <ReconRow label="Collected on completed visits (Overview)" value={format(view.clientsReconciliation.value.completedVisitsCents)} />
                <ReconRow label="Difference" value={format(view.clientsReconciliation.value.differenceCents)} strong />
              </dl>
            ) : (
              <p className="text-fg" role="status">{FIGURE_UNAVAILABLE_COPY[view.clientsReconciliation && !view.clientsReconciliation.available ? view.clientsReconciliation.reason : "read_failed"]}</p>
            )}
          </div>
        </details>
      </section>

      <footer className="flex flex-wrap items-start justify-between gap-2 border-t border-line pt-3 text-xs text-fg-muted">
        <span>{currencyWord ?? "Currency not set"} · {view.timezone}</span>
        <p className="max-w-3xl">{ANALYTICS_ACCESS_NOTE}</p>
      </footer>
      <p className="sr-only">
        <a href={`${OVERVIEW_PATH}${base}`}>Back to the Overview</a>
      </p>
    </div>
  );
}

function ReconRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cx("flex justify-between gap-4", strong && "border-t border-line pt-1 font-semibold")}>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="tabular-nums text-fg">{value}</dd>
    </div>
  );
}

import { type Figure, type ReadFailure } from "./figure";
import { usableName, type NameLookup } from "./named-clients";
import { compareClients, pageClients, type ClientRow, type RankBy, RANK_BYS } from "./visit-metrics";

// ===========================================================================
// The Clients tab's table. PURE: no I/O, no clock.
// ===========================================================================
//
// WHO IS A ROW. The clients SEEN in the period (a completed visit in it, team-member filter applied): the same population as the "Clients seen" card on the
// Overview. Not everyone with a history. A client who is archived, has no returned row or has no usable name is not a row and is never shown as "Unknown";
// they are counted in `seen`, in the money total and in every Overview figure.
//
// WHAT CHANGES WHAT. Sort, chip and page decide only the ORDER and which rows show. No figure on the page, and none of the totals, depends on them.
//
// WHAT LEAVES THIS MODULE. A display name, dates, figures and an opaque row key (the rank position). Never a client id, email, phone or note.

export const CLIENTS_PAGE_SIZE = 25;
export const MAX_CLIENTS_PAGE = 10_000;

export type ClientSort = RankBy;
export const CLIENT_SORTS: readonly ClientSort[] = RANK_BYS;
export const DEFAULT_CLIENT_SORT: ClientSort = "spend";

export type ClientChip = "all" | "no_next_booking" | "beyond_usual";
export const CLIENT_CHIPS: readonly ClientChip[] = ["all", "no_next_booking", "beyond_usual"];
export const DEFAULT_CLIENT_CHIP: ClientChip = "all";

/** What the model knows about one client seen in the period. Holds an id: it never reaches the view. */
export type ClientTableFigure = {
  clientId: string;
  periodVisits: number;
  /** Money kept on the client's completed visits in the period; null when none of their visits has a payment that can be established. */
  periodPaidCents: number | null;
  /** The client's money kept over every completed visit at the studio (any team member); null when it cannot be established or was not read. */
  lifetimePaidCents: number | null;
  averageGapDays: number | null;
  lastVisitDate: string | null;
  /** The date of the earliest completed visit recorded in Hone. */
  firstVisitDate: string | null;
  /** A confirmed booking still to come with anyone; null when the future bookings could not be read. */
  hasNextBooking: boolean | null;
  /** Past their usual visit interval (the Overview's rule); null when it could not be worked out. */
  beyondUsual: boolean | null;
};

export type ClientsTableRow = {
  rowKey: string;
  name: string;
  firstVisitDate: string | null;
  periodVisits: number;
  periodPaidCents: number | null;
  lifetimePaidCents: number | null;
  averageGapDays: number | null;
  lastVisitDate: string | null;
  hasNextBooking: boolean | null;
  beyondUsual: boolean | null;
};

export type ClientsTable = {
  sort: ClientSort;
  chip: ClientChip;
  /** Clients seen in the period, before anyone is left out. */
  seen: number;
  /** Seen clients who cannot be shown as a row (archived, no row read, no usable name). They are in every total. */
  notListed: number;
  /** Rows that can be shown at all (named clients), and how many of them each chip would show. Null when that chip's data could not be read. */
  listed: number;
  chipCounts: { all: number; noNextBooking: number | null; beyondUsual: number | null };
  /** Rows after the chip is applied; the page is cut from these. */
  shown: number;
  page: number;
  pageCount: number;
  /** 1-based position of the first and last row on this page; 0 and 0 when the page is empty. */
  rowsFrom: number;
  rowsTo: number;
  rows: ClientsTableRow[];
  /** Whether the Lifetime column could be worked out, and if not, why. Only that column is affected. */
  lifetime: { available: true } | { available: false; reason: ReadFailure };
  /** Money kept in the period across EVERY client seen (named or not), and how many of them have no confirmed payment. */
  paidAcrossSeenCents: number;
  seenWithoutConfirmedPayment: number;
};

export function rankClientsTable(args: {
  figures: readonly ClientTableFigure[];
  lookup: NameLookup;
  sort: ClientSort;
  chip: ClientChip;
  page: number;
  pageSize?: number;
  lifetimeFailure: ReadFailure | null;
}): Figure<ClientsTable> {
  if (!args.lookup.ok) return { available: false, reason: "read_failed" };
  const pageSize = args.pageSize ?? CLIENTS_PAGE_SIZE;
  const names = args.lookup.names;

  type Listed = ClientRow & { f: ClientTableFigure };
  const listed: Listed[] = [];
  for (const f of args.figures) {
    if (f.periodVisits < 1) continue;
    const name = usableName(names.get(f.clientId));
    if (name === null) continue;
    listed.push({ clientId: f.clientId, name, periodVisits: f.periodVisits, periodPaidCents: f.periodPaidCents, lifetimePaidCents: args.lifetimeFailure === null ? f.lifetimePaidCents : null, averageGapDays: f.averageGapDays, lastVisitDate: f.lastVisitDate, f });
  }
  const counted = args.figures.filter((f) => f.periodVisits >= 1);
  const flagKnown = (pick: (f: ClientTableFigure) => boolean | null) => listed.every((r) => pick(r.f) !== null);
  const nextKnown = flagKnown((f) => f.hasNextBooking);
  const beyondKnown = flagKnown((f) => f.beyondUsual);
  const chipCounts = {
    all: listed.length,
    noNextBooking: nextKnown ? listed.filter((r) => r.f.hasNextBooking === false).length : null,
    beyondUsual: beyondKnown ? listed.filter((r) => r.f.beyondUsual === true).length : null,
  };
  // A chip whose data could not be read cannot be applied: say so, never show an unfiltered table under it.
  if (args.chip === "no_next_booking" && !nextKnown) return { available: false, reason: "read_failed" };
  if (args.chip === "beyond_usual" && !beyondKnown) return { available: false, reason: "read_failed" };
  const afterChip = args.chip === "no_next_booking" ? listed.filter((r) => r.f.hasNextBooking === false) : args.chip === "beyond_usual" ? listed.filter((r) => r.f.beyondUsual === true) : listed;

  const paged = pageClients(afterChip, args.sort, args.page, pageSize);
  const byKey = new Map(afterChip.map((r) => [r.clientId, r.f]));
  const rows: ClientsTableRow[] = paged.rows.map((r, i) => {
    const f = byKey.get(r.clientId) as ClientTableFigure;
    return {
      rowKey: `row-${(paged.page - 1) * paged.pageSize + i + 1}`,
      name: r.name,
      firstVisitDate: f.firstVisitDate,
      periodVisits: f.periodVisits,
      periodPaidCents: f.periodPaidCents,
      lifetimePaidCents: r.lifetimePaidCents,
      averageGapDays: f.averageGapDays,
      lastVisitDate: f.lastVisitDate,
      hasNextBooking: f.hasNextBooking,
      beyondUsual: f.beyondUsual,
    };
  });

  return {
    available: true,
    value: {
      sort: args.sort,
      chip: args.chip,
      seen: counted.length,
      notListed: counted.length - listed.length,
      listed: listed.length,
      chipCounts,
      shown: afterChip.length,
      page: paged.page,
      pageCount: paged.pageCount,
      rowsFrom: rows.length === 0 ? 0 : (paged.page - 1) * paged.pageSize + 1,
      rowsTo: rows.length === 0 ? 0 : (paged.page - 1) * paged.pageSize + rows.length,
      rows,
      lifetime: args.lifetimeFailure === null ? { available: true } : { available: false, reason: args.lifetimeFailure },
      paidAcrossSeenCents: counted.reduce((n, f) => n + (f.periodPaidCents ?? 0), 0),
      seenWithoutConfirmedPayment: counted.filter((f) => f.periodPaidCents === null).length,
    },
  };
}

/** The Clients tab's money against the Overview's "collected on completed visits". The difference is shown, never hidden: positive when completed-visit money is more than the clients' money plus the money on visits with no client. */
export function reconcileClientsMoney(a: { clientsPaidCents: number; noClientPaidCents: number; completedVisitsCents: number }): { available: true; value: { clientsPaidCents: number; noClientPaidCents: number; completedVisitsCents: number; differenceCents: number } } {
  return { available: true, value: { ...a, differenceCents: a.completedVisitsCents - a.clientsPaidCents - a.noClientPaidCents } };
}

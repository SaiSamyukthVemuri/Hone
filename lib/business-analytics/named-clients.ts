import { type Figure, type ReadFailure } from "./figure";
import { compareClients, type ClientRow } from "./visit-metrics";

// ===========================================================================
// The named-client lists on the Overview. PURE: no I/O, no clock.
// ===========================================================================
//
// WHO IS LISTED. A client seen in the period (at least one completed visit in it, with the team-member filter applied, as for every other card) who has a
// usable display name. A client who is archived, whose row could not be read, or whose name is blank is NOT listed and is never shown as "Unknown": they
// stay counted in every total. (The schema has no erased or anonymised marker today; see the pull request. When one is added, a client carrying it must be
// left out of `names` by the read, which is the only place that can know.)
//
// WHAT LEAVES THIS MODULE. A display name, the figures and an opaque row key ("spend-1"). Never a client id: the ids stay inside the server, so the page
// cannot link to, or leak, one.
//
// NEVER ZERO FOR UNKNOWN. A client whose money cannot be established has no spend figure; they rank last in "top spenders" and say "not available".

/** How many clients each list shows. The sentence under the lists says it, so a cut-off is never silent. */
export const NAMED_LIST_SIZE = 5;

/** What the model knows about one client seen in the period, before names are attached. Holds an id: it never reaches the view. */
export type ClientFigure = {
  clientId: string;
  periodVisits: number;
  /** Money kept on the client's completed visits in the period; null when none of their visits has a payment that can be established. */
  periodPaidCents: number | null;
  /** Average days between the client's completed visits (any date up to the period's last day); null with fewer than two visit dates, or when history could not be read. */
  averageGapDays: number | null;
};

/** One row of a list: a display name and figures. No id, no link. */
export type NamedRow = { rowKey: string; name: string; periodVisits: number; periodPaidCents: number | null; averageGapDays: number | null };

export type NamedClients = {
  /** Clients seen in the period (the same count as the "Clients seen" card, before anyone is left out of a list). */
  seen: number;
  /** Seen clients who cannot be listed: archived, no row read, or no usable name. They are in every total. */
  notListed: number;
  /** Top spenders; unavailable when money could not be read for the period. */
  spenders: Figure<NamedRow[]>;
  mostVisits: NamedRow[];
  /** Shortest average gap between visits; unavailable when history could not be read. */
  frequentReturns: Figure<NamedRow[]>;
  /** Listable clients with fewer than two visit dates, who have no average gap and so are not eligible for "most frequent returns". */
  fewerThanTwoDates: number;
  /** The first row of the spenders list, shown again in "Period in review"; null when there is no spend to name. */
  highestSpend: NamedRow | null;
};

/** The display name, or null when there is nothing usable to show. */
export function usableName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
}

export type NameLookup = { ok: true; names: ReadonlyMap<string, string> } | { ok: false };

export function rankNamedClients(args: {
  figures: readonly ClientFigure[];
  seen: number;
  lookup: NameLookup;
  /** Why money is not available for the period, or null when it is. */
  moneyFailure: ReadFailure | null;
  /** Why history (visit gaps) is not available, or null when it is. */
  historyFailure: ReadFailure | null;
}): Figure<NamedClients> {
  if (!args.lookup.ok) return { available: false, reason: "read_failed" };
  const names = args.lookup.names;
  const listable: Array<ClientRow & { gap: number | null; paid: number | null }> = [];
  for (const f of args.figures) {
    if (f.periodVisits < 1) continue;
    const name = usableName(names.get(f.clientId));
    if (name === null) continue;
    listable.push({ clientId: f.clientId, name, periodVisits: f.periodVisits, periodPaidCents: f.periodPaidCents, lifetimePaidCents: null, averageGapDays: f.averageGapDays, lastVisitDate: null, gap: f.averageGapDays, paid: f.periodPaidCents });
  }
  const take = (rows: ClientRow[], prefix: string): NamedRow[] =>
    rows.slice(0, NAMED_LIST_SIZE).map((r, i) => ({ rowKey: `${prefix}-${i + 1}`, name: r.name, periodVisits: r.periodVisits, periodPaidCents: r.periodPaidCents, averageGapDays: r.averageGapDays }));

  const bySpend = take([...listable].sort(compareClients("spend")), "spend");
  const spenders: Figure<NamedRow[]> = args.moneyFailure !== null ? { available: false, reason: args.moneyFailure } : { available: true, value: bySpend };
  const mostVisits = take([...listable].sort(compareClients("visits")), "visits");
  const withGap = listable.filter((r) => r.gap !== null);
  const frequentReturns: Figure<NamedRow[]> = args.historyFailure !== null ? { available: false, reason: args.historyFailure } : { available: true, value: take(withGap.sort(compareClients("interval")), "returns") };
  const top = args.moneyFailure === null ? bySpend[0] : undefined;

  return {
    available: true,
    value: {
      seen: args.seen,
      notListed: Math.max(0, args.seen - listable.length),
      spenders,
      mostVisits,
      frequentReturns,
      fewerThanTwoDates: listable.length - withGap.length,
      // Only a client with money kept on their visits is "the highest spend": a list led by an unknown amount names no one.
      highestSpend: top && top.periodPaidCents !== null ? top : null,
    },
  };
}

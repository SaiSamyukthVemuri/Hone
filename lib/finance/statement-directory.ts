import { directoryMatchRank, matchesDirectoryQuery, normalizeDirectoryQuery } from "@/lib/clients/directory-search";
import { foldForSearch } from "@/lib/clients/name-search";
import { clientDisplayName } from "@/lib/clients/identity";

import { assembleClientInputs, statementCollectedCents, type AssembleInput } from "./statement-document-assemble";
import { buildStatementDocument } from "./statement-document";

// ===========================================================================
// The studio's CLIENTS tab and the Find-a-client search. PURE: no I/O, no clock, no Stripe, no mail.
// ===========================================================================
//
// One row per distinct client with something on the document in the selected month: an eligible visit (a completed treatment, INCLUDING a visit with
// no payment record) or a counted line (a cancellation or no-show fee, or a payment on an uncompleted booking). A client whose only activity is a
// paid fee is listed with zero visits, so that the clients' totals add up to the studio's.
//
// Every number comes from the SAME document model a client's own statement uses (month scope), so a row can never disagree with the statement it opens.
// Counts and totals are computed over the FULL month, then paged: `pageDirectory` slices the finished rows and reports the unchanged totals.
// Clients are identified by CLIENT ID everywhere; a name is only ever a label (two clients can share one).

export type DirectoryRow = {
  clientId: string;
  name: string;
  /** Eligible visits (completed treatments) in the month. */
  visitCount: number;
  /** Total spend in the month: confirmed collected money only (the document's definition). */
  paidCents: number;
  /** Visits whose payment status is unknown (shown as awaiting payment confirmation). */
  awaitingCount: number;
};

export type DirectoryTotals = { clientCount: number; visitCount: number; paidCents: number; awaitingCount: number };

export type DirectoryReconciliation = {
  /** Sum of EVERY client's total spend. */
  clientsSpendCents: number;
  /** The studio statement's collected total over the same appointments, computed independently of the per-client documents. */
  studioCollectedCents: number;
  /** Appointments left off the document that carry money (a future booking with a payment): the only legitimate difference. */
  offDocumentWithMoney: number;
  /** True when the clients' totals equal the studio total. */
  reconciled: boolean;
};

export type BuildDirectoryInput = Omit<AssembleInput, "appointments"> & {
  appointments: AssembleInput["appointments"];
  month: string; // "YYYY-MM", studio-local
  clientNames: ReadonlyMap<string, string>;
};

export type DirectoryResult = { rows: DirectoryRow[]; totals: DirectoryTotals; reconciliation: DirectoryReconciliation };

const FALLBACK_NAME = "Client";

export function buildDirectory(input: BuildDirectoryInput): { ok: true; value: DirectoryResult } | { ok: false; error: string } {
  const byClient = new Map<string, AssembleInput["appointments"][number][]>();
  for (const a of input.appointments) {
    const l = byClient.get(a.clientId);
    if (l) l.push(a);
    else byClient.set(a.clientId, [a]);
  }

  const rows: DirectoryRow[] = [];
  let clientsSpend = 0;
  let offDocument = 0;
  for (const [clientId, appts] of byClient) {
    const ids = new Set(appts.map((a) => a.id));
    const assembled = assembleClientInputs({
      ...input,
      appointments: appts,
      cardRows: input.cardRows.filter((c) => ids.has(c.appointmentId)),
      settlementRows: input.settlementRows.filter((s) => ids.has(s.appointmentId)),
      legacyFeeRows: input.legacyFeeRows.filter((l) => ids.has(l.appointmentId)),
    });
    offDocument += assembled.offDocumentWithMoney;
    const name = input.clientNames.get(clientId) ?? FALLBACK_NAME;
    const built = buildStatementDocument({
      studioId: "directory",
      identity: { studioName: "studio", legalEntityName: null, address: null, contactEmail: null },
      client: { id: clientId, name },
      scope: { kind: "month", month: input.month },
      currency: input.studioCurrency,
      preparedOn: `${input.month}-01`,
      visits: assembled.visits,
      feeItems: assembled.feeItems,
    });
    if (!built.ok) return { ok: false, error: built.error };
    const d = built.document;
    clientsSpend += d.totals.paidCents;
    if (d.totals.visitCount > 0 || d.feeItems.length > 0) {
      rows.push({ clientId, name, visitCount: d.totals.visitCount, paidCents: d.totals.paidCents, awaitingCount: d.awaiting.length });
    }
  }
  rows.sort((a, b) => foldForSearch(a.name).localeCompare(foldForSearch(b.name)) || a.clientId.localeCompare(b.clientId));

  // Independent reference: ONE statement over every appointment of the month, not built from the per-client documents.
  const whole = assembleClientInputs(input);
  const studioCollected = statementCollectedCents(whole.statement);
  const totals: DirectoryTotals = rows.reduce(
    (t, r) => ({ clientCount: t.clientCount + 1, visitCount: t.visitCount + r.visitCount, paidCents: t.paidCents + r.paidCents, awaitingCount: t.awaitingCount + r.awaitingCount }),
    { clientCount: 0, visitCount: 0, paidCents: 0, awaitingCount: 0 },
  );
  return {
    ok: true,
    value: {
      rows,
      totals,
      reconciliation: {
        clientsSpendCents: clientsSpend,
        studioCollectedCents: studioCollected,
        offDocumentWithMoney: offDocument,
        reconciled: clientsSpend === studioCollected,
      },
    },
  };
}

export const DIRECTORY_PAGE_SIZES = { min: 1, max: 100, default: 25 } as const;

/** One page of finished rows. The totals are those of the WHOLE month, never of the page. */
export function pageDirectory(result: DirectoryResult, page: number, pageSize: number = DIRECTORY_PAGE_SIZES.default) {
  const size = Number.isInteger(pageSize) ? Math.min(DIRECTORY_PAGE_SIZES.max, Math.max(DIRECTORY_PAGE_SIZES.min, pageSize)) : DIRECTORY_PAGE_SIZES.default;
  const pageCount = Math.max(1, Math.ceil(result.rows.length / size));
  const p = Number.isInteger(page) ? Math.min(pageCount, Math.max(1, page)) : 1;
  return { rows: result.rows.slice((p - 1) * size, p * size), page: p, pageCount, pageSize: size, totals: result.totals, reconciliation: result.reconciliation };
}

// ---------------------------------------------------------------------------
// Find a client
// ---------------------------------------------------------------------------
export type FinderClient = { id: string; name: string; preferredName: string | null; archived: boolean };
export type FinderResult = {
  clientId: string;
  displayName: string;
  archived: boolean;
  /** Eligible visits in the selected month; 0 for a client with none (still listed, with its Full history link). */
  monthVisitCount: number;
  /** Another result shares this display name: the screen must show something beyond the name; selection is by client id. */
  sameNameAsAnother: boolean;
};
export type FinderOutcome =
  | { state: "prompt"; results: [] } //        nothing typed yet
  | { state: "none"; results: [] } //          typed, nothing matched: the empty state, with a link to the directory
  | { state: "results"; results: FinderResult[]; truncated: boolean };

export const FINDER_LIMIT = 20;

/**
 * Matches the typed term against the clients' SHOWN names only (never email, phone or anything else: the same narrow rule as the clients directory).
 * Partial words match in any order. Every client of the studio is searched, whether or not they had a visit in the month.
 */
export function findClients(clients: readonly FinderClient[], rawQuery: string, monthVisitCounts: ReadonlyMap<string, number>): FinderOutcome {
  const query = normalizeDirectoryQuery(rawQuery);
  if (query.length === 0) return { state: "prompt", results: [] };
  const scored = clients
    .map((c) => ({ c, displayName: clientDisplayName({ name: c.name, preferred_name: c.preferredName }) }))
    .filter(({ displayName }) => matchesDirectoryQuery({ displayName, email: null, phone: null }, query))
    .map((x) => ({ ...x, rank: directoryMatchRank({ displayName: x.displayName, email: null, phone: null }, query) }))
    .sort((a, b) => a.rank - b.rank || foldForSearch(a.displayName).localeCompare(foldForSearch(b.displayName)) || a.c.id.localeCompare(b.c.id));
  if (scored.length === 0) return { state: "none", results: [] };
  const shown = scored.slice(0, FINDER_LIMIT);
  const nameCount = new Map<string, number>();
  for (const s of shown) nameCount.set(foldForSearch(s.displayName), (nameCount.get(foldForSearch(s.displayName)) ?? 0) + 1);
  return {
    state: "results",
    truncated: scored.length > shown.length,
    results: shown.map(({ c, displayName }) => ({
      clientId: c.id,
      displayName,
      archived: c.archived,
      monthVisitCount: monthVisitCounts.get(c.id) ?? 0,
      sameNameAsAnother: (nameCount.get(foldForSearch(displayName)) ?? 0) > 1,
    })),
  };
}

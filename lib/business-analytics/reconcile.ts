import { known, unknown, type Fact } from "@/lib/dashboard/owner-capacity-model";
import type { Statement } from "@/lib/finance/statement";

import type { CollectedSplit } from "./money-metrics";

// ===========================================================================
// Business → Analytics: RECONCILIATION WITH STATEMENTS. PURE.
// ===========================================================================
//
// The Overview's money may only be shown when it equals what Statements says for the same appointments. The pattern is the Statements
// directory's own (`DirectoryReconciliation`): the sum of every client's spend plus the deliberate gap equals the studio total, computed
// independently. A mismatch is a REAL error and the money section shows no figure; it is never smoothed over.

export type ReconcileReason = "overview_differs_from_statements" | "clients_and_other_differ_from_statements" | "split_differs_from_statements" | "unreadable_amount";

export type Reconciliation =
  | { reconciled: true; studioCollectedCents: number }
  | { reconciled: false; reason: ReconcileReason; differenceCents: number | null };

const isCents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);

/**
 * Check one window's Overview figures against the Statements studio statement over the SAME appointments.
 * Statements' own identity: Σ per-client document money + the document's off-document money (+ any money on an appointment with no client)
 * = the studio total, computed independently of the per-client documents.
 *  - `overviewCollectedCents`: the headline the Overview would show, for scope `all_money`.
 *  - `split`: the four-way split; it must add up to the studio total.
 *  - `clientsSpendCents`: the sum of every client's document `paidCents` (completed visits + fee items + past unfinished).
 *  - `offDocumentCollectedCents`: the document's off-document money, computed independently (`assembleClientInputs`).
 *  - `noClientCents`: money on appointments with no client, which no per-client document holds.
 */
export function reconcileWithStatement(args: {
  statement: Statement;
  overviewCollectedCents: number;
  split: CollectedSplit;
  clientsSpendCents: number;
  offDocumentCollectedCents: number;
  noClientCents?: number;
}): Reconciliation {
  const studio = args.statement.all.collectedCents;
  const noClient = args.noClientCents ?? 0;
  if (![studio, args.overviewCollectedCents, args.clientsSpendCents, args.offDocumentCollectedCents, noClient, args.split.totalCents].every(isCents)) {
    return { reconciled: false, reason: "unreadable_amount", differenceCents: null };
  }
  if (args.overviewCollectedCents !== studio) return { reconciled: false, reason: "overview_differs_from_statements", differenceCents: args.overviewCollectedCents - studio };
  if (args.split.totalCents !== studio) return { reconciled: false, reason: "split_differs_from_statements", differenceCents: args.split.totalCents - studio };
  if (args.split.otherBookingsCents !== args.offDocumentCollectedCents) {
    return { reconciled: false, reason: "split_differs_from_statements", differenceCents: args.split.otherBookingsCents - args.offDocumentCollectedCents };
  }
  const parts = args.clientsSpendCents + noClient + args.offDocumentCollectedCents;
  if (parts !== studio) return { reconciled: false, reason: "clients_and_other_differ_from_statements", differenceCents: parts - studio };
  return { reconciled: true, studioCollectedCents: studio };
}

/** The figure to show: the amount only when it reconciled, otherwise the reason. Never a number that failed its own check. */
export function figureIfReconciled(r: Reconciliation, cents: number): Fact<number> {
  return r.reconciled ? known(cents) : unknown("These figures do not match the Statements for the same visits, so no total is shown.");
}

/**
 * A window that spans several calendar months equals the SUM of its months, each of which is a Statements month. The caller passes each month's
 * Statements total and the window's own total; they must agree to the cent.
 */
export function reconcileMonthSum(args: { windowCollectedCents: number; monthCollectedCents: readonly number[] }): Reconciliation {
  if (!isCents(args.windowCollectedCents) || !args.monthCollectedCents.every(isCents)) return { reconciled: false, reason: "unreadable_amount", differenceCents: null };
  const sum = args.monthCollectedCents.reduce((n, c) => n + c, 0);
  return sum === args.windowCollectedCents
    ? { reconciled: true, studioCollectedCents: sum }
    : { reconciled: false, reason: "overview_differs_from_statements", differenceCents: args.windowCollectedCents - sum };
}

// One manual fee per appointment, across BOTH types (late cancellation and no-show).
//
// Rule (OPS recommendation for Sam, 12 Nov 2026; Sam may adjust): an appointment can have at most one
// manual fee. Any fee attempt of EITHER type that is ready, pending, unclear, needs-the-client's-action,
// or succeeded (a refunded fee counts: the fee was taken once) blocks a new one. Only a failed or a
// cancelled attempt frees the appointment. Unknown statuses are "unclear", which blocks (fail safe).
//
// Two places use this, so the rule cannot drift:
//   * PREPARE (eligibility): `feePrepareBlock` refuses to create a second attempt.
//   * EXECUTE (just before the claim): `feeExecuteBlock` re-checks, which closes the two-tab race
//     between types. Two attempts of different types can both be `ready` if two prepares raced; at
//     execute, a `ready` blocker only blocks the LATER attempt (created_at, then id), so exactly one of
//     the two can run, whatever order the clicks land in.
//
// This is an application-level guarantee. The database unique index is per (appointment, reason, mode),
// so it does not span the two types; a cross-type index would be a migration and is Sam's decision.
//
// Pure and framework-free.

import { feeAttemptState, type FeeAttemptStateKind } from "@/lib/billing/manual-fee-attempt-state";
import type { ManualFeeChargeType } from "@/lib/billing/manual-fee-types";

export const ONE_FEE_PER_APPOINTMENT_MESSAGE =
  "Only one manual fee can be taken per appointment, and this appointment already has one that is charged or still open.";
export const SAME_TYPE_ACTIVE_MESSAGE = "An active fee charge attempt already exists for this appointment.";

export type OneFeeAttempt = {
  id: string;
  charge_type: ManualFeeChargeType;
  status: string | null | undefined;
  created_at: string;
  failure_code?: string | null;
  stripe_payment_intent_id?: string | null;
  stripe_charge_id?: string | null;
  stripe_status?: string | null;
  charged_at?: string | null;
  updated_at?: string | null;
};

// 0338 index: any feature that revives, retries or re-opens a failed or cancelled
// fee row (flips it back to ready/pending_stripe/succeeded) can collide with a
// sibling attempt that took the slot in the meantime. That collision surfaces as
// Postgres 23505 on payment_charge_attempts_one_fee_per_appointment_uniq and must
// be handled deliberately (map to ONE_FEE_PER_APPOINTMENT_MESSAGE), never swallowed.
// Frees: cancelled before charging, or a failed/needs_action row whose STORED PROVIDER FACTS prove the
// PaymentIntent is canceled and uncaptured (feeAttemptState decides; the label alone never frees).
const FREES_THE_APPOINTMENT = new Set<FeeAttemptStateKind>(["failed", "cancelled", "needs_action"]);

export function attemptBlocksAnotherFee(a: OneFeeAttempt, now: Date): boolean {
  const s = feeAttemptState(
    {
      status: a.status,
      failure_code: a.failure_code ?? null,
      has_payment_intent: !!a.stripe_payment_intent_id,
      stripe_status: a.stripe_status ?? null,
      stripe_charge_id: a.stripe_charge_id ?? null,
      charged_at: a.charged_at ?? null,
      updated_at: a.updated_at ?? null,
    },
    now,
  );
  return !FREES_THE_APPOINTMENT.has(s.kind);
}

/** Prepare: refuse when ANY fee attempt of either type holds the appointment. */
export function feePrepareBlock(
  attempts: readonly OneFeeAttempt[],
  chargeType: ManualFeeChargeType,
  now: Date,
): string | null {
  const blockers = attempts.filter((a) => attemptBlocksAnotherFee(a, now));
  if (blockers.length === 0) return null;
  return blockers.some((a) => a.charge_type === chargeType) ? SAME_TYPE_ACTIVE_MESSAGE : ONE_FEE_PER_APPOINTMENT_MESSAGE;
}

function earlier(a: { created_at: string; id: string }, b: { created_at: string; id: string }): boolean {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at;
  return a.id < b.id;
}

/**
 * Execute: `self` is the attempt about to be claimed; `others` are every OTHER fee attempt for the same
 * appointment and mode. A blocker that is anything but `ready` means a fee is already charged or in
 * flight: refuse. A `ready` blocker only wins over `self` when it was created first.
 */
export function feeExecuteBlock(
  self: { id: string; created_at: string },
  others: readonly OneFeeAttempt[],
  now: Date,
): string | null {
  for (const o of others) {
    if (o.id === self.id) continue;
    if (!attemptBlocksAnotherFee(o, now)) continue;
    const isReady = o.status === "ready";
    if (!isReady) return ONE_FEE_PER_APPOINTMENT_MESSAGE;
    if (earlier(o, self)) return ONE_FEE_PER_APPOINTMENT_MESSAGE;
  }
  return null;
}

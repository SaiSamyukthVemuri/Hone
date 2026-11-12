// The cross-type "one manual fee per appointment" check, as it runs at the point of money.
//
// Called from the shared charge runner (runSessionPaymentCharge) IMMEDIATELY before the claim, so every
// caller of the runner (the fee action, any retry, any future path) is covered, and again by the fee
// action as the earlier, friendlier refusal. The decision itself is the pure `feeExecuteBlock`; this
// module only reads the OTHER fee attempts of the appointment (same studio, same mode, both reasons)
// and fails CLOSED: an unreadable history refuses, it never guesses "no other fee".
//
// Only a NEW charge is checked. Resuming an attempt that already holds a provider object (pending_stripe)
// goes through the claim's idempotent path with the same key and creates no new money, so it is not
// blocked by a rival (the rival could never have run while this one was blocking it).

import { feeExecuteBlock, type OneFeeAttempt } from "@/lib/billing/manual-fee-one-per-appointment";

export const ONE_FEE_UNREADABLE_MESSAGE =
  "We could not confirm this appointment has no other fee, so the charge was not run. Please try again.";

type Awaitable<T> = PromiseLike<T>;

export async function oneFeeExecuteVerdict(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: { from(table: string): any },
  attempt: { id: string; studio_id: string; appointment_id: string | null | undefined; created_at: string | null | undefined },
  livemode: boolean,
  now: Date,
): Promise<string | null> {
  if (!attempt.appointment_id || !attempt.created_at) return ONE_FEE_UNREADABLE_MESSAGE;
  const res: { data: Array<Record<string, unknown>> | null; error: unknown } = await (admin
    .from("payment_charge_attempts")
    .select("id, charge_reason, status, created_at, failure_code, stripe_payment_intent_id, charged_at, updated_at")
    .eq("studio_id", attempt.studio_id)
    .eq("appointment_id", attempt.appointment_id)
    .in("charge_reason", ["no_show_fee", "late_cancellation_fee"])
    .eq("stripe_livemode", livemode)
    .neq("id", attempt.id) as Awaitable<{ data: Array<Record<string, unknown>> | null; error: unknown }>);
  if (res.error || !res.data) return ONE_FEE_UNREADABLE_MESSAGE;
  const others: OneFeeAttempt[] = res.data.map((r) => ({
    id: r.id as string,
    charge_type: r.charge_reason === "no_show_fee" ? ("no_show" as const) : ("late_cancel" as const),
    status: r.status as string,
    created_at: r.created_at as string,
    failure_code: (r.failure_code as string | null) ?? null,
    stripe_payment_intent_id: (r.stripe_payment_intent_id as string | null) ?? null,
    charged_at: (r.charged_at as string | null) ?? null,
    updated_at: (r.updated_at as string | null) ?? null,
  }));
  return feeExecuteBlock({ id: attempt.id, created_at: attempt.created_at }, others, now);
}

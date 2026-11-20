import type { IssuedInvitation, ReplaceOutcome, SettleOutcome, SettleTarget } from "./over-invite-port";
import { SPACING_MS, reasonFor, type DeliveryState } from "./over-invite-worker";

// The owner's SEPARATELY CONFIRMED retry of deliveries that did not complete, through `replace`. This is the ONLY module that calls replace: the
// worker never does, and a source pin keeps it that way, because the database cannot tell a worker's replace from an owner's.
//
// Two kinds, each behind its own confirmation:
//  - "refused": the provider refused the email. Retrying is safe.
//  - "unknown": we cannot tell whether the email arrived. Retrying may send a SECOND email and the first link stops working.
//
// Before each item is replaced it is RE-CHECKED (still failed-refused, or still unknown) and then MARKED `retry_started`, so a second click, a
// second tab or a double submit finds it no longer retryable. The database closes the race: the mark names the state just seen (a mismatch answers
// `state_changed`), and `replace` names the invitation just re-checked, so only ONE caller can replace it. The mark is state-only, so the real
// guarantee is the rule below: NOTHING is delivered unless replace answered "replaced". An item left `retry_started` by a crash is never offered again.

export type RetryKind = "refused" | "unknown";
const ORIGINAL_REASON: Record<RetryKind, string> = { refused: "delivery_refused", unknown: "delivery_unknown" };

export type RetryDeps = {
  kind: RetryKind;
  /** Is this item still in the state this kind retries? Read just before the item is touched. */
  stillRetryable: (target: { itemId: string }) => Promise<{ state: string; invitationId: string | null } | null>;
  replace: (entryId: string, expectedInvitationId: string | null) => Promise<ReplaceOutcome>;
  deliver: (issued: IssuedInvitation, entryId: string) => Promise<DeliveryState>;
  settle: (target: SettleTarget, outcome: "sent" | "failed", reasonClass: string | null, expectedState?: string) => Promise<SettleOutcome>;
  sleep: (ms: number) => Promise<void>;
};

export type RetryOutcome =
  | { entryId: string; status: "sent" }
  | { entryId: string; status: "failed"; reason: "delivery_refused" | "delivery_unknown" | "settle_failed" }
  | { entryId: string; status: "skipped"; reason: string };

// Items being retried by THIS process right now: a cheap early exit for a double click or second tab. The database's expected-invitation check on
// replace is what excludes a second send across instances.
const inFlight = new Set<string>();

export async function retryDeliveries(deps: RetryDeps, targets: readonly { entryId: string; itemId: string; studioId: string }[]): Promise<RetryOutcome[]> {
  const out: RetryOutcome[] = [];
  let first = true;
  for (const t of targets) {
    if (!first) await deps.sleep(SPACING_MS);
    first = false;
    const target = { itemId: t.itemId, studioId: t.studioId, entryId: t.entryId };
    if (inFlight.has(t.itemId)) {
      out.push({ entryId: t.entryId, status: "skipped", reason: "no_longer_retryable" });
      continue;
    }
    inFlight.add(t.itemId);
    try {
      out.push(await retryOne(deps, target, t.entryId));
    } finally {
      inFlight.delete(t.itemId);
    }
  }
  return out;
}

async function retryOne(deps: RetryDeps, target: SettleTarget, entryId: string): Promise<RetryOutcome> {
  const skipped = (reason: string): RetryOutcome => ({ entryId, status: "skipped", reason });
  let seen: { state: string; invitationId: string | null } | null = null;
  try {
    seen = await deps.stillRetryable({ itemId: target.itemId });
  } catch {
    seen = null;
  }
  if (!seen) return skipped("no_longer_retryable");
  // The mark names the state just seen: if another instance moved the item on, the database answers state_changed and writes nothing, so exactly
  // one caller wins the item.
  const marked = await deps.settle(target, "failed", "retry_started", seen.state);
  if (!marked.ok || marked.result !== "settled") return skipped("no_longer_retryable");

  let rep: ReplaceOutcome;
  try {
    rep = await deps.replace(entryId, seen.invitationId);
  } catch {
    // Whether the command ran is unknown, so the item stays marked `retry_started` and is not offered again.
    return { entryId, status: "failed", reason: "delivery_unknown" };
  }
  if (!rep.ok || rep.result !== "replaced" || !("issued" in rep)) {
    // Another instance replaced this invitation first: it owns the item now, so leave it exactly as it is.
    if (rep.ok && rep.result === "state_changed") return skipped("no_longer_retryable");
    // Nothing new was issued: put the item back as it was (only if it is still the state this attempt set), so it can be offered again.
    await deps.settle(target, "failed", ORIGINAL_REASON[deps.kind], "failed");
    return skipped(rep.ok ? reasonFor(rep.result.replace(/:.*/, "")) : "replace_unavailable");
  }
  let state: DeliveryState;
  try {
    state = await deps.deliver(rep.issued, entryId);
  } catch {
    state = "unknown"; // a thrown delivery is UNKNOWN, never refused
  }
  if (state === "accepted") {
    const s = await deps.settle(target, "sent", null, "failed");
    return s.ok ? { entryId, status: "sent" } : { entryId, status: "failed", reason: "settle_failed" };
  }
  // A new invitation is out, so the item records how THIS attempt ended: refused stays retryable, anything else is recorded unknown and is only ever
  // offered through the unknown-retry action. (The database allows `unknown` only from issued, so it is `failed` with that reason.)
  const reason = state === "refused" ? "delivery_refused" : "delivery_unknown";
  const s = await deps.settle(target, "failed", reason, "failed");
  return { entryId, status: "failed", reason: s.ok ? reason : "settle_failed" };
}

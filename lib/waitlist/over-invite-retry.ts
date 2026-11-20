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
// second tab or a double submit finds it no longer retryable. The window between the check and the mark is not closed by the database (settle has no
// compare-and-swap), so this narrows a double send rather than excluding it. An item left `retry_started` by a crash is never offered again.

export type RetryKind = "refused" | "unknown";
const ORIGINAL_REASON: Record<RetryKind, string> = { refused: "delivery_refused", unknown: "delivery_unknown" };

export type RetryDeps = {
  kind: RetryKind;
  /** Is this item still in the state this kind retries? Read just before the item is touched. */
  stillRetryable: (target: { itemId: string }) => Promise<boolean>;
  replace: (entryId: string) => Promise<ReplaceOutcome>;
  deliver: (issued: IssuedInvitation, entryId: string) => Promise<DeliveryState>;
  settle: (target: SettleTarget, outcome: "sent" | "failed", reasonClass: string | null) => Promise<SettleOutcome>;
  sleep: (ms: number) => Promise<void>;
};

export type RetryOutcome =
  | { entryId: string; status: "sent" }
  | { entryId: string; status: "failed"; reason: "delivery_refused" | "delivery_unknown" | "settle_failed" }
  | { entryId: string; status: "skipped"; reason: string };

// Items being retried by THIS process right now. The database has no compare-and-swap on settle, so this closes the double click / second tab case
// within one server instance; across instances the re-check plus the `retry_started` mark only narrow it.
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
  let ok = false;
  try {
    ok = await deps.stillRetryable({ itemId: target.itemId });
  } catch {
    ok = false;
  }
  if (!ok) return skipped("no_longer_retryable");
  const marked = await deps.settle(target, "failed", "retry_started");
  if (!marked.ok || marked.result !== "settled") return skipped("no_longer_retryable");

  let rep: ReplaceOutcome;
  try {
    rep = await deps.replace(entryId);
  } catch {
    // Whether the command ran is unknown, so the item stays marked `retry_started` and is not offered again.
    return { entryId, status: "failed", reason: "delivery_unknown" };
  }
  if (!rep.ok || rep.result !== "replaced" || !("issued" in rep)) {
    // Nothing new was issued: put the item back exactly as it was, so it can be offered again.
    await deps.settle(target, "failed", ORIGINAL_REASON[deps.kind]);
    return skipped(rep.ok ? reasonFor(rep.result.replace(/:.*/, "")) : "replace_unavailable");
  }
  let state: DeliveryState;
  try {
    state = await deps.deliver(rep.issued, entryId);
  } catch {
    state = "unknown"; // a thrown delivery is UNKNOWN, never refused
  }
  if (state === "accepted") {
    const s = await deps.settle(target, "sent", null);
    return s.ok ? { entryId, status: "sent" } : { entryId, status: "failed", reason: "settle_failed" };
  }
  // A new invitation is out, so the item records how THIS attempt ended: refused stays retryable, anything else is recorded unknown and is only ever
  // offered through the unknown-retry action. (The database allows `unknown` only from issued, so it is `failed` with that reason.)
  const reason = state === "refused" ? "delivery_refused" : "delivery_unknown";
  const s = await deps.settle(target, "failed", reason);
  return { entryId, status: "failed", reason: s.ok ? reason : "settle_failed" };
}

import type { IssuedInvitation, ReplaceOutcome, SettleOutcome, SettleTarget } from "./over-invite-port";
import { SPACING_MS, reasonFor, type DeliveryState } from "./over-invite-worker";

// The owner's SEPARATELY CONFIRMED retry of refused deliveries, through `replace`. This is the ONLY module that calls replace: the worker
// (over-invite-worker.ts) never does, and a source pin keeps it that way, because the database cannot tell a worker's replace from an owner's.
// WARNING shown with the confirm: replacing an invitation whose email was delivered but never confirmed sends a SECOND email and cancels the first link.

export type RetryDeps = {
  replace: (entryId: string) => Promise<ReplaceOutcome>;
  deliver: (issued: IssuedInvitation, entryId: string) => Promise<DeliveryState>;
  settle: (target: SettleTarget, outcome: "sent" | "failed", reasonClass: string | null) => Promise<SettleOutcome>;
  sleep: (ms: number) => Promise<void>;
};

export type RetryOutcome =
  | { entryId: string; status: "sent" }
  | { entryId: string; status: "failed"; reason: "delivery_refused" | "delivery_unknown" | "settle_failed" }
  | { entryId: string; status: "skipped"; reason: string };

/**
 * Retry ONLY entries whose delivery was REFUSED, through replace (never admit again). An UNKNOWN-delivery item is not accepted here: it may have
 * reached the provider, and the owner must decide. The caller passes the item ids so a retry that succeeds can settle the item `sent`.
 */
export async function retryRefusedDeliveries(deps: RetryDeps, targets: readonly { entryId: string; itemId: string; studioId: string }[]): Promise<RetryOutcome[]> {
  const out: RetryOutcome[] = [];
  let first = true;
  for (const t of targets) {
    if (!first) await deps.sleep(SPACING_MS);
    first = false;
    let rep: ReplaceOutcome;
    try {
      rep = await deps.replace(t.entryId);
    } catch {
      out.push({ entryId: t.entryId, status: "failed", reason: "delivery_unknown" });
      continue;
    }
    if (!rep.ok) {
      out.push({ entryId: t.entryId, status: "skipped", reason: "replace_unavailable" });
      continue;
    }
    if (rep.result !== "replaced" || !("issued" in rep)) {
      out.push({ entryId: t.entryId, status: "skipped", reason: reasonFor(rep.result.replace(/:.*/, "")) });
      continue;
    }
    let state: DeliveryState;
    try {
      state = await deps.deliver(rep.issued, t.entryId);
    } catch {
      state = "unknown";
    }
    if (state === "accepted") {
      const s = await deps.settle({ itemId: t.itemId, studioId: t.studioId, entryId: t.entryId }, "sent", null);
      out.push(s.ok ? { entryId: t.entryId, status: "sent" } : { entryId: t.entryId, status: "failed", reason: "settle_failed" });
    } else {
      out.push({ entryId: t.entryId, status: "failed", reason: state === "refused" ? "delivery_refused" : "delivery_unknown" });
    }
  }
  return out;
}

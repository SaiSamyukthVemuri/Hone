import type { ClaimedItem, ClaimOutcome, AdmitOutcome, IssuedInvitation, ReplaceOutcome, SettleOutcome } from "./over-invite-port";

// The over-invite batch WORKER, as logic over injected ports (no database, no mail provider, no SMS: this module has no SMS dependency at all, so
// no waitlist text can be sent from here). It implements Machines' worker contract for one claimed chunk:
//
//   claim -> per item: admit (batch-aware) -> deliver the email -> settle
//
//  - A REFUSED admit leaves the item CLAIMED, so the worker MUST settle it `skipped` with a reason class, or the lease expires and the item is
//    claimed and retried forever. Every non-admitted result below settles.
//  - `no_capacity` on a batch item settles as skipped (the entry stays waiting). A confirmed batch is governed by its own confirmation, not the fit.
//  - The worker NEVER re-admits. A failed DELIVERY after a successful admit is retried through `replace` (same entry), which re-issues in one step;
//    an item whose delivery outcome is UNKNOWN is never auto-retried, because it may have reached the provider and a second send is a duplicate.
//  - One item in flight, spaced by the caller's sleep; chunk bounded by the claim's `total`. The database enforces none of those.
//  - Nothing here logs. The admit/replace results carry an email, a name and a raw token: they are passed to `deliver` and dropped.

export type DeliveryState = "accepted" | "refused" | "unknown";

export type WorkerDeps = {
  claim: (limits: { perStudio: number; total: number; leaseSeconds: number }) => Promise<ClaimOutcome>;
  admit: (item: ClaimedItem) => Promise<AdmitOutcome>;
  settle: (itemId: string, outcome: "sent" | "failed" | "skipped", reasonClass: string | null) => Promise<SettleOutcome>;
  /** Sends the one invitation email. `entryId` lets the deliverer re-read the stored address when the command did not return one. */
  deliver: (issued: IssuedInvitation, entryId: string, item: ClaimedItem) => Promise<DeliveryState>;
  /** Re-reads, immediately before the send, that the entry may still be mailed (waiting/invited, not removed, has an address). */
  mayStillSend: (entryId: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
};

export type ItemOutcome =
  | { entryId: string; itemId: string; status: "sent" }
  | { entryId: string; itemId: string; status: "skipped"; reason: string }
  | { entryId: string; itemId: string; status: "failed"; reason: "delivery_refused" | "delivery_unknown" | "settle_failed" };

export type ChunkResult = { ok: true; outcomes: ItemOutcome[]; claimed: number } | { ok: false; code: "claim_failed" };

export const DEFAULT_LIMITS = { perStudio: 25, total: 25, leaseSeconds: 120 } as const;
export const SPACING_MS = 500;

/** Reason classes are fixed codes ([a-z_]{1,40}); the command's own result code is used as-is when it fits, never free text. */
function reasonFor(result: string): string {
  return /^[a-z_]{1,40}$/.test(result) ? result : "refused";
}

export async function runBatchChunk(deps: WorkerDeps, limits: { perStudio: number; total: number; leaseSeconds: number } = DEFAULT_LIMITS): Promise<ChunkResult> {
  const claimed = await deps.claim(limits);
  if (!claimed.ok) return { ok: false, code: "claim_failed" };
  const outcomes: ItemOutcome[] = [];
  let first = true;
  for (const item of claimed.items) {
    if (!first) await deps.sleep(SPACING_MS);
    first = false;
    outcomes.push(await runOne(deps, item));
  }
  return { ok: true, outcomes, claimed: claimed.items.length };
}

async function runOne(deps: WorkerDeps, item: ClaimedItem): Promise<ItemOutcome> {
  const base = { entryId: item.entryId, itemId: item.itemId };
  const skip = async (reason: string): Promise<ItemOutcome> => {
    const s = await deps.settle(item.itemId, "skipped", reason);
    return s.ok ? { ...base, status: "skipped", reason } : { ...base, status: "failed", reason: "settle_failed" };
  };

  // Re-read just before the send: an entry removed or changed since the batch was confirmed is skipped, never mailed.
  let may = false;
  try {
    may = await deps.mayStillSend(item.entryId);
  } catch {
    may = false;
  }
  if (!may) return skip("entry_not_sendable");

  let admit: AdmitOutcome;
  try {
    admit = await deps.admit(item);
  } catch {
    // Unknown whether the command ran. The item stays claimed and is reclaimed after its lease; never settled blind.
    return { ...base, status: "failed", reason: "settle_failed" };
  }
  if (!admit.ok) return skip("admit_unavailable");
  if (admit.result !== "admitted" || !("issued" in admit)) return skip(reasonFor(admit.result));

  let state: DeliveryState;
  try {
    state = await deps.deliver(admit.issued, item.entryId, item);
  } catch {
    state = "unknown";
  }
  if (state === "accepted") {
    const s = await deps.settle(item.itemId, "sent", null);
    return s.ok ? { ...base, status: "sent" } : { ...base, status: "failed", reason: "settle_failed" };
  }
  const reason = state === "refused" ? "delivery_refused" : "delivery_unknown";
  const s = await deps.settle(item.itemId, "failed", reason);
  return s.ok ? { ...base, status: "failed", reason } : { ...base, status: "failed", reason: "settle_failed" };
}

// ---- retry ----------------------------------------------------------------------------------------------------------------------------------

export type RetryDeps = {
  replace: (entryId: string) => Promise<ReplaceOutcome>;
  deliver: (issued: IssuedInvitation, entryId: string) => Promise<DeliveryState>;
  settle: WorkerDeps["settle"];
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
export async function retryRefusedDeliveries(deps: RetryDeps, targets: readonly { entryId: string; itemId: string }[]): Promise<RetryOutcome[]> {
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
      const s = await deps.settle(t.itemId, "sent", null);
      out.push(s.ok ? { entryId: t.entryId, status: "sent" } : { entryId: t.entryId, status: "failed", reason: "settle_failed" });
    } else {
      out.push({ entryId: t.entryId, status: "failed", reason: state === "refused" ? "delivery_refused" : "delivery_unknown" });
    }
  }
  return out;
}

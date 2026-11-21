import type { ClaimMode, ClaimedItem, ClaimOutcome, AdmitOutcome, IssuedInvitation, SettleOutcome, SettleTarget } from "./over-invite-port";

// The over-invite batch WORKER, as logic over injected ports (no database, no mail provider, no SMS: this module has no SMS dependency at all, so
// no waitlist text can be sent from here). It follows the batch queue's worker contract for one claimed chunk:
//
//   claim -> per item: admit (batch-aware) -> deliver the email -> settle
//
//  - A REFUSED admit leaves the item CLAIMED, so the worker MUST settle it `skipped` with a reason class, or the lease expires and the item is
//    claimed and retried forever. Every non-admitted result below settles.
//  - `no_capacity` on a batch item settles as skipped (the entry stays waiting). A confirmed batch is governed by its own confirmation, not the fit.
//  - The worker NEVER re-admits and NEVER retries. A refused delivery settles `failed` and an unknown one settles `unknown`; both stay as they are.
//    An unknown outcome is never retried AUTOMATICALLY: it may have reached the provider, so a second send could be a duplicate. Only the owner's
//    separately confirmed action may retry it (over-invite-retry.ts, the only module that uses replace), behind a warning that a second email may go out.
//  - One item in flight, spaced by the caller's sleep; chunk bounded by the claim's `total`. The database enforces none of those.
//  - Nothing here logs. The admit/replace results carry an email, a name and a raw token: they are passed to `deliver` and dropped.

export type DeliveryState = "accepted" | "refused" | "unknown";

export type WorkerDeps = {
  claim: (limits: { perStudio: number; total: number; leaseSeconds: number }, mode: ClaimMode) => Promise<ClaimOutcome>;
  admit: (item: ClaimedItem) => Promise<AdmitOutcome>;
  settle: (target: SettleTarget, outcome: "sent" | "failed" | "unknown" | "skipped", reasonClass: string | null, expectedState?: string | null, expectedInvitationId?: string | null) => Promise<SettleOutcome>;
  /** Sends the one invitation email. `entryId` lets the deliverer re-read the stored address when the command did not return one. */
  deliver: (issued: IssuedInvitation, entryId: string, item: ClaimedItem) => Promise<DeliveryState>;
  /** Re-reads, immediately before the send, that the entry may still be mailed (waiting/invited, not removed, has an address). */
  mayStillSend: (item: ClaimedItem) => Promise<"sendable" | "not_sendable" | "read_failed">;
  sleep: (ms: number) => Promise<void>;
};

export type ItemOutcome =
  | { entryId: string; itemId: string; status: "sent" }
  | { entryId: string; itemId: string; status: "skipped"; reason: string }
  | { entryId: string; itemId: string; status: "failed"; reason: "delivery_refused" | "delivery_unknown" | "settle_failed" };

export type ChunkResult = { ok: true; outcomes: ItemOutcome[]; claimed: number } | { ok: false; code: "claim_failed" };

/**
 * LEASE > the time a whole claimed round can take. Items of a round wait their turn one at a time, so the last one is claimed for the sum of every
 * earlier item: chunk x (spacing + the slowest admit + send we allow). An item whose lease runs out before its turn would be reclaimed and could be
 * admitted twice by a second worker, so the arithmetic is pinned by a test.
 */
export const SPACING_MS = 500;
export const ITEM_BUDGET_MS = 8_000;
// A round is small ON PURPOSE: its worst case (total x (spacing + item budget) = 42.5 s) must fit inside the cron route's 60 s function cap, so a
// round is never cut off mid-way. A batch of any size is simply more rounds; the chunk is pagination, never a cap.
export const DEFAULT_LIMITS = { perStudio: 5, total: 5, leaseSeconds: 120 } as const;

/** Reason classes are fixed codes ([a-z_]{1,40}); the command's own result code is used as-is when it fits, never free text. */
export function reasonFor(result: string): string {
  return /^[a-z_]{1,40}$/.test(result) ? result : "refused";
}

/**
 * `mode` is one of exactly two shapes, and nothing else claims anything:
 *  - `scoped`: a batch AND its owner (the owner's confirm action). The database authorizes the owner through the batch's own studio before it
 *    leases anything, so only that batch is ever claimed.
 *  - `background`: the unscoped round-robin, used only by the background route behind its secret.
 * Any other shape returns nothing WITHOUT calling the claim. After a scoped claim every returned item is checked against the scope; if one is ever
 * foreign it is NOT processed and the whole chunk reports `claim_failed`, so that can never pass as a normal round.
 */
export async function runBatchChunk(
  deps: WorkerDeps,
  limits: { perStudio: number; total: number; leaseSeconds: number } = DEFAULT_LIMITS,
  mode?: ClaimMode,
): Promise<ChunkResult> {
  const m = mode as { mode?: unknown; batchId?: unknown; actorUserId?: unknown } | undefined;
  const validScoped = m?.mode === "scoped" && typeof m.batchId === "string" && m.batchId !== "" && typeof m.actorUserId === "string" && m.actorUserId !== "";
  if (!validScoped && m?.mode !== "background") return { ok: true, outcomes: [], claimed: 0 };
  const claimed = await claimRound(deps, limits, mode as ClaimMode);
  if (!claimed.ok) return { ok: false, code: "claim_failed" };
  if (validScoped) {
    const s = mode as Extract<ClaimMode, { mode: "scoped" }>;
    if (claimed.items.some((i) => i.batchId !== s.batchId || (s.studioId !== undefined && i.studioId !== s.studioId))) return { ok: false, code: "claim_failed" };
  }
  const outcomes: ItemOutcome[] = [];
  let first = true;
  for (const item of claimed.items) {
    if (!first) await deps.sleep(SPACING_MS);
    first = false;
    outcomes.push(await runOne(deps, item));
  }
  return { ok: true, outcomes, claimed: claimed.items.length };
}

/**
 * THE BACKGROUND ROUND IS FAIR ACROSS STUDIOS. The claim command walks studios oldest batch first and does not rotate between calls, so one claim of
 * `total` slots with `perStudio = total` hands every slot to the oldest studio, round after round, until its whole batch is done: every other studio
 * waits for it. So a background round claims ONE item per studio per pass (`perStudio` 1) and repeats the pass until the round's slots are full or a
 * pass finds nothing. Every studio with pending items that the round has room for therefore progresses in every round, and a single studio on its own
 * still fills the whole round (one item per pass, `total` passes) so its pace is unchanged. Only the BACKGROUND mode does this: the owner's own batch
 * (scoped) is one studio's by construction and is claimed in one call as before.
 * The command cannot reach beyond `total` studios in one round, because it has no rotation: more studios than slots still wait for an earlier
 * studio's items to finish. That is bounded by the round size, not by a whole batch.
 */
async function claimRound(deps: WorkerDeps, limits: { perStudio: number; total: number; leaseSeconds: number }, mode: ClaimMode): Promise<ClaimOutcome> {
  if (mode.mode !== "background") return deps.claim(limits, mode);
  const items: ClaimedItem[] = [];
  for (let pass = 0; pass < limits.total && items.length < limits.total; pass++) {
    const left = limits.total - items.length;
    const got = await deps.claim({ ...limits, perStudio: 1, total: left }, mode);
    // A failed pass keeps what earlier passes already leased: those items are processed, never dropped. A failure on the FIRST pass is the whole answer.
    if (!got.ok) return items.length > 0 ? { ok: true, items } : got;
    if (got.items.length === 0) break;
    items.push(...got.items);
  }
  return { ok: true, items };
}

async function runOne(deps: WorkerDeps, item: ClaimedItem): Promise<ItemOutcome> {
  const base = { entryId: item.entryId, itemId: item.itemId };
  const target = { itemId: item.itemId, studioId: item.studioId, entryId: item.entryId };
  const skip = async (reason: string): Promise<ItemOutcome> => {
    const s = await deps.settle(target, "skipped", reason);
    return s.ok ? { ...base, status: "skipped", reason } : { ...base, status: "failed", reason: "settle_failed" };
  };

  // Re-read just before the send: an entry removed or changed since the batch was confirmed is skipped, never mailed.
  // Only a DEFINITIVE "not sendable" settles the item skipped. A failed (or thrown) read says nothing about the entry: the item stays claimed,
  // nothing is settled, and it is reclaimed after its lease, exactly like a transient admit failure.
  let may: "sendable" | "not_sendable" | "read_failed";
  try {
    may = await deps.mayStillSend(item);
  } catch {
    may = "read_failed";
  }
  if (may === "read_failed") return { ...base, status: "failed", reason: "settle_failed" };
  if (may !== "sendable") return skip("entry_not_sendable");

  let admit: AdmitOutcome;
  try {
    admit = await deps.admit(item);
  } catch {
    // Unknown whether the command ran. The item stays claimed and is reclaimed after its lease; never settled blind.
    return { ...base, status: "failed", reason: "settle_failed" };
  }
  // A command that could not be reached or answered badly is TRANSIENT, exactly like a thrown error: nothing is known to have happened, so the item
  // stays claimed and is reclaimed after its lease. Only a definitive refusal from the command settles the item skipped.
  if (!admit.ok) return { ...base, status: "failed", reason: "settle_failed" };
  if (admit.result !== "admitted" || !("issued" in admit)) return skip(reasonFor(admit.result));

  let state: DeliveryState;
  try {
    state = await deps.deliver(admit.issued, item.entryId, item);
  } catch {
    state = "unknown";
  }
  if (state === "accepted") {
    const s = await deps.settle(target, "sent", null, null, admit.issued.invitationId);
    if (s.ok && s.result === "state_changed") return { ...base, status: "skipped", reason: "state_changed" }; // someone else already handled this item
    // Sent only when the database answered `settled`; any other answer is not a recorded send.
    return s.ok && s.result === "settled" ? { ...base, status: "sent" } : { ...base, status: "failed", reason: "settle_failed" };
  }
  // REFUSED is a known failure (only the owner's separately confirmed retry may touch it). UNKNOWN is its own state in the database: the delivery may
  // have reached the provider, so it is never retried automatically; only the owner's separately confirmed action may retry it.
  const reason = state === "refused" ? "delivery_refused" : "delivery_unknown";
  const s = await deps.settle(target, state === "refused" ? "failed" : "unknown", reason, null, admit.issued.invitationId);
  if (s.ok && s.result === "state_changed") return { ...base, status: "skipped", reason: "state_changed" };
  return s.ok && s.result === "settled" ? { ...base, status: "failed", reason } : { ...base, status: "failed", reason: "settle_failed" };
}

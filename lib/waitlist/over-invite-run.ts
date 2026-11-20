import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { admitBatchItem, claimItems, replaceInvitation, settleItem } from "@/lib/waitlist/over-invite-port";
import { deliverIssued, mayStillSend } from "@/lib/waitlist/over-invite-deliver";
import { RETRY_CLICK_MAX } from "@/lib/waitlist/over-invite-progress";
import { DEFAULT_LIMITS, ITEM_BUDGET_MS, SPACING_MS, runBatchChunk, type DeliveryState, type ItemOutcome, type WorkerDeps } from "@/lib/waitlist/over-invite-worker";
import { retryDeliveries, type RetryKind, type RetryOutcome } from "@/lib/waitlist/over-invite-retry";

// The ONLY two places that drive the over-invite worker: the confirm action's first round and the cron route. Both call `runRounds`. Pacing is
// this module's constant (SPACING_MS in the worker), not an environment read.

// Captured at load so the per-item budget uses the real timer.
const realSetTimeout = globalThis.setTimeout;
const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves with the delivery state, or "unknown" if the provider takes longer than the per-item budget (it may still arrive; never retried automatically). */
function withItemBudget(p: Promise<DeliveryState>): Promise<DeliveryState> {
  return new Promise((resolve) => {
    const timer = realSetTimeout(() => resolve("unknown"), ITEM_BUDGET_MS);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve("unknown"); },
    );
  });
}

/** A retry click handles at most one round's worth of items. Showing the number and acting on it use this same constant. */
export { RETRY_CLICK_MAX };

export function liveWorkerDeps(sleep: (ms: number) => Promise<void> = sleepFor): WorkerDeps {
  const db = createAdminClient();
  return {
    claim: (limits) => claimItems(db, limits),
    admit: (item) => admitBatchItem(db, item, null),
    settle: (target, outcome, reason) => settleItem(db, target, outcome, reason),
    // An email that takes longer than the per-item budget is reported UNKNOWN (it may still arrive), never retried automatically, and keeps the whole round inside
    // the lease: lease > chunk x (spacing + ITEM_BUDGET_MS), pinned by a test.
    deliver: (issued, entryId, item) => withItemBudget(deliverIssued(item.studioId, issued, entryId)),
    mayStillSend: (item) => mayStillSend(item.studioId, item.entryId),
    sleep,
  };
}

export type RoundsSummary = { rounds: number; claimed: number; sent: number; skipped: number; failed: number; budgetSpent: boolean };

/**
 * Process rounds until no item is claimable or the time budget is spent. Round-robin fairness across studios is the claim's (per-studio cap per
 * round). `scope` limits a call to one studio and batch (the owner's confirm action serves only the batch it just created); the cron passes none and
 * serves every studio and batch in turn.
 * An unspent budget with nothing claimed means the queue is empty. Returns counts only.
 */
export async function runRounds(opts: { budgetMs: number; scope?: { studioId?: string; batchId?: string }; deps?: WorkerDeps; now?: () => number }): Promise<RoundsSummary> {
  const deps = opts.deps ?? liveWorkerDeps();
  const now = opts.now ?? Date.now;
  const t0 = now();
  const outcomes: ItemOutcome[] = [];
  let rounds = 0;
  let claimed = 0;
  let budgetSpent = false;
  for (;;) {
    // The budget is checked before every ITEM's worth of work, not every round: a round claims only as many items as the remaining budget can
    // finish even if each takes its full item budget, so the call can never overrun its budget (and so never the platform's function cap).
    const room = Math.floor((opts.budgetMs - (now() - t0)) / (SPACING_MS + ITEM_BUDGET_MS));
    const take = Math.min(DEFAULT_LIMITS.total, room);
    if (take < 1 || now() - t0 >= opts.budgetMs) {
      budgetSpent = true;
      break;
    }
    const r = await runBatchChunk(deps, { ...DEFAULT_LIMITS, perStudio: take, total: take }, opts.scope);
    if (!r.ok) break;
    rounds += 1;
    // Stop only when the queue is EMPTY. A round that claimed nothing in scope but did claim others' items has moved those out of the way, so go on.
    if (r.claimedAll === 0) break;
    claimed += r.claimed;
    outcomes.push(...r.outcomes);
  }
  const count = (s: ItemOutcome["status"]) => outcomes.filter((o) => o.status === s).length;
  return { rounds, claimed, sent: count("sent"), skipped: count("skipped"), failed: count("failed"), budgetSpent };
}

/**
 * The owner's separately confirmed retry (replace, never admit). One click handles at most one round's worth, each delivery under the worker's per-item
 * budget (a hang records unknown). `reader` is the owner's own session client: it re-reads each item just before it is touched.
 */
export async function retryByKind(
  kind: RetryKind,
  studioId: string,
  actorUserId: string,
  targets: readonly { entryId: string; itemId: string }[],
  reader: { from: (table: string) => any },
): Promise<RetryOutcome[]> {
  const db = createAdminClient();
  return retryDeliveries(
    {
      kind,
      stillRetryable: async ({ itemId }) => {
        const { data } = await reader.from("waitlist_invitation_batch_items").select("state,reason_class,invitation_id").eq("studio_id", studioId).eq("id", itemId).maybeSingle();
        const row = data as { state?: string; reason_class?: string | null; invitation_id?: string | null } | null;
        if (!row || typeof row.state !== "string") return null;
        const ok =
          kind === "refused"
            ? row.state === "failed" && row.reason_class === "delivery_refused"
            : row.state === "unknown" || (row.state === "failed" && row.reason_class === "delivery_unknown");
        return ok ? { state: row.state, invitationId: typeof row.invitation_id === "string" ? row.invitation_id : null } : null;
      },
      replace: (entryId, expectedInvitationId) => replaceInvitation(db, { studioId, actorUserId, entryId, expectedInvitationId }),
      deliver: (issued, entryId) => withItemBudget(deliverIssued(studioId, issued, entryId)),
      settle: (target, outcome, reason, expected) => settleItem(db, target, outcome, reason, expected ?? null),
      sleep: sleepFor,
    },
    targets.slice(0, RETRY_CLICK_MAX).map((t) => ({ ...t, studioId })),
  );
}

export { SPACING_MS };

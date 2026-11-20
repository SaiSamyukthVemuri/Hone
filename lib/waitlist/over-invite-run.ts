import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { admitBatchItem, claimItems, replaceInvitation, settleItem } from "@/lib/waitlist/over-invite-port";
import { deliverIssued, mayStillSend } from "@/lib/waitlist/over-invite-deliver";
import { DEFAULT_LIMITS, ITEM_BUDGET_MS, SPACING_MS, runBatchChunk, type ItemOutcome, type WorkerDeps } from "@/lib/waitlist/over-invite-worker";
import { retryRefusedDeliveries, type RetryOutcome } from "@/lib/waitlist/over-invite-retry";

// The ONLY two places that drive the over-invite worker: the confirm action's first round and the cron route. Both call `runRounds`. Pacing is
// this module's constant (SPACING_MS in the worker), not an environment read.

// Captured at load so the per-item budget uses the real timer.
const realSetTimeout = globalThis.setTimeout;
const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function liveWorkerDeps(sleep: (ms: number) => Promise<void> = sleepFor): WorkerDeps {
  const db = createAdminClient();
  return {
    claim: (limits) => claimItems(db, limits),
    admit: (item) => admitBatchItem(db, item, null),
    settle: (target, outcome, reason) => settleItem(db, target, outcome, reason),
    // An email that takes longer than the per-item budget is reported UNKNOWN (it may still arrive), never retried, and keeps the whole round inside
    // the lease: lease > chunk x (spacing + ITEM_BUDGET_MS), pinned by a test.
    deliver: (issued, entryId, item) =>
      new Promise((resolve) => {
        const timer = realSetTimeout(() => resolve("unknown"), ITEM_BUDGET_MS);
        deliverIssued(item.studioId, issued, entryId).then(
          (v) => { clearTimeout(timer); resolve(v); },
          () => { clearTimeout(timer); resolve("unknown"); },
        );
      }),
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
    if (now() - t0 >= opts.budgetMs) {
      budgetSpent = true;
      break;
    }
    const r = await runBatchChunk(deps, DEFAULT_LIMITS, opts.scope);
    if (!r.ok) break;
    rounds += 1;
    if (r.claimed === 0) break;
    claimed += r.claimed;
    outcomes.push(...r.outcomes);
  }
  const count = (s: ItemOutcome["status"]) => outcomes.filter((o) => o.status === s).length;
  return { rounds, claimed, sent: count("sent"), skipped: count("skipped"), failed: count("failed"), budgetSpent };
}

/** The owner's separately confirmed retry: replace (never admit) for failed-REFUSED deliveries only. */
export async function retryRefused(studioId: string, actorUserId: string, targets: readonly { entryId: string; itemId: string }[]): Promise<RetryOutcome[]> {
  const db = createAdminClient();
  return retryRefusedDeliveries(
    {
      replace: (entryId) => replaceInvitation(db, { studioId, actorUserId, entryId }),
      deliver: (issued, entryId) => deliverIssued(studioId, issued, entryId),
      settle: (target, outcome, reason) => settleItem(db, target, outcome, reason),
      sleep: sleepFor,
    },
    targets.map((t) => ({ ...t, studioId })),
  );
}

export { SPACING_MS };

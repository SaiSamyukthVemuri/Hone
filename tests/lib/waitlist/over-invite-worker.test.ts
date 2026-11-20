import { describe, expect, it } from "vitest";
import { runBatchChunk, type WorkerDeps } from "@/lib/waitlist/over-invite-worker";
import { retryDeliveries } from "@/lib/waitlist/over-invite-retry";
import type { ClaimedItem, IssuedInvitation } from "@/lib/waitlist/over-invite-port";

const item = (n: number): ClaimedItem => ({
  itemId: `i${n}`, batchId: "b", studioId: "s", entryId: `e${n}`, actorUserId: "a", serviceId: "svc",
  startDate: "2026-12-01", endDate: "2026-12-07", allowedWeekdays: null, ttlHours: 48,
});
const issued: IssuedInvitation = { invitationId: "inv", rawToken: "TOKEN", issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: "x@example.test", deliveryName: "N" };

function deps(over: Partial<WorkerDeps> & { items?: ClaimedItem[] } = {}) {
  const calls: string[] = [];
  const seen: { itemId: string; studioId: string; entryId: string }[] = [];
  const d: WorkerDeps = {
    claim: async () => ({ ok: true, items: over.items ?? [item(1)] }),
    admit: async () => ({ ok: true, result: "admitted", issued }),
    settle: async (t, o, r) => (calls.push(`settle:${t.itemId}:${o}:${r}`), seen.push(t), { ok: true, result: "settled" }),
    deliver: async () => (calls.push("deliver"), "accepted"),
    mayStillSend: async () => true,
    sleep: async () => {},
    ...over,
  };
  return { d, calls, seen };
}

const BG = { mode: "background" } as const;
describe("over-invite worker", () => {
  it("admit -> deliver -> settle sent", async () => {
    const { d, calls } = deps();
    const r = await runBatchChunk(d, undefined, BG);
    expect(r.ok && r.outcomes[0].status).toBe("sent");
    expect(calls).toEqual(["deliver", "settle:i1:sent:null"]);
  });
  it("settle names the item's own studio and entry from the claimed row (ownership check)", async () => {
    const { d, seen } = deps();
    await runBatchChunk(d, undefined, BG);
    expect(seen).toEqual([{ itemId: "i1", studioId: "s", entryId: "e1" }]);
  });
  it("a refused admit (no_capacity) settles skipped so the lease cannot loop", async () => {
    const { d, calls } = deps({ admit: async () => ({ ok: true, result: "no_capacity" }) });
    const r = await runBatchChunk(d, undefined, BG);
    expect(calls).toEqual(["settle:i1:skipped:no_capacity"]);
    expect(r.ok && r.outcomes[0]).toMatchObject({ status: "skipped", reason: "no_capacity" });
  });
  it("a transient admit failure (unavailable, not applied, bad shape) leaves the item claimed and settles nothing, like a thrown error", async () => {
    for (const code of ["unavailable", "not_applied", "bad_shape"] as const) {
      const { d, calls } = deps({ admit: async () => ({ ok: false, code }) });
      const r = await runBatchChunk(d, undefined, BG);
      expect(calls).toEqual([]);
      expect(r.ok && r.outcomes[0].status).toBe("failed");
    }
  });
  it("only a definitive refusal from the command settles the item skipped", async () => {
    for (const result of ["no_capacity", "invalid_service", "pending_owner_review", "refused"]) {
      const { d, calls } = deps({ admit: async () => ({ ok: true, result }) });
      await runBatchChunk(d, undefined, BG);
      expect(calls).toEqual([`settle:i1:skipped:${result}`]);
    }
  });
  it("a command that cannot be reached leaves the item claimed (no blind settle)", async () => {
    const { d, calls } = deps({ admit: async () => { throw new Error("x"); } });
    const r = await runBatchChunk(d, undefined, BG);
    expect(calls).toEqual([]);
    expect(r.ok && r.outcomes[0].status).toBe("failed");
  });
  it("an entry no longer sendable is skipped and never admitted", async () => {
    let admitted = false;
    const { d, calls } = deps({ mayStillSend: async () => false, admit: async () => { admitted = true; return { ok: true, result: "admitted", issued }; } });
    await runBatchChunk(d, undefined, BG);
    expect(admitted).toBe(false);
    expect(calls).toEqual(["settle:i1:skipped:entry_not_sendable"]);
  });
  it("refused delivery settles failed; unknown settles failed with its own reason; neither resends here", async () => {
    for (const state of ["refused", "unknown"] as const) {
      const { d, calls } = deps({ deliver: async () => state });
      const r = await runBatchChunk(d, undefined, BG);
      expect(calls).toEqual([`settle:i1:${state === "refused" ? "failed" : "unknown"}:delivery_${state}`]);
      expect(r.ok && r.outcomes[0].status).toBe("failed");
    }
  });
  it("one failure never stops the rest, and spacing is applied between items only", async () => {
    const sleeps: number[] = [];
    const { d } = deps({
      items: [item(1), item(2), item(3)],
      admit: async (it) => (it.entryId === "e2" ? { ok: true, result: "not_admissible" } : { ok: true, result: "admitted", issued }),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const r = await runBatchChunk(d, undefined, BG);
    expect(r.ok && r.outcomes.map((o) => o.status)).toEqual(["sent", "skipped", "sent"]);
    expect(sleeps).toEqual([500, 500]);
  });
  it("a claim failure is reported, nothing is attempted", async () => {
    const { d } = deps({ claim: async () => ({ ok: false, code: "unavailable" }) });
    expect(await runBatchChunk(d, undefined, BG)).toEqual({ ok: false, code: "claim_failed" });
  });
  it("no outcome carries the token, email or name", async () => {
    const { d } = deps();
    const r = await runBatchChunk(d, undefined, BG);
    expect(JSON.stringify(r)).not.toMatch(/TOKEN|example\.test|"N"/);
  });
});

describe("retry through replace", () => {
  const t = [{ entryId: "e1", itemId: "i1", studioId: "s" }];
  it("replaces (never admits) and settles sent", async () => {
    const calls: string[] = [];
    const r = await retryDeliveries({
      kind: "refused",
      stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }),
      replace: async () => (calls.push("replace"), { ok: true, result: "replaced", issued }),
      deliver: async () => "accepted",
      settle: async (t, o) => (calls.push(`settle:${t.itemId}:${o}`), { ok: true, result: "settled" }),
      sleep: async () => {},
    }, t);
    expect(calls).toEqual(["settle:i1:failed", "replace", "settle:i1:sent"]);
    expect(r[0].status).toBe("sent");
  });
  it("an invitation already redeemed is skipped, not sent again", async () => {
    let delivered = false;
    const r = await retryDeliveries({
      kind: "refused",
      stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }),
      replace: async () => ({ ok: true, result: "invitation_redeemed" }),
      deliver: async () => { delivered = true; return "accepted"; },
      settle: async () => ({ ok: true, result: "settled" }),
      sleep: async () => {},
    }, t);
    expect(delivered).toBe(false);
    expect(r[0]).toMatchObject({ status: "skipped", reason: "invitation_redeemed" });
  });
});

import { replaceInvitation, admitBatchItem, type ClaimedItem as CI } from "@/lib/waitlist/over-invite-port";

describe("closed result sets (free text never flows onward)", () => {
  const rpcWith = (row: Record<string, unknown>) => ({ rpc: async () => ({ data: [row], error: null }) }) as never;
  it("replace answering 'refused:' plus text maps to the closed value 'refused', text dropped", async () => {
    const r = await replaceInvitation(rpcWith({ result: "refused:person@example.test is blocked" }), { studioId: "s", actorUserId: "a", entryId: "e", expectedInvitationId: null });
    expect(r).toEqual({ ok: true, result: "refused" });
  });
  it("an unknown admit code maps to 'refused'", async () => {
    const item = { itemId: "i", studioId: "s", entryId: "e", actorUserId: "a", serviceId: "v", startDate: "d", endDate: "d", allowedWeekdays: null, ttlHours: 1 } as CI;
    expect(await admitBatchItem(rpcWith({ result: "some_new_free_text" }), item, null)).toEqual({ ok: true, result: "refused" });
    expect(await admitBatchItem(rpcWith({ result: "no_capacity" }), item, null)).toEqual({ ok: true, result: "no_capacity" });
  });
});

import { DEFAULT_LIMITS, ITEM_BUDGET_MS, SPACING_MS } from "@/lib/waitlist/over-invite-worker";
describe("lease covers a whole round", () => {
  it("lease > chunk x (spacing + slowest admit+send) with at least 25% margin", () => {
    const worstRoundMs = DEFAULT_LIMITS.total * (SPACING_MS + ITEM_BUDGET_MS);
    expect(DEFAULT_LIMITS.leaseSeconds * 1000).toBeGreaterThan(worstRoundMs * 1.25);
  });
  it("a worst-case round fits inside the cron route's 60 s function cap, so a round is never cut off mid-way", () => {
    expect(DEFAULT_LIMITS.total * (SPACING_MS + ITEM_BUDGET_MS)).toBeLessThan(60_000);
  });
});

import { describe, expect, it } from "vitest";
import { runBatchChunk, retryRefusedDeliveries, type WorkerDeps } from "@/lib/waitlist/over-invite-worker";
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

describe("over-invite worker", () => {
  it("admit -> deliver -> settle sent", async () => {
    const { d, calls } = deps();
    const r = await runBatchChunk(d);
    expect(r.ok && r.outcomes[0].status).toBe("sent");
    expect(calls).toEqual(["deliver", "settle:i1:sent:null"]);
  });
  it("settle names the item's own studio and entry from the claimed row (0363 ownership check)", async () => {
    const { d, seen } = deps();
    await runBatchChunk(d);
    expect(seen).toEqual([{ itemId: "i1", studioId: "s", entryId: "e1" }]);
  });
  it("a refused admit (no_capacity) settles skipped so the lease cannot loop", async () => {
    const { d, calls } = deps({ admit: async () => ({ ok: true, result: "no_capacity" }) });
    const r = await runBatchChunk(d);
    expect(calls).toEqual(["settle:i1:skipped:no_capacity"]);
    expect(r.ok && r.outcomes[0]).toMatchObject({ status: "skipped", reason: "no_capacity" });
  });
  it("a command that cannot be reached leaves the item claimed (no blind settle)", async () => {
    const { d, calls } = deps({ admit: async () => { throw new Error("x"); } });
    const r = await runBatchChunk(d);
    expect(calls).toEqual([]);
    expect(r.ok && r.outcomes[0].status).toBe("failed");
  });
  it("an entry no longer sendable is skipped and never admitted", async () => {
    let admitted = false;
    const { d, calls } = deps({ mayStillSend: async () => false, admit: async () => { admitted = true; return { ok: true, result: "admitted", issued }; } });
    await runBatchChunk(d);
    expect(admitted).toBe(false);
    expect(calls).toEqual(["settle:i1:skipped:entry_not_sendable"]);
  });
  it("refused delivery settles failed; unknown settles failed with its own reason; neither resends here", async () => {
    for (const state of ["refused", "unknown"] as const) {
      const { d, calls } = deps({ deliver: async () => state });
      const r = await runBatchChunk(d);
      expect(calls).toEqual([`settle:i1:failed:delivery_${state}`]);
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
    const r = await runBatchChunk(d);
    expect(r.ok && r.outcomes.map((o) => o.status)).toEqual(["sent", "skipped", "sent"]);
    expect(sleeps).toEqual([500, 500]);
  });
  it("a claim failure is reported, nothing is attempted", async () => {
    const { d } = deps({ claim: async () => ({ ok: false, code: "unavailable" }) });
    expect(await runBatchChunk(d)).toEqual({ ok: false, code: "claim_failed" });
  });
  it("no outcome carries the token, email or name", async () => {
    const { d } = deps();
    const r = await runBatchChunk(d);
    expect(JSON.stringify(r)).not.toMatch(/TOKEN|example\.test|"N"/);
  });
});

describe("retry through replace", () => {
  const t = [{ entryId: "e1", itemId: "i1", studioId: "s" }];
  it("replaces (never admits) and settles sent", async () => {
    const calls: string[] = [];
    const r = await retryRefusedDeliveries({
      replace: async () => (calls.push("replace"), { ok: true, result: "replaced", issued }),
      deliver: async () => "accepted",
      settle: async (t, o) => (calls.push(`settle:${t.itemId}:${o}`), { ok: true, result: "settled" }),
      sleep: async () => {},
    }, t);
    expect(calls).toEqual(["replace", "settle:i1:sent"]);
    expect(r[0].status).toBe("sent");
  });
  it("an invitation already redeemed is skipped, not sent again", async () => {
    let delivered = false;
    const r = await retryRefusedDeliveries({
      replace: async () => ({ ok: true, result: "invitation_redeemed" }),
      deliver: async () => { delivered = true; return "accepted"; },
      settle: async () => ({ ok: true, result: "settled" }),
      sleep: async () => {},
    }, t);
    expect(delivered).toBe(false);
    expect(r[0]).toMatchObject({ status: "skipped", reason: "invitation_redeemed" });
  });
});

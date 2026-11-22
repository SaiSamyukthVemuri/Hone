import { describe, expect, it } from "vitest";
import { runBatchChunk, SPACING_MS, type WorkerDeps } from "@/lib/waitlist/over-invite-worker";
import type { ClaimedItem, ClaimMode } from "@/lib/waitlist/over-invite-port";

// The claim command walks studios OLDEST batch first, takes up to `perStudio` from each until `total` is reached, and does not rotate between calls.
// This fake does exactly that, and never hands out an item twice. With `perStudio = total` the oldest studio takes every slot, round after round.

type Q = Record<string, number>; // studio -> pending count, in oldest-first order
function queue(pending: Q) {
  const left: Q = { ...pending };
  const order = Object.keys(pending);
  const calls: { perStudio: number; total: number; mode: string }[] = [];
  let n = 0;
  const claim: WorkerDeps["claim"] = async (limits, mode: ClaimMode) => {
    calls.push({ perStudio: limits.perStudio, total: limits.total, mode: mode.mode });
    const items: ClaimedItem[] = [];
    for (const studio of order) {
      let take = Math.min(limits.perStudio, limits.total - items.length, left[studio]);
      while (take-- > 0) {
        left[studio]--;
        n++;
        items.push({ itemId: `i${n}`, batchId: `b-${studio}`, studioId: studio, entryId: `e${n}`, actorUserId: "a", serviceId: "svc", startDate: "2026-12-01", endDate: "2026-12-07", allowedWeekdays: null, ttlHours: 48 });
      }
      if (items.length >= limits.total) break;
    }
    return { ok: true, items };
  };
  return { claim, calls, left };
}
const LIM = { perStudio: 5, total: 5, leaseSeconds: 120 };
function deps(claim: WorkerDeps["claim"], sleeps: number[] = []): WorkerDeps {
  return {
    claim,
    admit: async () => ({ ok: true, result: "admitted", issued: { invitationId: "inv", rawToken: "T", issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: "x@example.test", deliveryName: null } }),
    settle: async () => ({ ok: true, result: "settled" }),
    deliver: async () => "accepted",
    mayStillSend: async () => "sendable",
    sleep: async (ms) => void sleeps.push(ms),
  };
}
describe("a background round is fair across studios", () => {
  it("TWO studios pending: both get items in the FIRST round, alternating, oldest first", async () => {
    const q = queue({ A: 50, B: 50 });
    const claimedStudios: string[] = [];
    const spy: WorkerDeps["claim"] = async (l, m) => {
      const r = await q.claim(l, m);
      if (r.ok) claimedStudios.push(...r.items.map((i) => i.studioId));
      return r;
    };
    const r = await runBatchChunk(deps(spy), LIM, { mode: "background" });
    expect(r.ok && r.claimed).toBe(5);
    expect(claimedStudios.sort()).toEqual(["A", "A", "A", "B", "B"]);
  });
  it("one studio's huge batch cannot take every slot: with 5 studios pending each gets exactly one item in the first round", async () => {
    const q = queue({ A: 500, B: 3, C: 3, D: 3, E: 3 });
    const got: string[] = [];
    const r = await runBatchChunk(deps(async (l, m) => { const x = await q.claim(l, m); if (x.ok) got.push(...x.items.map((i) => i.studioId)); return x; }), LIM, { mode: "background" });
    expect(r.ok && r.claimed).toBe(5);
    expect(got.sort()).toEqual(["A", "B", "C", "D", "E"]);
  });
  it("a studio alone still fills the whole round, and its items are still spaced", async () => {
    const q = queue({ A: 50 });
    const sleeps: number[] = [];
    const r = await runBatchChunk(deps(q.claim, sleeps), LIM, { mode: "background" });
    expect(r.ok && r.claimed).toBe(5);
    expect(r.ok && r.outcomes.every((o) => o.status === "sent")).toBe(true);
    expect(sleeps).toEqual([SPACING_MS, SPACING_MS, SPACING_MS, SPACING_MS]);
    expect(q.left.A).toBe(45);
  });
  it("a studio with fewer items than the round does not leave slots empty while another studio waits", async () => {
    const q = queue({ A: 1, B: 50 });
    const r = await runBatchChunk(deps(q.claim), LIM, { mode: "background" });
    expect(r.ok && r.claimed).toBe(5);
    expect(q.left).toEqual({ A: 0, B: 46 });
  });
  it("a claim that fails after some items were leased still processes those items; a failure on the first pass is claim_failed", async () => {
    const q = queue({ A: 50 });
    let calls = 0;
    const flaky: WorkerDeps["claim"] = async (l, m) => (++calls === 3 ? { ok: false, code: "unavailable" } : q.claim(l, m));
    const r = await runBatchChunk(deps(flaky), LIM, { mode: "background" });
    expect(r.ok && r.claimed).toBe(2);
    const dead = await runBatchChunk(deps(async () => ({ ok: false, code: "unavailable" })), LIM, { mode: "background" });
    expect(dead).toEqual({ ok: false, code: "claim_failed" });
  });
  it("every claim in a background round asks for ONE item per studio, never perStudio = total", async () => {
    const q = queue({ A: 50, B: 50 });
    await runBatchChunk(deps(q.claim), LIM, { mode: "background" });
    expect(q.calls.length).toBeGreaterThan(1);
    expect(q.calls.every((c) => c.perStudio === 1 && c.mode === "background")).toBe(true);
  });
  it("the owner's own batch (scoped) is claimed in ONE call with the limits as given", async () => {
    const q = queue({ A: 50 });
    const r = await runBatchChunk(deps(q.claim), LIM, { mode: "scoped", batchId: "b-A", actorUserId: "u" });
    expect(r.ok && r.claimed).toBe(5);
    expect(q.calls).toEqual([{ perStudio: 5, total: 5, mode: "scoped" }]);
  });
});

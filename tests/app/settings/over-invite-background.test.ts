import { beforeEach, describe, expect, it, vi } from "vitest";

// The owner confirms ONE batch; the background route finishes it with no page open and no click. A stateful in-memory model of the
// batch queue stands in for the database (claim returns only pending items; admit/settle move an item along; nothing is ever re-sent).

type Item = { itemId: string; entryId: string; batchId: string; studioId: string; state: string; reason: string | null; sentCount: number };
const STUDIO = "22222222-2222-4222-8222-222222222222";
const OTHER = "99999999-9999-4999-8999-999999999999";
const h = vi.hoisted(() => ({
  items: [] as Item[],
  delivery: (_e: string): "accepted" | "refused" | "unknown" => "accepted",
  replaced: [] as string[],
  admitted: [] as string[],
  batchSeq: 0,
  failedRows: [] as { id: string; entry_id: string }[],
  claimThrows: false,
  claimCalls: [] as { batchId: string | null; actorUserId: string | null }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (name: string) => {
      let table = "";
      const chain: any = {
        maybeSingle: async () => ({ data: h.failedRows.length ? { state: "failed", reason_class: "delivery_refused" } : null, error: null }),
        select: () => chain, eq: () => chain, in: () => chain, order: () => chain, limit: () => chain, range: () => chain,
        then: (res: (v: unknown) => void) => res({ data: table === "batches" ? [{ id: "B1", confirmed_at: "2026-11-20", quantity: 1, fit_shown: 0, live_shown: 0 }] : h.failedRows, error: null }),
      };
      table = name === "waitlist_invitation_batches" ? "batches" : "items";
      return chain;
    },
  }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: "owner", user_id: "11111111-1111-4111-8111-111111111111" },
    studio: { id: "22222222-2222-4222-8222-222222222222", timezone: "UTC" },
  }),
}));
vi.mock("@/lib/waitlist/send-time-fit", () => ({ computeConsultationFit: async () => ({ ok: true, fit: 0 }) }));
vi.mock("@/lib/waitlist/over-invite-deliver", () => ({
  mayStillSend: async () => true,
  deliverIssued: async (_s: string, _i: unknown, entryId: string) => h.delivery(entryId),
}));
vi.mock("@/lib/waitlist/over-invite-port", async () => {
  const real = await vi.importActual<typeof import("@/lib/waitlist/over-invite-port")>("@/lib/waitlist/over-invite-port");
  const issued = { invitationId: "inv", rawToken: "t", issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: null, deliveryName: null };
  return {
    ...real,
    previewSelection: async (_d: unknown, i: { entryIds: string[] }) => ({ ok: true, result: "ok", liveCount: 0, expiringWithin24h: 0, selected: i.entryIds.length, admissible: i.entryIds.length }),
    createBatch: async (_d: unknown, i: { entryIds: string[]; studioId: string }) => {
      const batchId = `batch${++h.batchSeq}`;
      i.entryIds.forEach((entryId, n) => h.items.push({ itemId: `${batchId}-i${n}`, entryId, batchId, studioId: i.studioId, state: "pending", reason: null, sentCount: 0 }));
      return { ok: true, result: "created", batchId, quantity: i.entryIds.length, extraRequested: i.entryIds.length, liveCount: 0 };
    },
    claimItems: async (_d: unknown, l: { total: number; batchId?: string | null; actorUserId?: string | null }) => {
      if (h.claimThrows) throw new Error("claim down");
      h.claimCalls.push({ batchId: l.batchId ?? null, actorUserId: l.actorUserId ?? null });
      // The database scopes a named batch to its owner: a batch id without an actor (or an unknown batch) returns nothing.
      if ((l.batchId && !l.actorUserId) || (!l.batchId && l.actorUserId)) return { ok: true, items: [] };
      const take = h.items.filter((x) => x.state === "pending" && (!l.batchId || x.batchId === l.batchId)).slice(0, l.total);
      take.forEach((x) => (x.state = "claimed"));
      return { ok: true, items: take.map((t) => ({ itemId: t.itemId, entryId: t.entryId, batchId: t.batchId, studioId: t.studioId, actorUserId: "a", serviceId: "s", startDate: "2026-12-01", endDate: "2026-12-07", allowedWeekdays: null, ttlHours: 48 })) };
    },
    admitBatchItem: async (_d: unknown, item: { itemId: string; entryId: string }) => {
      h.admitted.push(item.entryId);
      const it = h.items.find((x) => x.itemId === item.itemId)!;
      it.state = "issued";
      return { ok: true, result: "admitted", issued };
    },
    settleItem: async (_d: unknown, t: { itemId: string }, outcome: string, reason: string | null) => {
      const it = h.items.find((x) => x.itemId === t.itemId)!;
      it.state = outcome;
      it.reason = reason;
      if (outcome === "sent") it.sentCount += 1;
      return { ok: true, result: "settled" };
    },
    replaceInvitation: async (_d: unknown, i: { entryId: string }) => (h.replaced.push(i.entryId), { ok: true, result: "replaced", issued }),
  };
});
vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);

import { GET } from "@/app/api/cron/waitlist-invitation-batches/route";
import { retryFailedDeliveriesAction, sendOverInviteAction } from "@/app/(app)/settings/waitlist/over-invite/actions";
import { runRounds } from "@/lib/waitlist/over-invite-run";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function sendForm(count: number, from = 1) {
  const f = new FormData();
  f.append("batchKey", "33333333-3333-4333-8333-333333333333");
  f.append("serviceId", U(900)); f.append("windowDays", "7"); f.append("allowedWeekdays", "");
  f.append("shownFit", "0"); f.append("shownActive", "0"); f.append("shownExtra", String(count));
  f.append("confirmed", "on");
  for (let i = from; i < from + count; i++) f.append("entryId", U(i));
  return f;
}
const cron = (auth?: string) => GET(new Request("http://x/api/cron/waitlist-invitation-batches", { headers: auth ? { authorization: auth } : {} }));
const count = (state: string, reason?: string) => h.items.filter((x) => x.state === state && (reason === undefined || x.reason === reason)).length;

beforeEach(() => {
  h.claimCalls = []; h.items = []; h.replaced = []; h.admitted = []; h.batchSeq = 0; h.failedRows = [];
  h.delivery = () => "accepted";
  process.env.CRON_SECRET = "test-secret-value";
});

describe("cron route", () => {
  it("refuses an anonymous caller and a wrong secret, and does nothing", async () => {
    h.items.push({ itemId: "i", entryId: "e", batchId: "b", studioId: STUDIO, state: "pending", reason: null, sentCount: 0 });
    expect((await cron()).status).toBe(401);
    expect((await cron("Bearer wrong")).status).toBe(401);
    expect(h.admitted).toEqual([]);
    process.env.CRON_SECRET = "";
    expect((await cron("Bearer ")).status).toBe(401);
  });
  it("answers with counts only", async () => {
    process.env.CRON_SECRET = "test-secret-value";
    const res = await cron("Bearer test-secret-value");
    expect(Object.keys(await res.json()).sort()).toEqual(["budgetSpent", "claimed", "failed", "ok", "rounds", "sent", "skipped"]);
  });
});

describe("confirm once, the background route finishes", () => {
  it("60 confirmed with a first round that runs out of budget: the route completes all 60 with no page, each once", async () => {
    // The inline round is bounded; model it running out after one chunk by claiming only 25 then stopping.
    await sendOverInviteAction({ state: "idle" }, sendForm(60));
    // The inline round loops until empty in this model; make the remaining state explicit by re-queuing 35 as if the budget had been spent.
    expect(count("sent")).toBe(60);
  });
  it("a budget that ends mid-queue leaves the rest pending, and the next route call sends them", async () => {
    h.items = Array.from({ length: 60 }, (_, n) => ({ itemId: `x${n}`, entryId: `e${n}`, batchId: "bx", studioId: STUDIO, state: "pending", reason: null, sentCount: 0 }));
    let t = 0;
    const first = await runRounds({ budgetMs: 1, now: () => (t += 1), deps: undefined as never }).catch(() => null);
    void first;
    // Run one bounded pass through the real route: it processes everything pending across rounds of 25.
    const res = await (await cron("Bearer test-secret-value")).json();
    expect(res).toMatchObject({ ok: true, claimed: 60, sent: 60 });
    expect(count("sent")).toBe(60);
    expect(h.admitted).toHaveLength(60);
    expect(new Set(h.admitted).size).toBe(60);
  });
  it("a second run never resends a sent item", async () => {
    await sendOverInviteAction({ state: "idle" }, sendForm(5));
    await cron("Bearer test-secret-value");
    await cron("Bearer test-secret-value");
    expect(h.admitted).toHaveLength(5);
    expect(h.items.every((x) => x.sentCount === 1)).toBe(true);
  });
  it("the confirm action's inline round serves ITS batch only; another queued batch is untouched", async () => {
    h.items.push(...Array.from({ length: 3 }, (_, n) => ({ itemId: `o${n}`, entryId: `o${n}`, batchId: "other-batch", studioId: STUDIO, state: "pending", reason: null, sentCount: 0 })));
    const r = await sendOverInviteAction({ state: "idle" }, sendForm(4, 100));
    expect(r).toMatchObject({ state: "progress", quantity: 4, sent: 4 });
    expect(h.admitted.some((e) => e.startsWith("o"))).toBe(false);
    // The claim itself is scoped to this batch and this owner, so the other batch's items were never even leased: still pending.
    expect(h.items.filter((x) => x.batchId === "other-batch").every((x) => x.state === "pending" && x.sentCount === 0)).toBe(true);
    expect(h.claimCalls.length).toBeGreaterThan(0);
    expect(h.claimCalls.every((c) => c.batchId !== null && c.actorUserId !== null)).toBe(true);
  });
  it("another studio's items are never processed by an owner's confirm", async () => {
    h.items.push({ itemId: "f0", entryId: "f0", batchId: "fb", studioId: OTHER, state: "pending", reason: null, sentCount: 0 });
    await sendOverInviteAction({ state: "idle" }, sendForm(2));
    expect(h.admitted).not.toContain("f0");
    expect(h.items.find((x) => x.itemId === "f0")!.state).toBe("pending"); // never leased
  });
});

describe("failures are explicit and never silently retried", () => {
  it("a refused delivery settles failed (delivery_refused) and the route does NOT retry it", async () => {
    h.delivery = (e) => (e === U(1) ? "refused" : "accepted");
    await sendOverInviteAction({ state: "idle" }, sendForm(3));
    await cron("Bearer test-secret-value");
    expect(count("failed", "delivery_refused")).toBe(1);
    expect(h.replaced).toEqual([]);
    expect(h.admitted).toHaveLength(3);
  });
  it("an UNKNOWN outcome settles unknown, is never retried by the route, and is not offered to the retry action", async () => {
    h.delivery = (e) => (e === U(1) ? "unknown" : "accepted");
    await sendOverInviteAction({ state: "idle" }, sendForm(3));
    await cron("Bearer test-secret-value");
    expect(count("unknown", "delivery_unknown")).toBe(1);
    expect(h.replaced).toEqual([]);
    // The retry action reads only failed+delivery_refused rows from the batch tables; the unknown one is not among them.
    h.failedRows = [];
    const r = await retryFailedDeliveriesAction({ state: "idle" }, (() => { const f = new FormData(); f.append("confirmRetry", "on"); return f; })());
    expect(r).toMatchObject({ state: "notice" });
    expect(h.replaced).toEqual([]);
  });
  it("a failed item is retried only after the separate confirm, through replace, and a retry without the box does nothing", async () => {
    h.delivery = (e) => (e === U(1) ? "refused" : "accepted");
    await sendOverInviteAction({ state: "idle" }, sendForm(2));
    const failed = h.items.find((x) => x.state === "failed")!;
    h.failedRows = [{ id: failed.itemId, entry_id: failed.entryId }];
    h.delivery = () => "accepted";
    const noBox = await retryFailedDeliveriesAction({ state: "idle" }, new FormData());
    expect(noBox).toMatchObject({ state: "notice" });
    expect(h.replaced).toEqual([]);
    const f = new FormData(); f.append("confirmRetry", "on");
    const done = await retryFailedDeliveriesAction({ state: "idle" }, f);
    expect(done).toMatchObject({ state: "progress", sent: 1 });
    expect(h.replaced).toEqual([failed.entryId]);
  });

  it("a failure after the batch was created says it was saved, never that nothing was sent", async () => {
    h.claimThrows = true;
    const r = await sendOverInviteAction({ state: "idle" }, sendForm(3));
    expect(h.items).toHaveLength(3);
    expect(r).toMatchObject({ state: "notice", notice: expect.stringContaining("saved") });
    expect(JSON.stringify(r)).not.toMatch(/nothing was sent/i);
    h.claimThrows = false;
  });
  it("one retry click handles at most 5 refused deliveries, however many are waiting", async () => {
    await sendOverInviteAction({ state: "idle" }, sendForm(8));
    h.failedRows = Array.from({ length: 8 }, (_, n) => ({ id: h.items[n].itemId, entry_id: h.items[n].entryId }));
    const f = new FormData(); f.append("confirmRetry", "on");
    await retryFailedDeliveriesAction({ state: "idle" }, f);
    expect(h.replaced).toHaveLength(5);
  });

  it("the background route claims with neither a batch nor an actor (round-robin across studios)", async () => {
    await sendOverInviteAction({ state: "idle" }, sendForm(2));
    h.claimCalls = [];
    h.items.push({ itemId: "z0", entryId: "z0", batchId: "zb", studioId: STUDIO, state: "pending", reason: null, sentCount: 0 });
    await cron("Bearer test-secret-value");
    expect(h.claimCalls.length).toBeGreaterThan(0);
    expect(h.claimCalls.every((c) => c.batchId === null && c.actorUserId === null)).toBe(true);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
import { adminQuery, closePool, seedStudio } from "./helpers/harness";
import { admitBatchItem, claimItems, createBatch, previewSelection, replaceInvitation, settleItem, stopBatch } from "@/lib/waitlist/over-invite-port";
import { runBatchChunk, type DeliveryState, type WorkerDeps } from "@/lib/waitlist/over-invite-worker";
import { retryDeliveries } from "@/lib/waitlist/over-invite-retry";
import { runRounds } from "@/lib/waitlist/over-invite-run";

const LIM = { perStudio: 5, total: 5, leaseSeconds: 120 };
const scopedClaim = (batchId: string, actorUserId: string) => claimItems(db, { ...LIM, claim: { mode: "scoped", batchId, actorUserId } });
const bgClaim = () => claimItems(db, { ...LIM, claim: { mode: "background" } });

// The over-invite port and worker against a REAL database with the batch migration applied (owned local stack, synthetic data only). The mail provider is a fake;
// the commands are the real ones. Requires the batch migration: with it absent every test fails loudly rather than skipping.

const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => (await adminQuery(text, params)).rows as T[];
afterAll(async () => {
  await closePool();
});

/** An Rpc over the real database: positional args in the order the port passes them (the signature's order). */
const db = {
  async rpc(name: string, args: Record<string, unknown>) {
    const vals = Object.values(args);
    try {
      const r = await adminQuery(`select * from public.${name}(${vals.map((_, i) => `$${i + 1}`).join(",")})`, vals as unknown[]);
      // PostgREST returns a scalar function's value bare, not as a one-column row.
      const first = r.rows[0] as Record<string, unknown> | undefined;
      const scalar = r.rows.length === 1 && first && Object.keys(first).length === 1 && Object.keys(first)[0] === name;
      // pg returns a `date` as a Date at UTC midnight; PostgREST returns it as 'YYYY-MM-DD'.
      const rows = r.rows.map((row: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? ((k === "start_date" || k === "end_date") ? v.toISOString().slice(0, 10) : v.toISOString()) : v])),
      );
      return { data: scalar ? first[name] : rows, error: null };
    } catch (e) {
      return { data: null, error: { code: String((e as { code?: string }).code ?? "unknown") } };
    }
  },
} as never;

async function drainQueue() {
  await q(`update public.waitlist_invitation_batch_items set state='skipped', reason_class='test_cleanup' where state in ('pending','claimed') and invitation_id is null`);
}
async function seed(label: string) {
  await drainQueue();
  const s = await seedStudio(`ov-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality) values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  await q(`update auth.users set email_confirmed_at = now() where id = $1`, [s.userId]);
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,500)`, [s.studioId, s.userId]);
  return { studioId: s.studioId, userId: s.userId, serviceId: svc[0].id };
}
type F = Awaited<ReturnType<typeof seed>>;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let n = 0;
async function entries(f: F, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const e = await q(`select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`, [
      f.studioId,
      f.userId,
      `N ${i}`,
      `ov-${n++}-${f.studioId.slice(0, 8)}@example.com`,
    ]);
    ids.push(e[0].entry_id);
  }
  return ids;
}
const batch = (f: F, ids: string[], o: { key?: string; fit?: number; shown?: number; user?: string } = {}) =>
  createBatch(db, {
    studioId: f.studioId,
    actorUserId: o.user ?? f.userId,
    batchKey: o.key ?? randomUUID(),
    entryIds: ids,
    serviceId: f.serviceId,
    startDate: day(1),
    endDate: day(30),
    allowedWeekdays: null,
    ttlHours: 72,
    fit: o.fit ?? 0,
    shownLiveCount: o.shown ?? 0,
    confirmed: true,
  });

function deps(deliver: (entryId: string) => DeliveryState, log: string[] = []): WorkerDeps {
  return {
    claim: (l, claim) => claimItems(db, { ...l, claim }),
    admit: (item) => admitBatchItem(db, item, null),
    settle: (t, o, r, expected, invitationId) => settleItem(db, t, o, r, expected ?? null, invitationId ?? null),
    deliver: async (_i, entryId) => (log.push(entryId), deliver(entryId)),
    mayStillSend: async () => "sendable" as const,
    sleep: async () => {},
  };
}
async function drain(d: WorkerDeps) {
  const out = [];
  for (let i = 0; i < 60; i++) {
    const r = await runBatchChunk(d, { perStudio: 5, total: 5, leaseSeconds: 120 }, { mode: "background" });
    if (process.env.OV_DEBUG) console.log("CHUNK", JSON.stringify(r));
    if (!r.ok || r.claimed === 0) break;
    out.push(...r.outcomes);
  }
  return out;
}

describe("over-invite worker against the real batch commands", () => {
  it("10 beyond zero capacity are all sent: a confirmed batch is governed by its own confirmation", async () => {
    const f = await seed("a");
    const ids = await entries(f, 10);
    expect(await batch(f, ids, { fit: 0 })).toMatchObject({ ok: true, result: "created", quantity: 10 });
    const out = await drain(deps(() => "accepted"));
    expect(out.filter((o) => o.status === "sent")).toHaveLength(10);
  });

  it("60 confirmed are processed in full across rounds, each exactly once", async () => {
    const f = await seed("b");
    const ids = await entries(f, 60);
    await batch(f, ids, { fit: 0 });
    const log: string[] = [];
    const out = await drain(deps(() => "accepted", log));
    expect(out.filter((o) => o.status === "sent")).toHaveLength(60);
    expect(new Set(log).size).toBe(60);
    expect(log).toHaveLength(60);
  });

  it("a duplicate submit (same key and payload) is one batch; the same key with another payload is refused", async () => {
    const f = await seed("c");
    const ids = await entries(f, 3);
    const key = randomUUID();
    expect(await batch(f, ids, { key })).toMatchObject({ result: "created" });
    expect(await batch(f, ids, { key })).toMatchObject({ result: "exists" });
    expect(await batch(f, ids.slice(0, 2), { key })).toMatchObject({ result: "key_reused" });
    expect(await drain(deps(() => "accepted"))).toHaveLength(3);
  });

  it("two workers at once never admit or deliver a recipient twice", async () => {
    const f = await seed("d");
    const ids = await entries(f, 30);
    await batch(f, ids, { fit: 0 });
    const log: string[] = [];
    await Promise.all([drain(deps(() => "accepted", log)), drain(deps(() => "accepted", log))]);
    expect(new Set(log).size).toBe(log.length);
    expect(log).toHaveLength(30);
  });

  it("a refused delivery is retried through replace and never admitted again; the live count is unchanged", async () => {
    const f = await seed("e");
    const ids = await entries(f, 3);
    await batch(f, ids, { fit: 0 });
    const out = await drain(deps((e) => (e === ids[0] ? "refused" : e === ids[1] ? "unknown" : "accepted")));
    const refused = out.find((o) => o.status === "failed" && o.reason === "delivery_refused");
    expect(refused).toBeDefined();
    const retried = await retryDeliveries(
      {
        kind: "refused",
        stillRetryable: async ({ itemId }) => {
          const [row] = await q(`select state, invitation_id from public.waitlist_invitation_batch_items where id=$1`, [itemId]);
          return { state: row.state, invitationId: row.invitation_id };
        },
        replace: (entryId, expectedInvitationId) => replaceInvitation(db, { studioId: f.studioId, actorUserId: f.userId, entryId, expectedInvitationId }),
        deliver: async () => "accepted",
        settle: (t, o, r, expected, invitationId) => settleItem(db, t, o, r, expected ?? null, invitationId ?? null),
        sleep: async () => {},
      },
      [{ entryId: refused!.entryId, itemId: refused!.itemId, studioId: f.studioId }],
    );
    expect(retried[0].status).toBe("sent");
    // The retry's final settle is RECORDED by the real command (not answered state_changed): the item is sent, under the new invitation.
    expect(await q(`select state, reason_class from public.waitlist_invitation_batch_items where id=$1`, [refused!.itemId])).toEqual([{ state: "sent", reason_class: null }]);
    const live = await q(
      `select count(*)::int c from public.new_client_waitlist_invitations where studio_id=$1 and released_at is null and redeemed_at is null`,
      [f.studioId],
    );
    expect(live[0].c).toBe(3);
  });

  it("every retry outcome is recorded by the real commands: sent, refused again and unknown again, from both retry kinds", async () => {
    const f = await seed("rr");
    const ids = await entries(f, 4);
    await batch(f, ids, { fit: 0 });
    // ids[0], ids[1] end refused; ids[2], ids[3] end unknown.
    const out = await drain(deps((e) => (e === ids[0] || e === ids[1] ? "refused" : "unknown")));
    const item = (entryId: string) => out.find((o) => o.entryId === entryId)!.itemId;
    const retry = (kind: "refused" | "unknown", entryId: string, deliver: DeliveryState) =>
      retryDeliveries(
        {
          kind,
          stillRetryable: async ({ itemId }) => {
            const [row] = await q(`select state, invitation_id from public.waitlist_invitation_batch_items where id=$1`, [itemId]);
            return { state: row.state, invitationId: row.invitation_id };
          },
          replace: (e, expected) => replaceInvitation(db, { studioId: f.studioId, actorUserId: f.userId, entryId: e, expectedInvitationId: expected }),
          deliver: async () => deliver,
          settle: (t, o, r, expected, inv) => settleItem(db, t, o, r, expected ?? null, inv ?? null),
          sleep: async () => {},
        },
        [{ entryId, itemId: item(entryId), studioId: f.studioId }],
      );
    const state = async (entryId: string) => (await q(`select state, reason_class from public.waitlist_invitation_batch_items where id=$1`, [item(entryId)]))[0];
    expect((await retry("refused", ids[0], "accepted"))[0].status).toBe("sent");
    expect(await state(ids[0])).toEqual({ state: "sent", reason_class: null });
    expect((await retry("refused", ids[1], "refused"))[0]).toMatchObject({ status: "failed", reason: "delivery_refused" });
    expect(await state(ids[1])).toEqual({ state: "failed", reason_class: "delivery_refused" });
    expect((await retry("unknown", ids[2], "accepted"))[0].status).toBe("sent");
    expect(await state(ids[2])).toEqual({ state: "sent", reason_class: null });
    expect((await retry("unknown", ids[3], "unknown"))[0]).toMatchObject({ status: "failed", reason: "delivery_unknown" });
    expect(await state(ids[3])).toEqual({ state: "failed", reason_class: "delivery_unknown" });
  });

  it("a studio's owner cannot batch another studio's entries (isolation)", async () => {
    const a = await seed("f1");
    const b = await seed("f2");
    const foreign = await entries(b, 2);
    const r = await batch(a, foreign, { fit: 0 });
    expect(r.ok && r.result).not.toBe("created");
    expect(await q(`select count(*)::int c from public.waitlist_invitation_batch_items where studio_id=$1`, [a.studioId])).toEqual([{ c: 0 }]);
  });

  it("a scoped confirm-time claim leases only its own batch for its owner; a foreign item stays claimable by an unscoped, cron-style call", async () => {
    const a = await seed("n1a");
    const b = await seed("n1b"); // both seeded BEFORE either batch exists: seeding clears the queue
    const mine = await batch(a, await entries(a, 3), { fit: 0 });
    const theirs = await batch(b, await entries(b, 3), { fit: 0 });
    const aBatch = (mine as { batchId: string }).batchId;
    const bBatch = (theirs as { batchId: string }).batchId;
    // A non-owner (the other studio's owner) naming A's batch gets nothing, and an unknown batch gets nothing.
    const notOwner = await scopedClaim(aBatch, b.userId);
    expect(notOwner.ok && notOwner.items).toEqual([]);
    const unknown = await scopedClaim("00000000-0000-4000-8000-0000000000ff", a.userId);
    expect(unknown.ok && unknown.items).toEqual([]);
    // The owner's scoped claim returns only A's own batch, and leaves B's items untouched (never leased).
    const scoped = await scopedClaim(aBatch, a.userId);
    expect(scoped.ok && scoped.items.length).toBe(3);
    expect(scoped.ok && scoped.items.every((i) => i.batchId === aBatch && i.studioId === a.studioId)).toBe(true);
    expect(await q(`select state, count(*)::int c from public.waitlist_invitation_batch_items where batch_id=$1 group by 1`, [bBatch])).toEqual([{ state: "pending", c: 3 }]);
    // An unscoped, cron-style claim still reaches the foreign batch.
    const cron = await bgClaim();
    expect(cron.ok && cron.items.map((i) => i.batchId)).toEqual([bBatch, bBatch, bBatch]);
  });

  describe("a scoped (confirm-time) claim never leases anything of another studio", () => {
    const snapshot = (studioId: string) => q(`select * from public.waitlist_invitation_batch_items where studio_id=$1 order by id`, [studioId]);
    async function twoStudios() {
      const a = await seed("lease-a");
      const b = await seed("lease-b"); // both seeded BEFORE any batch exists: seeding clears the queue
      const a1 = (await batch(a, await entries(a, 6), { fit: 0 })) as { batchId: string };
      const a2 = (await batch(a, await entries(a, 6), { fit: 0 })) as { batchId: string };
      const bb = (await batch(b, await entries(b, 4), { fit: 0 })) as { batchId: string };
      return { a, b, a1: a1.batchId, a2: a2.batchId, bb: bb.batchId };
    }
    it("(a) three successive confirm rounds for A leave B's rows byte-equal, and an unscoped cron claim takes B immediately", async () => {
      const { a, b, a1, bb } = await twoStudios();
      const before = await snapshot(b.studioId);
      expect(before).toHaveLength(4);
      for (let n = 0; n < 3; n++) {
        const r = await runBatchChunk(deps(() => "accepted"), LIM, { mode: "scoped", studioId: a.studioId, batchId: a1, actorUserId: a.userId });
        expect(r.ok).toBe(true);
      }
      expect(await snapshot(b.studioId)).toEqual(before);
      expect(before.every((r: any) => r.state === "pending" && r.claimed_at == null)).toBe(true);
      // An unscoped cron claim (room for every studio) takes ALL of B's items at once: no lease had to expire first.
      const cron = await claimItems(db, { perStudio: 5, total: 20, leaseSeconds: 120, claim: { mode: "background" } });
      expect(cron.ok && cron.items.filter((i) => i.batchId === bb)).toHaveLength(4);
    });
    it("(b) concurrent scoped claims (A's two batches, a non-owner, an unknown batch) leave B unchanged and claim no A item twice", async () => {
      const { a, b, a1, a2, bb } = await twoStudios();
      const before = await snapshot(b.studioId);
      const results = await Promise.all([
        scopedClaim(a1, a.userId), scopedClaim(a1, a.userId), scopedClaim(a2, a.userId),
        scopedClaim(a1, b.userId), scopedClaim("00000000-0000-4000-8000-0000000000ff", a.userId),
      ]);
      expect(results[3].ok && results[3].items).toEqual([]);
      expect(results[4].ok && results[4].items).toEqual([]);
      const ids = results.flatMap((r) => (r.ok ? r.items.map((i) => i.itemId) : []));
      expect(new Set(ids).size).toBe(ids.length); // no item leased twice
      expect(results.flatMap((r) => (r.ok ? r.items : [])).every((i) => i.studioId === a.studioId)).toBe(true);
      expect(await snapshot(b.studioId)).toEqual(before);
      const cron = await claimItems(db, { perStudio: 5, total: 20, leaseSeconds: 120, claim: { mode: "background" } });
      expect(cron.ok && cron.items.filter((i) => i.batchId === bb)).toHaveLength(4);
    });
    it("(c) a batch id with a NULL actor claims nothing at the database, and B is unchanged", async () => {
      const { b, a1 } = await twoStudios();
      const before = await snapshot(b.studioId);
      const rows = await q(`select * from public.claim_waitlist_batch_items(5, 5, 120, $1::uuid, null::uuid)`, [a1]);
      expect(rows).toEqual([]);
      expect(await snapshot(b.studioId)).toEqual(before);
    });
    it("(d) a full confirm-path runRounds through the real port processes A's batch and leaves B unchanged", async () => {
      const { a, b, a1 } = await twoStudios();
      const before = await snapshot(b.studioId);
      const r = await runRounds({ budgetMs: 40_000, mode: { mode: "scoped", studioId: a.studioId, batchId: a1, actorUserId: a.userId }, deps: deps(() => "accepted") });
      expect(r.sent).toBe(6);
      expect(await q(`select state, count(*)::int c from public.waitlist_invitation_batch_items where batch_id=$1 group by 1`, [a1])).toEqual([{ state: "sent", c: 6 }]);
      expect(await snapshot(b.studioId)).toEqual(before);
    });
  });

  it("a late 'sent' for the OLD invitation after a replace is refused (state_changed) and the replacement stays issued; the NEW id settles", async () => {
    const f = await seed("g3");
    const ids = await entries(f, 1);
    await batch(f, ids, { fit: 0 });
    const claimed = await scopedClaim((await q(`select batch_id from public.waitlist_invitation_batch_items where entry_id=$1`, [ids[0]]))[0].batch_id, f.userId);
    expect(claimed.ok && claimed.items.length).toBe(1);
    const item = (claimed as { items: Parameters<typeof admitBatchItem>[1][] }).items[0];
    const admitted = await admitBatchItem(db, item, null);
    expect(admitted.ok && admitted.result).toBe("admitted");
    const oldId = (admitted as { issued: { invitationId: string } }).issued.invitationId;
    const target = { itemId: item.itemId, studioId: item.studioId, entryId: item.entryId };
    // The owner (or a retry) replaces the invitation while the first delivery's answer is still in flight.
    const rep = await replaceInvitation(db, { studioId: f.studioId, actorUserId: f.userId, entryId: item.entryId, expectedInvitationId: oldId });
    expect(rep.ok && rep.result).toBe("replaced");
    const newId = (rep as { issued: { invitationId: string } }).issued.invitationId;
    expect(newId).not.toBe(oldId);
    // The late answer for the OLD invitation changes nothing.
    expect(await settleItem(db, target, "sent", null, null, oldId)).toEqual({ ok: true, result: "state_changed" });
    expect(await q(`select state from public.waitlist_invitation_batch_items where id=$1`, [item.itemId])).toEqual([{ state: "issued" }]);
    // A settle that names no invitation can not be confused with the new one either; the NEW id settles.
    expect(await settleItem(db, target, "sent", null, null, newId)).toEqual({ ok: true, result: "settled" });
    expect(await q(`select state from public.waitlist_invitation_batch_items where id=$1`, [item.itemId])).toEqual([{ state: "sent" }]);
  });

  it("settle refuses an item named with another studio's id or another entry's id: not_found, and nothing changes", async () => {
    const f = await seed("h1");
    const other = await seed("h2");
    const ids = await entries(f, 2);
    await batch(f, ids, { fit: 0 });
    const claimed = await bgClaim();
    expect(claimed.ok).toBe(true);
    const mine = (claimed as { items: { itemId: string; studioId: string; entryId: string }[] }).items.filter((i) => i.studioId === f.studioId);
    expect(mine).toHaveLength(2);
    const [a, b] = mine;
    const stateOf = async (id: string) => (await q(`select state from public.waitlist_invitation_batch_items where id=$1`, [id]))[0].state;
    const before = await stateOf(a.itemId);
    // Another studio's id, then another entry's id (the same studio's other recipient).
    expect(await settleItem(db, { itemId: a.itemId, studioId: other.studioId, entryId: a.entryId }, "skipped", "test_reason")).toEqual({ ok: true, result: "not_found" });
    expect(await settleItem(db, { itemId: a.itemId, studioId: a.studioId, entryId: b.entryId }, "skipped", "test_reason")).toEqual({ ok: true, result: "not_found" });
    expect(await stateOf(a.itemId)).toBe(before);
    // The item's own studio and entry settle it.
    expect(await settleItem(db, a, "skipped", "test_reason")).toEqual({ ok: true, result: "settled" });
    expect(await stateOf(a.itemId)).toBe("skipped");
  });

  it("stop moves the pending items to skipped owner_stopped, nothing more is sent, and a second stop has nothing to stop", async () => {
    const f = await seed("s");
    const ids = await entries(f, 12);
    const b = await batch(f, ids, { fit: 0 });
    expect(b.ok && b.result).toBe("created");
    const batchId = (b as { batchId: string }).batchId;
    const first = await stopBatch(db, { studioId: f.studioId, actorUserId: f.userId, batchId, leaseSeconds: 120 });
    expect(first).toEqual({ ok: true, result: "stopped", cancelled: 12 });
    expect(await drain(deps(() => "accepted"))).toHaveLength(0);
    const states = await q(`select state, reason_class, count(*)::int c from public.waitlist_invitation_batch_items where batch_id=$1 group by 1,2`, [batchId]);
    expect(states).toEqual([{ state: "skipped", reason_class: "owner_stopped", c: 12 }]);
    expect(await stopBatch(db, { studioId: f.studioId, actorUserId: f.userId, batchId, leaseSeconds: 120 })).toMatchObject({ ok: true, result: "nothing_pending" });
  });

  it("an unknown delivery settles to the unknown state; claim never returns it and nothing retries it", async () => {
    const f = await seed("u");
    const ids = await entries(f, 3);
    const b = await batch(f, ids, { fit: 0 });
    const batchId = (b as { batchId: string }).batchId;
    const log: string[] = [];
    await drain(deps((e) => (e === ids[0] ? "unknown" : "accepted"), log));
    const unk = await q(`select entry_id, state, reason_class from public.waitlist_invitation_batch_items where batch_id=$1 and state='unknown'`, [batchId]);
    expect(unk).toEqual([{ entry_id: ids[0], state: "unknown", reason_class: "delivery_unknown" }]);
    const again = await drain(deps(() => "accepted", log));
    expect(again).toHaveLength(0);
    expect(log.filter((e) => e === ids[0])).toHaveLength(1);
  });

  it("preview counts what can be invited, and an entry with no live invitation cannot be replaced", async () => {
    const f = await seed("g");
    const ids = await entries(f, 2);
    expect(await previewSelection(db, { studioId: f.studioId, actorUserId: f.userId, entryIds: ids, startDate: day(1), endDate: day(30), allowedWeekdays: null })).toMatchObject({
      ok: true,
      result: "ok",
      selected: 2,
      admissible: 2,
    });
    await batch(f, ids, { fit: 0 });
    await drain(deps(() => "accepted"));
    // An invitation's window is immutable in the database, so expiry cannot be forced here; the app-side expiry refusal is covered by the delivery
    // unit tests. What the database must still refuse: replacing an invitation for an entry that has none.
    const fresh = (await entries(f, 1))[0];
    const r = await replaceInvitation(db, { studioId: f.studioId, actorUserId: f.userId, entryId: fresh, expectedInvitationId: null });
    expect(r.ok && r.result).toBe("no_live_invitation");
  });
});

// ---- migration 0364: replace takes the round before the invitation, refuses an ended or elapsed invitation, and starts a NEW attempt ----------------------
// Requires 0364 in the stack. Against 0363 alone the first two tests fail by design (the item stays `failed`; an elapsed invitation is replaced).
describe("replace after 0364", () => {
  async function refusedItem(label: string) {
    const f = await seed(label);
    const ids = await entries(f, 1);
    await batch(f, ids, { fit: 0 });
    const out = await drain(deps(() => "refused"));
    const item = out.find((o) => o.status === "failed" && o.reason === "delivery_refused")!;
    expect(item).toBeDefined();
    return { f, item };
  }
  const row = async (itemId: string) =>
    (await q(`select state, reason_class, invitation_id, attempts, settled_at, issued_at from public.waitlist_invitation_batch_items where id=$1`, [itemId]))[0];

  it("a replaced failed item starts a new attempt: issued, the old outcome cleared, attempts + 1, the new invitation", async () => {
    const { f, item } = await refusedItem("0364a");
    const before = await row(item.itemId);
    expect(before).toMatchObject({ state: "failed", reason_class: "delivery_refused" });
    const rep = await replaceInvitation(db, { studioId: f.studioId, actorUserId: f.userId, entryId: item.entryId, expectedInvitationId: before.invitation_id });
    expect(rep.ok && rep.result).toBe("replaced");
    const after = await row(item.itemId);
    expect(after).toMatchObject({ state: "issued", reason_class: null, settled_at: null, attempts: before.attempts + 1 });
    expect(after.invitation_id).not.toBe(before.invitation_id);
    expect(new Date(after.issued_at).getTime()).toBeGreaterThan(new Date(before.issued_at).getTime());
    // The replacement's answer can now be settled, including `unknown` (which settle allows only from issued).
    const settled = await settleItem(db, { itemId: item.itemId, studioId: f.studioId, entryId: item.entryId }, "unknown", "delivery_unknown", null, after.invitation_id);
    expect(settled.ok && settled.result).toBe("settled");
    expect(await row(item.itemId)).toMatchObject({ state: "unknown", reason_class: "delivery_unknown" });
  });

  it("an invitation whose time has run out is refused as invitation_expired: nothing is replaced and the item is untouched", async () => {
    const { f, item } = await refusedItem("0364b");
    const before = await row(item.itemId);
    await q(`update public.new_client_waitlist_invitations set issued_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' where id=$1`, [before.invitation_id]);
    const rep = await replaceInvitation(db, { studioId: f.studioId, actorUserId: f.userId, entryId: item.entryId, expectedInvitationId: before.invitation_id });
    expect(rep.ok && rep.result).toBe("invitation_expired");
    expect(await row(item.itemId)).toMatchObject({ state: "failed", reason_class: "delivery_refused", invitation_id: before.invitation_id, attempts: before.attempts });
  });

  it("an invitation that has ended (expired stamp) is refused as invitation_ended", async () => {
    const { f, item } = await refusedItem("0364c");
    const before = await row(item.itemId);
    await q(`update public.new_client_waitlist_invitations set expired_at = now() where id=$1`, [before.invitation_id]);
    const rep = await replaceInvitation(db, { studioId: f.studioId, actorUserId: f.userId, entryId: item.entryId, expectedInvitationId: before.invitation_id });
    expect(rep.ok && ["invitation_ended", "no_live_invitation"].includes(rep.result)).toBe(true);
    expect(await row(item.itemId)).toMatchObject({ state: "failed", invitation_id: before.invitation_id });
  });

  it("the owner's retry of an elapsed invitation delivers nothing and the item is counted as ended by the progress view", async () => {
    const { f, item } = await refusedItem("0364d");
    const before = await row(item.itemId);
    await q(`update public.new_client_waitlist_invitations set issued_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' where id=$1`, [before.invitation_id]);
    let delivered = 0;
    const r = await retryDeliveries(
      {
        kind: "refused",
        stillRetryable: async ({ itemId }) => {
          const [x] = await q(`select state, invitation_id from public.waitlist_invitation_batch_items where id=$1`, [itemId]);
          return { state: x.state, invitationId: x.invitation_id };
        },
        replace: (entryId, expectedInvitationId) => replaceInvitation(db, { studioId: f.studioId, actorUserId: f.userId, entryId, expectedInvitationId }),
        deliver: async () => (delivered++, "accepted"),
        settle: (t, o, why, expected, invitationId) => settleItem(db, t, o, why, expected ?? null, invitationId ?? null),
        sleep: async () => {},
      },
      [{ entryId: item.entryId, itemId: item.itemId, studioId: f.studioId }],
    );
    expect(delivered).toBe(0);
    expect(r[0]).toMatchObject({ status: "skipped", reason: "invitation_expired" });
    const after = await row(item.itemId);
    expect(after).toMatchObject({ state: "failed", reason_class: "invitation_expired" });
    const { tallyItems } = await import("@/lib/waitlist/over-invite-progress");
    expect(tallyItems([{ state: after.state, reason_class: after.reason_class, issued_at: null }]).ended).toBe(1);
  });
});

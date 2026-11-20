import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";
import { admitBatchItem, claimItems, createBatch, previewSelection, replaceInvitation, settleItem } from "@/lib/waitlist/over-invite-port";
import { runBatchChunk, type DeliveryState, type WorkerDeps } from "@/lib/waitlist/over-invite-worker";
import { retryRefusedDeliveries } from "@/lib/waitlist/over-invite-retry";

// The over-invite port and worker against a REAL database with 0363 applied (owned local stack, synthetic data only). The mail provider is a fake;
// the commands are the real ones. Requires 0363: with it absent every test fails loudly rather than skipping.

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
    claim: (l) => claimItems(db, l),
    admit: (item) => admitBatchItem(db, item, null),
    settle: (t, o, r) => settleItem(db, t, o, r),
    deliver: async (_i, entryId) => (log.push(entryId), deliver(entryId)),
    mayStillSend: async () => true,
    sleep: async () => {},
  };
}
async function drain(d: WorkerDeps) {
  const out = [];
  for (let i = 0; i < 60; i++) {
    const r = await runBatchChunk(d, { perStudio: 5, total: 5, leaseSeconds: 120 });
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
    const retried = await retryRefusedDeliveries(
      {
        replace: (entryId) => replaceInvitation(db, { studioId: f.studioId, actorUserId: f.userId, entryId }),
        deliver: async () => "accepted",
        settle: (t, o, r) => settleItem(db, t, o, r),
        sleep: async () => {},
      },
      [{ entryId: refused!.entryId, itemId: refused!.itemId, studioId: f.studioId }],
    );
    expect(retried[0].status).toBe("sent");
    const live = await q(
      `select count(*)::int c from public.new_client_waitlist_invitations where studio_id=$1 and released_at is null and redeemed_at is null`,
      [f.studioId],
    );
    expect(live[0].c).toBe(3);
  });

  it("a studio's owner cannot batch another studio's entries (isolation)", async () => {
    const a = await seed("f1");
    const b = await seed("f2");
    const foreign = await entries(b, 2);
    const r = await batch(a, foreign, { fit: 0 });
    expect(r.ok && r.result).not.toBe("created");
    expect(await q(`select count(*)::int c from public.waitlist_invitation_batch_items where studio_id=$1`, [a.studioId])).toEqual([{ c: 0 }]);
  });

  it("settle refuses an item named with another studio's id or another entry's id: not_found, and nothing changes", async () => {
    const f = await seed("h1");
    const other = await seed("h2");
    const ids = await entries(f, 2);
    await batch(f, ids, { fit: 0 });
    const claimed = await claimItems(db, { perStudio: 5, total: 5, leaseSeconds: 120 });
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
    const r = await replaceInvitation(db, { studioId: f.studioId, actorUserId: f.userId, entryId: fresh });
    expect(r.ok && r.result).toBe("no_live_invitation");
  });
});

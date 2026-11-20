import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedMember, seedStudio } from "./helpers/harness";

const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => (await adminQuery(text, params)).rows as T[];
afterAll(async () => { await closePool(); });

// 0363 -- over-invite batches, batch-aware admit, atomic replace. Synthetic data, owned local stack. Rehearsed alone and stacked; the first-run helper
// fixes are already in.
// claim_waitlist_batch_items is GLOBAL across studios (it is the worker queue), so every test starts from an empty queue.
async function drainQueue() {
  await q(`update public.waitlist_invitation_batch_items set state='skipped', reason_class='test_cleanup' where state in ('pending','claimed') and invitation_id is null`);
}
async function seed(label: string) {
  await drainQueue();
  const s = await seedStudio(`bt-${label}`);
  const svc = await q<{ id: string }>(`insert into public.services (studio_id,name,default_duration_minutes,active,modality) values ($1,'Consultation',30,true,'consultation') returning id`, [s.studioId]);
  await q(`update auth.users set email_confirmed_at = now() where id = $1`, [s.userId]);
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,200)`, [s.studioId, s.userId]);
  return { studio: s, studioId: s.studioId, userId: s.userId, serviceId: svc[0].id as string, practitionerId: s.practitionerId };
}
type F = Awaited<ReturnType<typeof seed>>;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let n = 0;
async function entries(f: F, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const e = await q(`select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`, [f.studioId, f.userId, `N ${i}`, `bt-${n++}-${f.studioId.slice(0, 8)}@example.com`]);
    ids.push(e[0].entry_id);
  }
  return ids;
}
const create = (f: F, ids: string[], o: { key?: string; fit?: number; shown?: number; confirmed?: boolean; user?: string } = {}) =>
  q(`select * from public.create_waitlist_invitation_batch($1,$2,$3,$4,$5,$6,$7,null,72,$8,$9,$10)`,
    [f.studioId, o.user ?? f.userId, o.key ?? randomUUID(), ids, f.serviceId, day(1), day(30), o.fit ?? 0, o.shown ?? 0, o.confirmed ?? true]);
const claim = (per = 100, total = 1000, lease = 600) => q(`select * from public.claim_waitlist_batch_items($1,$2,$3)`, [per, total, lease]);
const admitItem = (f: F, itemId: string, entryId: string) =>
  q(`select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72,null,$7)`, [f.studioId, f.userId, entryId, f.serviceId, day(1), day(30), itemId]);
const items = (batchId: string) => q(`select * from public.waitlist_invitation_batch_items where batch_id=$1`, [batchId]);

describe("zero capacity: a confirmed batch is governed by its confirmation, not the estimate", () => {
  it("fit 0 with a confirmed batch of 10 issues exactly 10 (even with invitations already outstanding)", async () => {
    const f = await seed("z"); const pre = await entries(f, 3);
    for (const id of pre) { // 3 live invitations first, through a confirmed batch of their own
      const b = await create(f, [id], { fit: 5, shown: pre.indexOf(id) });
      const c = (await claim()).find((r: any) => r.entry_id === id)!;
      expect((await admitItem(f, c.item_id, id))[0].result).toBe("admitted");
      expect(b[0].result).toBe("created");
    }
    const ids = await entries(f, 10);
    const b = await create(f, ids, { fit: 0, shown: 3 });
    expect(b[0]).toMatchObject({ result: "created", quantity: 10, extra_requested: 10 });
    let ok = 0;
    for (const c of (await claim()).filter((r: any) => ids.includes(r.entry_id))) if ((await admitItem(f, c.item_id, c.entry_id))[0].result === "admitted") ok++;
    expect(ok).toBe(10);
  });
  it("exhaustion mid-batch does not skip the remaining confirmed items", async () => {
    const f = await seed("m"); const ids = await entries(f, 6);
    await create(f, ids, { fit: 2, shown: 0 });
    const results = [];
    for (const c of await claim()) results.push((await admitItem(f, c.item_id, c.entry_id))[0].result);
    expect(results.every((r) => r === "admitted")).toBe(true);
  });
  it("the UNCONFIRMED path still refuses with no_capacity, and an unclaimed or foreign item is refused", async () => {
    const f = await seed("u"); const [a, b2] = await entries(f, 2);
    expect((await q(`select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72,0)`, [f.studioId, f.userId, a, f.serviceId, day(1), day(30)]))[0].result).toBe("no_capacity");
    await create(f, [b2], { fit: 0, shown: 0 });
    const item = (await q(`select id from public.waitlist_invitation_batch_items where entry_id=$1`, [b2]))[0].id;
    expect((await admitItem(f, item, b2))[0].result).toBe("batch_item_invalid"); // still pending, never claimed
    expect((await admitItem(f, item, a))[0].result).toBe("batch_item_invalid"); // wrong entry
  });
  it("real guards still refuse a confirmed item: already_invited, owner-review hold", async () => {
    const f = await seed("g"); const [a, b2] = await entries(f, 2);
    await create(f, [a], { fit: 5, shown: 0 }); const ca = (await claim())[0];
    expect((await admitItem(f, ca.item_id, a))[0].result).toBe("admitted");
    await q(`insert into public.waitlist_followups (studio_id, entry_id, kind, status, opened_at) values ($1,$2,'decline','open',now())`, [f.studioId, b2]);
    await create(f, [b2], { fit: 0, shown: 1 }); const cb = (await claim())[0];
    expect((await admitItem(f, cb.item_id, b2))[0].result).toBe("pending_owner_review");
    expect((await items(cb.batch_id))[0].state).toBe("claimed"); // the refusal rolled the item back; the worker settles it skipped
    expect(await q(`select public.settle_waitlist_batch_item($1,$2,$3,'skipped','pending_owner_review') r`, [cb.item_id, f.studioId, b2]).then((r) => r[0].r)).toBe("settled");
  });
});

describe("create: confirmation, idempotency, material change, isolation", () => {
  it("needs explicit confirmation, explicit ids, and is owner-only", async () => {
    const f = await seed("c"); const ids = await entries(f, 2); const m = await seedMember(f.studio, "practitioner");
    expect((await create(f, ids, { confirmed: false }))[0].result).toBe("confirmation_required");
    expect((await create(f, [], {}))[0].result).toBe("invalid_input");
    expect((await create(f, [ids[0], ids[0]], {}))[0].result).toBe("invalid_input");
    expect((await create(f, ids, { user: m.userId }))[0].result).toBe("not_owner");
    expect((await q(`select count(*)::int n from public.waitlist_invitation_batches where studio_id=$1`, [f.studioId]))[0].n).toBe(0);
  });
  it("a RECEPTIONIST and a PRACTITIONER get nothing: create, preview, replace and a batch-item admit are all refused, and nothing is written (Sam: over-invite is owner-only)", async () => {
    const f = await seed("rc"); const [e] = await entries(f, 1); const prac = await seedMember(f.studio, "practitioner");
    const rUser = randomUUID();
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1,$2,now())`, [rUser, `bt-recept-${rUser.slice(0, 8)}@example.com`]);
    await q(`insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1,$2,'Synthetic Receptionist',true)`, [f.studioId, rUser]);
    // the owner confirms a batch and the item is claimed: even a VALID, claimed item cannot be used by anyone but the owner
    await create(f, [e], { fit: 0, shown: 0 }); const c = (await claim())[0];
    const before = (await q(`select count(*)::int n from public.new_client_waitlist_invitations where entry_id=$1`, [e]))[0].n;
    for (const who of [rUser, prac.userId]) {
      expect((await create(f, [e], { user: who }))[0].result, "create").toBe("not_owner");
      expect((await q(`select * from public.preview_waitlist_over_invite($1,$2,$3,$4,$5,null)`, [f.studioId, who, [e], day(1), day(30)]))[0].result, "preview").toBe("not_owner");
      expect((await q(`select * from public.replace_waitlist_invitation($1,$2,$3,(select i.id from public.new_client_waitlist_invitations i where i.entry_id=$3 order by i.issued_at desc limit 1))`, [f.studioId, who, e]))[0].result, "replace").toBe("not_owner");
      const admit = await q(`select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72,null,$7)`, [f.studioId, who, e, f.serviceId, day(1), day(30), c.item_id]);
      expect(admit[0].result, "admit").not.toBe("admitted");
    }
    expect((await q(`select count(*)::int n from public.new_client_waitlist_invitations where entry_id=$1`, [e]))[0].n).toBe(before);
    expect((await q(`select state from public.waitlist_invitation_batch_items where id=$1`, [c.item_id]))[0].state).toBe("claimed");
  });
  it("the same key twice (double click, retry) returns the same batch and creates nothing more; a different payload is key_reused", async () => {
    const f = await seed("k"); const ids = await entries(f, 3); const key = randomUUID();
    const a = await create(f, ids, { key }); const b = await create(f, ids, { key });
    expect(a[0].result).toBe("created"); expect(b[0]).toMatchObject({ result: "exists", batch_id: a[0].batch_id });
    expect((await create(f, ids.slice(0, 2), { key }))[0].result).toBe("key_reused");
    expect((await q(`select count(*)::int n from public.waitlist_invitation_batch_items where studio_id=$1`, [f.studioId]))[0].n).toBe(3);
  });
  it("simultaneous creates with the same key or overlapping entries produce one batch / refuse the overlap", async () => {
    const f = await seed("s"); const ids = await entries(f, 4); const key = randomUUID();
    const r = await Promise.all([create(f, ids, { key }), create(f, ids, { key })]);
    expect(r.map((x) => x[0].result).sort()).toEqual(["created", "exists"]);
    const other = await create(f, [ids[0]], {});
    expect(other[0].result).toBe("entry_in_other_batch");
  });
  it("material_change: a moved live count creates nothing", async () => {
    const f = await seed("x"); const [a, b2] = await entries(f, 2);
    await create(f, [a], { fit: 5, shown: 0 }); const c = (await claim())[0]; await admitItem(f, c.item_id, a);
    const r = await create(f, [b2], { fit: 5, shown: 0 }); // shown 0, but one invitation is now live
    expect(r[0]).toMatchObject({ result: "material_change", live_count: 1 });
    expect((await q(`select count(*)::int n from public.waitlist_invitation_batches where studio_id=$1`, [f.studioId]))[0].n).toBe(1);
  });
  it("studio isolation: another studio's entries are invalid_entries, and its batch is invisible to a studio-scoped read", async () => {
    const f = await seed("i1"); const g = await seed("i2"); const theirs = await entries(g, 1);
    expect((await create(f, theirs, {}))[0].result).toBe("invalid_entries");
  });
});

describe("claim fairness, settle, retry", () => {
  it("one studio cannot take the whole pass: per-studio cap, oldest studio first", async () => {
    const f1 = await seed("f1"); const f2 = await seed("f2");
    await create(f1, await entries(f1, 8), {}); await create(f2, await entries(f2, 8), {});
    const got = await claim(3, 6);
    const by = (id: string) => got.filter((r: any) => r.studio_id === id).length;
    expect(got.length).toBe(6); expect(by(f1.studioId)).toBe(3); expect(by(f2.studioId)).toBe(3);
  });
  it("two workers never claim the same item (skip locked)", async () => {
    const f = await seed("w"); await create(f, await entries(f, 6), {});
    const [a, b2] = await Promise.all([claim(10, 10), claim(10, 10)]);
    const all = [...a, ...b2].map((r: any) => r.item_id);
    expect(new Set(all).size).toBe(all.length); expect(all.length).toBe(6);
  });
  it("a SENT item is terminal: settling again changes nothing; failed can be retried to sent", async () => {
    const f = await seed("t"); const [e1, e2] = await entries(f, 2);
    await create(f, [e1, e2], { fit: 0, shown: 0 }); const cs = await claim();
    for (const c of cs) await admitItem(f, c.item_id, c.entry_id);
    const [c1, c2] = cs;
    expect((await q(`select public.settle_waitlist_batch_item($1,$2,$3,'sent',null,null,(select bi.invitation_id from public.waitlist_invitation_batch_items bi where bi.id=$1)) r`, [c1.item_id, f.studioId, c1.entry_id]))[0].r).toBe("settled");
    expect((await q(`select public.settle_waitlist_batch_item($1,$2,$3,'failed','provider_error',null,(select bi.invitation_id from public.waitlist_invitation_batch_items bi where bi.id=$1)) r`, [c1.item_id, f.studioId, c1.entry_id]))[0].r).toBe("already_sent");
    expect((await q(`select public.settle_waitlist_batch_item($1,$2,$3,'failed','provider_error',null,(select bi.invitation_id from public.waitlist_invitation_batch_items bi where bi.id=$1)) r`, [c2.item_id, f.studioId, c2.entry_id]))[0].r).toBe("settled");
    expect((await q(`select public.settle_waitlist_batch_item($1,$2,$3,'sent',null,null,(select bi.invitation_id from public.waitlist_invitation_batch_items bi where bi.id=$1)) r`, [c2.item_id, f.studioId, c2.entry_id]))[0].r).toBe("settled");
  });
  it("settle refuses an item that does not belong to the studio AND the entry named: not_found, nothing changes; a null studio or entry is invalid_input", async () => {
    const f = await seed("so"); const g = await seed("sp");
    const [e1, e2] = await entries(f, 2);
    await create(f, [e1, e2], { fit: 0, shown: 0 }); const cs = await claim();
    for (const c of cs) await admitItem(f, c.item_id, c.entry_id);
    const [c1, c2] = cs;
    const settle = (item: string, studio: string | null, entry: string | null, outcome = "sent", reason: string | null = null) =>
      q(`select public.settle_waitlist_batch_item($1,$2,$3,$4,$5,null,(select bi.invitation_id from public.waitlist_invitation_batch_items bi where bi.id=$1)) r`, [item, studio, entry, outcome, reason]).then((r) => r[0].r);
    expect(await settle(c1.item_id, g.studioId, c1.entry_id), "another studio's id").toBe("not_found");
    expect(await settle(c1.item_id, f.studioId, c2.entry_id), "another entry in the same studio").toBe("not_found");
    expect(await settle(c1.item_id, null, c1.entry_id), "no studio").toBe("invalid_input");
    expect(await settle(c1.item_id, f.studioId, null), "no entry").toBe("invalid_input");
    expect((await q(`select state from public.waitlist_invitation_batch_items where id=$1`, [c1.item_id]))[0].state, "nothing changed").toBe("issued");
    expect(await settle(c1.item_id, f.studioId, c1.entry_id), "the right pair settles").toBe("settled");
  });
  it("an abandoned claim (admit never ran) is reclaimed after the lease; an issued one never is", async () => {
    const f = await seed("l"); const [e1, e2] = await entries(f, 2);
    await create(f, [e1, e2], { fit: 0, shown: 0 }); const cs = await claim();
    await admitItem(f, cs[0].item_id, cs[0].entry_id);
    await q(`update public.waitlist_invitation_batch_items set claimed_at = now() - interval '1 hour' where studio_id=$1`, [f.studioId]);
    const again = await claim(10, 10, 60);
    expect(again.map((r: any) => r.item_id)).toEqual([cs[1].item_id]);
  });
});

describe("replace", () => {
  it("keeps the live count and queue priority, needs no override, returns a new token once; the old invitation is released", async () => {
    const f = await seed("r"); const [e] = await entries(f, 1);
    await create(f, [e], { fit: 0, shown: 0 }); const c = (await claim())[0]; const a = await admitItem(f, c.item_id, e);
    const before = (await q(`select joined_at from public.new_client_waitlist_entries where id=$1`, [e]))[0].joined_at;
    const live = () => q(`select public.count_waitlist_competing_invitations_internal($1,$2,$3,null) n`, [f.studioId, day(1), day(30)]).catch(() => [{ n: null }]);
    const r = await q(`select * from public.replace_waitlist_invitation($1,$2,$3,(select i.id from public.new_client_waitlist_invitations i where i.entry_id=$3 order by i.issued_at desc limit 1))`, [f.studioId, f.userId, e]);
    expect(r[0].result).toBe("replaced"); expect(r[0].raw_token).toBeTruthy(); expect(r[0].invitation_id).not.toBe(a[0].invitation_id);
    expect((await q(`select released_at from public.new_client_waitlist_invitations where id=$1`, [a[0].invitation_id]))[0].released_at).toBeTruthy();
    expect((await q(`select status, joined_at from public.new_client_waitlist_entries where id=$1`, [e]))[0]).toMatchObject({ status: "invited" });
    expect(new Date((await q(`select joined_at from public.new_client_waitlist_entries where id=$1`, [e]))[0].joined_at).getTime()).toBe(new Date(before).getTime());
    expect((await q(`select count(*)::int n from public.new_client_waitlist_invitations where entry_id=$1 and redeemed_at is null and expired_at is null and released_at is null`, [e]))[0].n).toBe(1);
    void live;
  });
  it("refuses: not owner, no live invitation, a redeemed invitation; and a failed refusal leaves the entry exactly as it was", async () => {
    const f = await seed("rf"); const [e, e2] = await entries(f, 2); const m = await seedMember(f.studio, "practitioner");
    expect((await q(`select * from public.replace_waitlist_invitation($1,$2,$3,(select i.id from public.new_client_waitlist_invitations i where i.entry_id=$3 order by i.issued_at desc limit 1))`, [f.studioId, f.userId, e]))[0].result).toBe("no_live_invitation");
    await create(f, [e], { fit: 0, shown: 0 }); const c = (await claim())[0]; await admitItem(f, c.item_id, e);
    expect((await q(`select * from public.replace_waitlist_invitation($1,$2,$3,(select i.id from public.new_client_waitlist_invitations i where i.entry_id=$3 order by i.issued_at desc limit 1))`, [f.studioId, m.userId, e]))[0].result).toBe("not_owner");
    await q(`alter table public.new_client_waitlist_invitations disable trigger new_client_waitlist_invitations_append_only`);
    await q(`update public.new_client_waitlist_invitations set redeemed_at = now() where entry_id=$1`, [e]);
    await q(`alter table public.new_client_waitlist_invitations enable trigger new_client_waitlist_invitations_append_only`);
    expect((await q(`select * from public.replace_waitlist_invitation($1,$2,$3,(select i.id from public.new_client_waitlist_invitations i where i.entry_id=$3 order by i.issued_at desc limit 1))`, [f.studioId, f.userId, e]))[0].result).toBe("invitation_redeemed");
    expect((await q(`select status from public.new_client_waitlist_entries where id=$1`, [e]))[0].status).toBe("invited");
    void e2;
  });
});

describe("replace, the studio lock and what a claimed item authorises", () => {
  async function liveInvite(f: F, e: string) {
    await create(f, [e], { fit: 0, shown: (await q(`select count(*)::int n from public.new_client_waitlist_invitations where studio_id=$1 and redeemed_at is null and expired_at is null and released_at is null`, [f.studioId]))[0].n });
    const c = (await claim()).find((r: any) => r.entry_id === e)!; await admitItem(f, c.item_id, e); return c;
  }
  const replace = (f: F, e: string) => q(`select * from public.replace_waitlist_invitation($1,$2,$3,(select i.id from public.new_client_waitlist_invitations i where i.entry_id=$3 order by i.issued_at desc limit 1))`, [f.studioId, f.userId, e]).then((r) => r[0]);
  it("simultaneous replaces in one studio never deadlock (repeated), and a replace racing an admit serialises", async () => {
    for (let k = 0; k < 5; k++) {
      const f = await seed(`f1${k}`); const ids = await entries(f, 4);
      for (const e of ids) await liveInvite(f, e);
      const r = await Promise.all(ids.map((e) => replace(f, e)));
      expect(r.map((x: any) => x.result)).toEqual(ids.map(() => "replaced"));
    }
    const f = await seed("f1x"); const [a, b2, c] = await entries(f, 3);
    await liveInvite(f, a); await liveInvite(f, b2);
    const [rep, adm] = await Promise.all([replace(f, a), q(`select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72,1000)`, [f.studioId, f.userId, c, f.serviceId, day(1), day(30)])]);
    expect(rep.result).toBe("replaced"); expect(adm[0].result).toBe("admitted");
  });
  it("the studio lock is taken first (source order pin: studio lock precedes the entry lock in replace)", async () => {
    const src = (await q(`select prosrc from pg_proc where proname='replace_waitlist_invitation'`))[0].prosrc as string;
    expect(src.indexOf("from public.studios")).toBeGreaterThan(-1);
    expect(src.indexOf("from public.studios")).toBeLessThan(src.indexOf("from public.new_client_waitlist_entries"));
  });
  it("replace refuses an inactive service and an open owner-review hold, and changes nothing", async () => {
    const f = await seed("f2"); const [a, b2] = await entries(f, 2); await liveInvite(f, a); await liveInvite(f, b2);
    await q(`insert into public.waitlist_followups (studio_id, entry_id, kind, status, opened_at) values ($1,$2,'decline','open',now())`, [f.studioId, b2]);
    expect((await replace(f, b2)).result).toBe("pending_owner_review");
    await q(`update public.services set active=false where id=$1`, [f.serviceId]);
    expect((await replace(f, a)).result).toBe("invalid_service");
    for (const e of [a, b2]) expect((await q(`select status from public.new_client_waitlist_entries where id=$1`, [e]))[0].status).toBe("invited");
  });
  it("a FULL admission round does not block a replace: it rotates as admit does, and the replace succeeds", async () => {
    const f = await seed("rf"); const [a, b2] = await entries(f, 2);
    await liveInvite(f, a); await liveInvite(f, b2);
    await q(`update public.studio_waitlist_admission_rounds set allowance = 1 where studio_id = $1 and closed_at is null`, [f.studioId]);
    const r = await replace(f, a);
    expect(r.result).toBe("replaced");
    const open = await q(`select count(*)::int n from public.studio_waitlist_admission_rounds where studio_id = $1 and closed_at is null`, [f.studioId]);
    expect(open[0].n, "exactly one open round after the rotation").toBe(1);
  });
  it("a replace refusal carries only a code from the closed set (no open round: refused:no_round_open), and the mapping is a closed set in the source", async () => {
    const f = await seed("rc"); const [a] = await entries(f, 1);
    await liveInvite(f, a);
    await q(`update public.studio_waitlist_admission_rounds set closed_at = clock_timestamp(), closed_by_practitioner_id = $2, updated_at = clock_timestamp() where studio_id = $1 and closed_at is null`, [f.studioId, f.practitionerId]);
    const r = await replace(f, a);
    expect(r.result).toBe("refused:no_round_open");
    const src = (await q(`select prosrc from pg_proc where proname='replace_waitlist_invitation'`))[0].prosrc as string;
    expect(src).toContain("'refused:other'");
    expect(src).not.toMatch(/'refused:'\s*\|\|\s*SQLERRM\)::text/);
    expect(src).toMatch(/SQLERRM = any \(array\[/);
  });
  it("settle refuses a reason class that is not a closed lowercase shape, as invalid_input, before anything is written", async () => {
    const f = await seed("sr"); const [e1] = await entries(f, 1);
    await create(f, [e1], { fit: 0, shown: 0 }); const [c1] = await claim();
    await admitItem(f, c1.item_id, c1.entry_id);
    const settle = (reason: string) => q(`select public.settle_waitlist_batch_item($1,$2,$3,'failed',$4,null,(select bi.invitation_id from public.waitlist_invitation_batch_items bi where bi.id=$1)) r`, [c1.item_id, f.studioId, c1.entry_id, reason]).then((r) => r[0].r);
    for (const bad of ["Provider Error", "someone@example.com", "x".repeat(41), "has space", ""]) expect(await settle(bad), bad).toBe("invalid_input");
    expect((await q(`select state, reason_class from public.waitlist_invitation_batch_items where id=$1`, [c1.item_id]))[0]).toMatchObject({ state: "issued", reason_class: null });
    expect(await settle("provider_error")).toBe("settled");
  });
  it("a create replay with different weekdays or TTL is key_reused, not exists", async () => {
    const f = await seed("cw"); const [e1] = await entries(f, 1); const key = randomUUID();
    const mk = (wd: number[] | null, ttl: number) => q(`select * from public.create_waitlist_invitation_batch($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,true)`, [f.studioId, f.userId, key, [e1], f.serviceId, day(1), day(30), wd, ttl]);
    expect((await mk(null, 72))[0].result).toBe("created");
    expect((await mk(null, 72))[0].result).toBe("exists");
    expect((await mk([1, 2], 72))[0].result, "different weekdays").toBe("key_reused");
    expect((await mk(null, 48))[0].result, "different ttl").toBe("key_reused");
  });
  it("the two batch tables carry EXACTLY the reviewed columns (an allowlist: any new column, such as a recipient, fails here until it is reviewed)", async () => {
    const cols = async (t: string) => (await q(`select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by column_name`, [t])).map((c: any) => c.column_name);
    expect(await cols("waitlist_invitation_batches")).toEqual(
      ["allowed_weekdays","batch_key","confirmed_at","confirmed_by_practitioner_id","confirmed_by_user_id","end_date","extra_requested","fit_shown","id","live_shown","quantity","service_id","start_date","studio_id","ttl_hours"]);
    expect(await cols("waitlist_invitation_batch_items")).toEqual(
      ["attempts","batch_id","claimed_at","entry_id","id","invitation_id","issued_at","reason_class","settled_at","state","studio_id"]);
  });
  it("UNKNOWN is distinct from failed: issued -> unknown needs a reason, is never claimed again, blocks a new batch for the entry, and only a later sent or failed moves it on", async () => {
    const f = await seed("uk"); const [e1] = await entries(f, 1);
    await create(f, [e1], { fit: 0, shown: 0 }); const [c1] = await claim(); await admitItem(f, c1.item_id, e1);
    const st = (o: string, r: string | null) => q(`select public.settle_waitlist_batch_item($1,$2,$3,$4,$5,null,(select bi.invitation_id from public.waitlist_invitation_batch_items bi where bi.id=$1)) r`, [c1.item_id, f.studioId, e1, o, r]).then((x) => x[0].r);
    const state = async () => (await q(`select state from public.waitlist_invitation_batch_items where id=$1`, [c1.item_id]))[0].state;
    expect(await st("unknown", null)).toBe("invalid_state");
    expect(await st("unknown", "timeout")).toBe("settled"); expect(await state()).toBe("unknown");
    expect(await claim(100, 1000, 5)).toHaveLength(0);
    const again = await create(f, [e1], { fit: 0, shown: 0 }); expect(again[0].result).toBe("entry_in_other_batch");
    expect(await st("sent", null)).toBe("settled"); expect(await state()).toBe("sent");
  });
  it("an issued item nobody settled within the lease becomes unknown on the next claim, and is not handed out", async () => {
    const f = await seed("us"); const [e1] = await entries(f, 1);
    await create(f, [e1], { fit: 0, shown: 0 }); const [c1] = await claim(); await admitItem(f, c1.item_id, e1);
    await q(`update public.waitlist_invitation_batch_items set issued_at = now() - interval '1 hour' where id=$1`, [c1.item_id]);
    expect(await claim(100, 1000, 60)).toHaveLength(0);
    expect((await q(`select state, reason_class from public.waitlist_invitation_batch_items where id=$1`, [c1.item_id]))[0]).toMatchObject({ state: "unknown", reason_class: "delivery_unconfirmed" });
  });
  it("two overlapping claims with many expired issued items never deadlock, and every item becomes unknown exactly once", async () => {
    for (let k = 0; k < 3; k++) {
      const f = await seed(`dl${k}`); const ids = await entries(f, 12);
      const b = await create(f, ids, { fit: 0, shown: 0 });
      for (const c of await claim(100, 1000)) await admitItem(f, c.item_id, c.entry_id);
      await q(`update public.waitlist_invitation_batch_items set issued_at = now() - interval '1 hour' where batch_id=$1`, [b[0].batch_id]);
      const r = await Promise.all([claim(100, 1000, 60), claim(100, 1000, 60), claim(100, 1000, 60)]);
      expect(r.every((x: any) => x.length === 0)).toBe(true);
      const rows = await items(b[0].batch_id);
      expect(rows.every((x: any) => x.state === "unknown")).toBe(true);
    }
  });
  it("two concurrent replaces of the same item: exactly one applies, the other answers state_changed and changes nothing", async () => {
    for (let k = 0; k < 4; k++) {
      const f = await seed(`rr${k}`); const [e1] = await entries(f, 1); await liveInvite(f, e1);
      const seen = (await q(`select id from public.new_client_waitlist_invitations where entry_id=$1 order by issued_at desc limit 1`, [e1]))[0].id;
      const call = () => q(`select * from public.replace_waitlist_invitation($1,$2,$3,$4)`, [f.studioId, f.userId, e1, seen]).then((r) => r[0].result);
      const r = await Promise.all([call(), call()]);
      expect([...r].sort(), `run ${k}`).toEqual(["replaced", "state_changed"]);
      expect((await q(`select count(*)::int n from public.new_client_waitlist_invitations where entry_id=$1`, [e1]))[0].n, "only ONE new invitation").toBe(2);
    }
    const f = await seed("rn"); const [e2] = await entries(f, 1); await liveInvite(f, e2);
    expect((await q(`select * from public.replace_waitlist_invitation($1,$2,$3,null)`, [f.studioId, f.userId, e2]))[0].result, "null expected never matches").toBe("state_changed");
  });
  it("settle with an expected state applies only if the item is still in it; two concurrent settles: one settled, one state_changed", async () => {
    const f = await seed("se"); const [e1] = await entries(f, 1);
    await create(f, [e1], { fit: 0, shown: 0 }); const [c1] = await claim(); await admitItem(f, c1.item_id, e1);
    const st = (o: string, r: string | null, exp: string | null) => q(`select public.settle_waitlist_batch_item($1,$2,$3,$4,$5,$6,(select bi.invitation_id from public.waitlist_invitation_batch_items bi where bi.id=$1)) r`, [c1.item_id, f.studioId, e1, o, r, exp]).then((x) => x[0].r);
    expect(await st("failed", "provider_error", "claimed"), "stale expectation").toBe("state_changed");
    expect((await q(`select state from public.waitlist_invitation_batch_items where id=$1`, [c1.item_id]))[0].state).toBe("issued");
    const r = await Promise.all([st("failed", "provider_error", "issued"), st("failed", "provider_error", "issued")]);
    expect([...r].sort()).toEqual(["settled", "state_changed"]);
  });
  it("a SCOPED claim takes only its own batch for its own owner and never claims or leases a foreign item; a null claim stays fair across studios", async () => {
    const f = await seed("sc1"); const g = await seed("sc2");
    const fe = await entries(f, 3); const ge = await entries(g, 3);
    const fb = await create(f, fe, { fit: 0, shown: 0 }); const gb = await create(g, ge, { fit: 0, shown: 0 });
    const scoped = (batch: string, user: string | null, per = 100) => q(`select * from public.claim_waitlist_batch_items($1,1000,600,$2,$3)`, [per, batch, user]);
    expect(await scoped(fb[0].batch_id, g.userId), "another studio's owner").toHaveLength(0);
    expect(await scoped(fb[0].batch_id, null), "no actor").toHaveLength(0);
    expect(await scoped(randomUUID(), f.userId), "unknown batch").toHaveLength(0);
    const mine = await scoped(fb[0].batch_id, f.userId);
    expect(mine).toHaveLength(3); expect(mine.every((r: any) => r.studio_id === f.studioId && r.batch_id === fb[0].batch_id)).toBe(true);
    const foreign = await items(gb[0].batch_id);
    expect(foreign.every((r: any) => r.state === "pending" && r.claimed_at === null), "the other studio's items were not touched").toBe(true);
    const rest = await claim(1, 1000);
    expect(rest).toHaveLength(1); expect(rest[0].studio_id).toBe(g.studioId);
  });
  it("a null claim stays round-robin: each studio is served up to p_per_studio before any gets more", async () => {
    const f = await seed("rr1"); const g = await seed("rr2");
    await create(f, await entries(f, 4), { fit: 0, shown: 0 }); await create(g, await entries(g, 4), { fit: 0, shown: 0 });
    const got = await claim(2, 4);
    expect(got).toHaveLength(4);
    expect(new Set(got.map((r: any) => r.studio_id)).size).toBe(2);
    for (const sid of [f.studioId, g.studioId]) expect(got.filter((r: any) => r.studio_id === sid)).toHaveLength(2);
  });
  it("a DECLINED, unexpired invitation no longer excludes its person from a new batch; a failed item with no invitation holds nothing", async () => {
    const f = await seed("dc"); const [a, b2] = await entries(f, 2);
    await liveInvite(f, a); await liveInvite(f, b2);
    await q(`update public.new_client_waitlist_invitations set declined_at = now() where entry_id=$1`, [a]);
    await q(`update public.new_client_waitlist_entries set status = 'waiting' where id=$1`, [a]).catch(() => undefined);
    const live = (await q(`select count(*)::int n from public.new_client_waitlist_invitations where studio_id=$1 and redeemed_at is null and expired_at is null and released_at is null and declined_at is null and expires_at > now()`, [f.studioId]))[0].n;
    expect((await create(f, [a], { fit: 0, shown: live }))[0].result, "declined: re-inviteable").toBe("created");
    expect((await create(f, [b2], { fit: 0, shown: live }))[0].result, "live: still blocked").toBe("entry_in_other_batch");
    const [e3] = await entries(f, 1);
    await q(`insert into public.waitlist_invitation_batches (studio_id, batch_key, confirmed_by_practitioner_id, confirmed_by_user_id, quantity, extra_requested, fit_shown, live_shown, service_id, start_date, end_date, ttl_hours) values ($1,$2,$3,$4,1,0,0,0,$5,$6,$7,72)`, [f.studioId, randomUUID(), f.practitionerId, f.userId, f.serviceId, day(1), day(30)]);
    const bid = (await q(`select id from public.waitlist_invitation_batches where studio_id=$1 order by confirmed_at desc limit 1`, [f.studioId]))[0].id;
    await q(`insert into public.waitlist_invitation_batch_items (batch_id, studio_id, entry_id, state) values ($1,$2,$3,'failed')`, [bid, f.studioId, e3]);
    expect((await create(f, [e3], { fit: 0, shown: live }))[0].result, "a null-invitation failed item holds nothing").toBe("created");
  });
  it("preview counts an entry whose invitation was DECLINED (back to waiting, invitation unexpired) as admissible, and one with a LIVE invitation as not", async () => {
    const f = await seed("pv"); const [a, b2] = await entries(f, 2);
    await liveInvite(f, b2);
    await create(f, [a], { fit: 0, shown: 1 }); const c = (await claim()).find((r: any) => r.entry_id === a)!;
    const adm = await admitItem(f, c.item_id, a); expect(adm[0].result).toBe("admitted");
    const proof = await q(`select * from public.begin_waitlist_invitation_proof($1,20)`, [adm[0].raw_token]);
    const cap = await q(`select * from public.complete_waitlist_invitation_proof($1,$2)`, [adm[0].raw_token, proof[0].raw_challenge]);
    const d = await q(`select result from public.decline_new_client_waitlist_invitation($1,$2)`, [adm[0].raw_token, cap[0].raw_capability]);
    expect(d[0].result).toBe("declined");
    // The decline opens an owner follow-up, which holds the person until handled; handle it so only the invitation state decides.
    await q(`update public.waitlist_followups set status = 'handled', closed_at = now() where entry_id=$1 and status = 'open'`, [a]);
    expect((await q(`select public.requeue_new_client_waitlist_entry($1,$2,$3) r`, [f.studioId, a, f.userId]))[0].r).toBe("requeued");
    const inv = (await q(`select declined_at, released_at, expired_at, expires_at > now() as unexpired from public.new_client_waitlist_invitations where entry_id=$1 order by issued_at desc limit 1`, [a]))[0];
    expect(inv.declined_at).not.toBeNull(); expect(inv.released_at, "declined only, not released").toBeNull(); expect(inv.expired_at).toBeNull(); expect(inv.unexpired).toBe(true);
    const p = (await q(`select * from public.preview_waitlist_over_invite($1,$2,$3,$4,$5,null)`, [f.studioId, f.userId, [a, b2], day(1), day(30)]))[0];
    expect(p.selected).toBe(2); expect(p.admissible, "declined admissible, live not").toBe(1);
  });
  it("stop takes the studio lock before it changes any item (source order pin)", async () => {
    const src = (await q(`select prosrc from pg_proc where proname='stop_waitlist_batch'`))[0].prosrc as string;
    const lock = src.indexOf("from public.studios"); const upd = src.indexOf("update public.waitlist_invitation_batch_items");
    expect(lock).toBeGreaterThan(-1); expect(src.slice(lock, lock + 80)).toContain("for no key update");
    expect(lock).toBeLessThan(upd);
  });
  it("a LATE settle for the old invitation after a replace changes nothing: the replacement is never marked sent by the old delivery", async () => {
    const f = await seed("ls"); const [e1] = await entries(f, 1); const c = await liveInvite(f, e1);
    const inv = async () => (await q(`select invitation_id from public.waitlist_invitation_batch_items where id=$1`, [c.item_id]))[0].invitation_id as string;
    const oldInv = await inv();
    expect((await q(`select * from public.replace_waitlist_invitation($1,$2,$3,$4)`, [f.studioId, f.userId, e1, oldInv]))[0].result).toBe("replaced");
    const newInv = await inv(); expect(newInv).not.toBe(oldInv);
    const st = (o: string, r: string | null, expInv: string | null) => q(`select public.settle_waitlist_batch_item($1,$2,$3,$4,$5,null,$6) r`, [c.item_id, f.studioId, e1, o, r, expInv]).then((x) => x[0].r);
    expect(await st("sent", null, oldInv), "the OLD delivery").toBe("state_changed");
    expect(await st("sent", null, null), "no invitation named").toBe("state_changed");
    expect((await q(`select state from public.waitlist_invitation_batch_items where id=$1`, [c.item_id]))[0].state).toBe("issued");
    expect(await st("sent", null, newInv), "the replacement's own delivery").toBe("settled");
  });
  it("the batch exclusion ends with the invitation: a released and requeued person can be invited in a new batch, a live one still cannot", async () => {
    const f = await seed("ex"); const [a, b2] = await entries(f, 2);
    await liveInvite(f, a); await liveInvite(f, b2);
    expect((await create(f, [b2], { fit: 0, shown: 2 }))[0].result, "a LIVE invitation still blocks").toBe("entry_in_other_batch");
    expect((await q(`select public.release_new_client_waitlist_entry($1,$2,$3) r`, [f.studioId, a, f.userId]))[0].r).toBe("released");
    expect((await q(`select public.requeue_new_client_waitlist_entry($1,$2,$3) r`, [f.studioId, a, f.userId]))[0].r).toBe("requeued");
    const live = (await q(`select count(*)::int n from public.new_client_waitlist_invitations where studio_id=$1 and redeemed_at is null and expired_at is null and released_at is null and expires_at > now()`, [f.studioId]))[0].n;
    const again = await create(f, [a], { fit: 0, shown: live });
    expect(again[0].result, "the requeued person can be invited again").toBe("created");
    const st = (await q(`select state, reason_class from public.waitlist_invitation_batch_items where entry_id=$1 order by state`, [a]));
    expect(st.map((x: any) => x.state).sort()).toEqual(["pending", "skipped"]);
    expect(st.find((x: any) => x.state === "skipped").reason_class).toBe("invitation_ended");
  });
  it("stop: owner-only, moves PENDING items to skipped, never touches claimed or issued, idempotent", async () => {
    const f = await seed("cn"); const g = await seed("co"); const [e1, e2, e3] = await entries(f, 3);
    const b = await create(f, [e1, e2, e3], { fit: 0, shown: 0 }); const batch = b[0].batch_id;
    const [c1] = await claim(1, 1); await admitItem(f, c1.item_id, c1.entry_id);
    const cancel = (studio: string, user: string, id: string) => q(`select * from public.stop_waitlist_batch($1,$2,$3,600)`, [studio, user, id]).then((r) => r[0]);
    expect((await cancel(g.studioId, g.userId, batch)).result, "another studio's owner").toBe("not_found");
    expect((await cancel(f.studioId, randomUUID(), batch)).result, "not an owner").toBe("not_owner");
    expect(await cancel(f.studioId, f.userId, batch)).toMatchObject({ result: "stopped", cancelled: 2 });
    const st = await q(`select state, reason_class from public.waitlist_invitation_batch_items where batch_id=$1 order by state`, [batch]);
    expect(st.filter((r: any) => r.state === "skipped")).toHaveLength(2);
    expect(st.every((r: any) => r.state !== "skipped" || r.reason_class === "owner_stopped")).toBe(true);
    expect(st.find((r: any) => r.state === "issued"), "the issued item is untouched").toBeTruthy();
    expect(await cancel(f.studioId, f.userId, batch)).toMatchObject({ result: "nothing_pending", cancelled: 0 });
    expect(await claim()).toHaveLength(0);
  });
  it("stop also stops a lease-expired claim that has no invitation, but not one still inside its lease", async () => {
    const f = await seed("sl"); const [e1, e2] = await entries(f, 2);
    const b = await create(f, [e1, e2], { fit: 0, shown: 0 }); const cs = await claim();
    await q(`update public.waitlist_invitation_batch_items set claimed_at = now() - interval '1 hour' where id=$1`, [cs[0].item_id]);
    const r = (await q(`select * from public.stop_waitlist_batch($1,$2,$3,600)`, [f.studioId, f.userId, b[0].batch_id]))[0];
    expect(r).toMatchObject({ result: "stopped", cancelled: 1 });
    const st = Object.fromEntries((await items(b[0].batch_id)).map((x: any) => [x.id, x.state]));
    expect(st[cs[0].item_id]).toBe("skipped"); expect(st[cs[1].item_id]).toBe("claimed");
  });
  it("stop racing a claim: every item is either claimed or cancelled, never both, never lost", async () => {
    for (let k = 0; k < 5; k++) {
      const f = await seed(`cr${k}`); const ids = await entries(f, 6);
      const b = await create(f, ids, { fit: 0, shown: 0 });
      const [claimed, cancelled] = await Promise.all([claim(100, 1000), q(`select * from public.stop_waitlist_batch($1,$2,$3,600)`, [f.studioId, f.userId, b[0].batch_id])]);
      const rows = await items(b[0].batch_id);
      const nClaimed = rows.filter((r: any) => r.state === "claimed").length, nSkipped = rows.filter((r: any) => r.state === "skipped").length;
      expect(nClaimed + nSkipped).toBe(6); expect(claimed.length).toBe(nClaimed); expect(cancelled[0].cancelled).toBe(nSkipped);
    }
  });
  it("a claimed item authorises only what the batch stored: another service, window, weekdays or TTL is batch_item_invalid and the item stays claimed", async () => {
    const f = await seed("f3"); const other = await q(`insert into public.services (studio_id,name,default_duration_minutes,active,modality) values ($1,'Other',30,true,'consultation') returning id`, [f.studioId]);
    const ids = await entries(f, 5); await create(f, ids, { fit: 0, shown: 0 });
    const cs = await claim(); const by = (i: number) => cs.find((r: any) => r.entry_id === ids[i])!;
    const call = (i: number, svc: string, s1: string, e1: string, wd: any, ttl: number) =>
      q(`select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,$7,$8,null,$9)`, [f.studioId, f.userId, ids[i], svc, s1, e1, wd, ttl, by(i).item_id]).then((r) => r[0].result);
    expect(await call(0, other[0].id, day(1), day(30), null, 72)).toBe("batch_item_invalid");
    expect(await call(1, f.serviceId, day(2), day(30), null, 72)).toBe("batch_item_invalid");
    expect(await call(2, f.serviceId, day(1), day(29), null, 72)).toBe("batch_item_invalid");
    expect(await call(3, f.serviceId, day(1), day(30), [1, 2], 72)).toBe("batch_item_invalid");
    expect(await call(4, f.serviceId, day(1), day(30), null, 48)).toBe("batch_item_invalid");
    for (const c of cs) expect((await items(c.batch_id)).find((x: any) => x.id === c.item_id).state).toBe("claimed");
    expect(await call(0, f.serviceId, day(1), day(30), null, 72)).toBe("admitted");
  });
});

describe("grants, rollback shape, one admit overload", () => {
  it("every new function is service_role only; the tables allow owner SELECT only; exactly one admit overload exists", async () => {
    for (const fn of ["create_waitlist_invitation_batch(uuid,uuid,uuid,uuid[],uuid,date,date,smallint[],integer,integer,integer,boolean)", "preview_waitlist_over_invite(uuid,uuid,uuid[],date,date,smallint[])", "claim_waitlist_batch_items(integer,integer,integer,uuid,uuid)", "settle_waitlist_batch_item(uuid,uuid,uuid,text,text,text,uuid)", "replace_waitlist_invitation(uuid,uuid,uuid,uuid)"]) {
      const r = await q(`select has_function_privilege('anon','public.${fn}','execute') a, has_function_privilege('authenticated','public.${fn}','execute') u, has_function_privilege('service_role','public.${fn}','execute') s`);
      expect(r[0]).toEqual({ a: false, u: false, s: true });
    }
    const t = await q(`select has_table_privilege('authenticated','public.waitlist_invitation_batches','insert') i, has_table_privilege('service_role','public.waitlist_invitation_batches','insert') si`);
    expect(t[0]).toEqual({ i: false, si: false });
    expect((await q(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and p.proname='admit_new_client_waitlist_entry'`))[0].n).toBe(1);
  });
});

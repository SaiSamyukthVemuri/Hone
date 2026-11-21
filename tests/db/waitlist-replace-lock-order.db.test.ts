import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { adminQuery, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";

const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => (await adminQuery(text, params)).rows as T[];
afterAll(async () => { await closePool(); });

// replace_waitlist_invitation: the round is locked first (no deadlock with redemption), a replace is for a LIVE invitation only, and a replaced item starts a new attempt.
// Synthetic data, owned local stack.
// DEFENSIVE CASE: the three ended-stamp tests insert an invitation that carries a stamp while its entry reads 'invited'. The real release, decline and expire commands move the entry out of 'invited'
// in the same transaction, so this state is unreachable through the application's own commands; the refusal is defence in depth and the tests prove it holds if the state ever arises.
// Fixture states are reached WITHOUT touching the append-only guard on the invitation table (nothing is disabled or bypassed): a row is INSERTed in the state under test (the guard
// is an UPDATE guard), and the entry is moved to 'invited' the way the issue command moves it. The elapsed invitation is inserted with its window already in the past, the
// stamped (ended) one with its stamp set at insert, and the legacy one without a round, so no column is ever changed after the fact.
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let n = 0;
async function seedLive() {
  await q(`update public.waitlist_invitation_batch_items set state='skipped', reason_class='test_cleanup' where state in ('pending','claimed') and invitation_id is null`);
  const s = await seedStudio(`rl-${n++}`);
  const svc = await q<{ id: string }>(`insert into public.services (studio_id,name,default_duration_minutes,active,modality) values ($1,'Consultation',30,true,'consultation') returning id`, [s.studioId]);
  await q(`update auth.users set email_confirmed_at = now() where id = $1`, [s.userId]);
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,200)`, [s.studioId, s.userId]);
  const e = await q(`select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`, [s.studioId, s.userId, "Live One", `rl-${n}-${s.studioId.slice(0, 8)}@example.com`]);
  const entryId = e[0].entry_id as string;
  await q(`select * from public.create_waitlist_invitation_batch($1,$2,$3,$4,$5,$6,$7,null,72,5,0,true)`, [s.studioId, s.userId, randomUUID(), [entryId], svc[0].id, day(1), day(30)]);
  const c = (await q(`select * from public.claim_waitlist_batch_items(100,1000,600)`)).find((r: any) => r.entry_id === entryId)!;
  const a = await q(`select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72,null,$7)`, [s.studioId, s.userId, entryId, svc[0].id, day(1), day(30), c.item_id]);
  expect(a[0].result).toBe("admitted");
  const inv = (await q(`select id, admission_round_id from public.new_client_waitlist_invitations where entry_id = $1 order by issued_at desc limit 1`, [entryId]))[0];
  return { studioId: s.studioId as string, userId: s.userId as string, entryId, invId: inv.id as string, roundId: inv.admission_round_id as string | null };
}
type L = Awaited<ReturnType<typeof seedLive>>;
type Inserted = { issuedHoursAgo?: number; expiresInHours?: number; withRound?: boolean; stamp?: "expired_at" | "released_at" | "declined_at" };
async function seedInserted(o: Inserted = {}): Promise<L> {
  const s = await seedStudio(`rl-${n++}`);
  const svc = await q<{ id: string }>(`insert into public.services (studio_id,name,default_duration_minutes,active,modality) values ($1,'Consultation',30,true,'consultation') returning id`, [s.studioId]);
  await q(`update auth.users set email_confirmed_at = now() where id = $1`, [s.userId]);
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,200)`, [s.studioId, s.userId]);
  const roundId = (await q<{ id: string }>(`select id from public.studio_waitlist_admission_rounds where studio_id = $1 and closed_at is null`, [s.studioId]))[0].id;
  const e = await q(`select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`, [s.studioId, s.userId, "Inserted One", `ri-${n}-${s.studioId.slice(0, 8)}@example.com`]);
  const entryId = e[0].entry_id as string;
  const claimed = await q(`select public.claim_new_client_waitlist_entry($1,$2,$3) as r`, [s.studioId, entryId, s.userId]);
  expect(claimed[0].r).toBe("claimed");
  const ago = o.issuedHoursAgo ?? 0; const inH = o.expiresInHours ?? 72;
  const stampSql = o.stamp ? `, ${o.stamp}` : ""; const stampVal = o.stamp ? `, now()` : "";
  const inv = await q<{ id: string }>(
    `insert into public.new_client_waitlist_invitations (studio_id, entry_id, token_hash, issued_at, expires_at, issued_by_practitioner_id, scope_service_id, scope_start_date, scope_end_date, admission_round_id${stampSql})
     values ($1,$2, encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'), now() - make_interval(hours => $3::int), now() + make_interval(hours => $4::int), $5, $6, $7, $8, $9${stampVal}) returning id`,
    [s.studioId, entryId, ago, inH, s.practitionerId, svc[0].id, day(1), day(30), o.withRound === false ? null : roundId]);
  await q(`update public.new_client_waitlist_entries set status = 'invited', invited_at = now() - make_interval(hours => $3::int) where id = $1 and studio_id = $2 and status = 'claimed'`, [entryId, s.studioId, ago]);
  return { studioId: s.studioId as string, userId: s.userId as string, entryId, invId: inv[0].id, roundId: o.withRound === false ? null : roundId };
}
const replace = (l: L, expected: string = l.invId) =>
  q(`select * from public.replace_waitlist_invitation($1,$2,$3,$4)`, [l.studioId, l.userId, l.entryId, expected]);

describe("a replace is for a LIVE invitation only", () => {
  it("an invitation whose time has run out (status still invited) is refused: invitation_expired, nothing written, no new invitation", async () => {
    const l = await seedInserted({ issuedHoursAgo: 72, expiresInHours: -1 }); // issued three days ago, ran out an hour ago, never swept
    const before = await q(`select count(*)::int n from public.new_client_waitlist_invitations where entry_id = $1`, [l.entryId]);
    const r = await replace(l);
    expect(r[0].result).toBe("invitation_expired");
    expect(r[0].raw_token).toBeNull();
    expect((await q(`select count(*)::int n from public.new_client_waitlist_invitations where entry_id = $1`, [l.entryId]))[0].n).toBe(before[0].n);
    expect((await q(`select status from public.new_client_waitlist_entries where id = $1`, [l.entryId]))[0].status).toBe("invited");
    expect((await q(`select released_at from public.new_client_waitlist_invitations where id = $1`, [l.invId]))[0].released_at).toBeNull();
  });
  for (const col of ["expired_at", "released_at", "declined_at"] as const) {
    it(`defensive: an invitation stamped ${col} (a state the application's own commands never leave behind: they move the entry out of invited) is refused: invitation_ended, nothing written`, async () => {
      const l = await seedInserted({ stamp: col }); // an invitation carrying the stamp while its entry reads invited
      const r = await replace(l);
      expect(r[0].result).toBe("invitation_ended");
      expect((await q(`select count(*)::int n from public.new_client_waitlist_invitations where entry_id = $1`, [l.entryId]))[0].n).toBe(1);
    });
  }
  it("a LIVE invitation still replaces (the live count is unchanged)", async () => {
    const l = await seedLive();
    const live = async () => (await q(`select count(*)::int n from public.new_client_waitlist_invitations where studio_id = $1 and redeemed_at is null and expired_at is null and released_at is null and declined_at is null and expires_at > clock_timestamp()`, [l.studioId]))[0].n;
    const before = await live();
    const r = await replace(l);
    expect(r[0].result).toBe("replaced");
    expect(await live()).toBe(before);
  });
});

// Two sessions. D takes redemption's lock order on the same invitation (the invitation's round FOR UPDATE, then the invitation FOR UPDATE) while R replaces
// it. In the previous body R held the invitation (inside release) and waits for the round while D holds the round and waits for the invitation: a deadlock (40P01).
// Now R takes the round right after the studio, so it waits BEFORE touching the entry or the invitation and D gets the invitation.
describe("a replace and a redemption on one invitation never deadlock", () => {
  it("D holds the round, R (replace) starts, D then takes the invitation: no 40P01, D proceeds, R completes after D commits", async () => {
    const l = await seedLive();
    expect(l.roundId, "the invitation is bound to an admission round").toBeTruthy();
    const url = resolveLocalDbUrl();
    const D = new pg.Client({ connectionString: url });
    const R = new pg.Client({ connectionString: url });
    await D.connect(); await R.connect();
    try {
      await D.query("begin");
      await D.query(`select 1 from public.studio_waitlist_admission_rounds where id = $1 for update`, [l.roundId]);
      const rPromise = R.query(`select * from public.replace_waitlist_invitation($1,$2,$3,$4)`, [l.studioId, l.userId, l.entryId, l.invId]).then(
        (res) => ({ ok: true as const, res }), (err) => ({ ok: false as const, err }));
      await new Promise((r) => setTimeout(r, 1500)); // R is now waiting (now: on the round, before touching the invitation; previously: on the round while holding the invitation)
      let dErr: any = null;
      try { await D.query(`select 1 from public.new_client_waitlist_invitations where id = $1 for update`, [l.invId]); } catch (e) { dErr = e; }
      expect(dErr?.code, "redemption's second lock must not deadlock").toBeUndefined();
      await D.query("commit");
      const out = await rPromise;
      if (!out.ok) expect((out.err as any).code, "the replace must not fail with a deadlock").not.toBe("40P01");
      expect(out.ok && out.res.rows[0].result).toBe("replaced");
    } finally {
      try { await D.query("rollback"); } catch { /* already ended */ }
      await D.end(); await R.end();
    }
  }, 30_000);
});

describe("lock order with the other takers", () => {
  it("a legacy invitation (no round) and a redemption-style invitation lock: no deadlock, the replace completes after the lock is released", async () => {
    const l = await seedInserted({ withRound: false }); // a pre-0192 style invitation: redemption locks only the invitation
    const url = resolveLocalDbUrl();
    const D = new pg.Client({ connectionString: url }); const R = new pg.Client({ connectionString: url });
    await D.connect(); await R.connect();
    try {
      await D.query("begin");
      await D.query(`select 1 from public.new_client_waitlist_invitations where id = $1 for update`, [l.invId]);
      const rp = R.query(`select * from public.replace_waitlist_invitation($1,$2,$3,$4)`, [l.studioId, l.userId, l.entryId, l.invId]).then((res) => ({ ok: true as const, res }), (err) => ({ ok: false as const, err }));
      await new Promise((r) => setTimeout(r, 1500));
      await D.query("commit");
      const out = await rp;
      if (!out.ok) expect((out.err as any).code).not.toBe("40P01");
      expect(out.ok && out.res.rows[0].result).toBe("replaced");
    } finally { try { await D.query("rollback"); } catch { /* ended */ } await D.end(); await R.end(); }
  }, 30_000);
  it("entry-then-invitation takers (release, decline, expire) are not inverted: D holds the entry and asks for the invitation while a replace is waiting: no 40P01", async () => {
    const l = await seedLive();
    const url = resolveLocalDbUrl();
    const D = new pg.Client({ connectionString: url }); const R = new pg.Client({ connectionString: url });
    await D.connect(); await R.connect();
    try {
      await D.query("begin");
      await D.query(`select 1 from public.new_client_waitlist_entries where id = $1 for update`, [l.entryId]);
      const rp = R.query(`select * from public.replace_waitlist_invitation($1,$2,$3,$4)`, [l.studioId, l.userId, l.entryId, l.invId]).then((res) => ({ ok: true as const, res }), (err) => ({ ok: false as const, err }));
      await new Promise((r) => setTimeout(r, 1500));
      let dErr: any = null;
      try { await D.query(`select 1 from public.new_client_waitlist_invitations where id = $1 for update`, [l.invId]); } catch (e) { dErr = e; }
      expect(dErr?.code).toBeUndefined();
      await D.query("commit");
      const out = await rp;
      if (!out.ok) expect((out.err as any).code).not.toBe("40P01");
      expect(out.ok && out.res.rows[0].result).toBe("replaced");
    } finally { try { await D.query("rollback"); } catch { /* ended */ } await D.end(); await R.end(); }
  }, 30_000);
});

describe("a replaced item starts a new attempt", () => {
  async function withItem() {
    const l = await seedLive();
    const item = (await q(`select id, state, attempts from public.waitlist_invitation_batch_items where entry_id = $1`, [l.entryId]))[0];
    return { l, itemId: item.id as string };
  }
  const settle = (l: L, itemId: string, outcome: string, reason: string | null, inv: string) =>
    q<{ settle_waitlist_batch_item: string }>(`select public.settle_waitlist_batch_item($1,$2,$3,$4,$5,null,$6)`, [itemId, l.studioId, l.entryId, outcome, reason, inv]).then((r) => r[0].settle_waitlist_batch_item);
  const row = async (itemId: string) => (await q(`select state, invitation_id, reason_class, settled_at, attempts, issued_at from public.waitlist_invitation_batch_items where id = $1`, [itemId]))[0];
  it("a FAILED item replaced: issued on the new invitation, old outcome cleared, issued_at = the NEW invitation's issued_at, attempts + 1, and settle unknown then succeeds", async () => {
    const { l, itemId } = await withItem();
    const before = (await row(itemId)).attempts;
    expect(await settle(l, itemId, "failed", "provider_error", l.invId)).toBe("settled");
    const r = await replace(l);
    expect(r[0].result).toBe("replaced");
    const it = await row(itemId);
    expect(it).toMatchObject({ state: "issued", invitation_id: r[0].invitation_id, reason_class: null, settled_at: null, attempts: before + 1 });
    expect(new Date(it.issued_at).getTime()).toBe(new Date(r[0].issued_at).getTime());
    expect(await settle(l, itemId, "unknown", "delivery_unconfirmed", r[0].invitation_id)).toBe("settled");
    expect((await row(itemId)).state).toBe("unknown");
  });
  it("a replaced UNKNOWN item is reset the same way", async () => {
    const { l, itemId } = await withItem();
    expect(await settle(l, itemId, "unknown", "delivery_unconfirmed", l.invId)).toBe("settled");
    const r = await replace(l);
    expect(r[0].result).toBe("replaced");
    expect(await row(itemId)).toMatchObject({ state: "issued", invitation_id: r[0].invitation_id, reason_class: null, settled_at: null });
  });
  it("a claim INSIDE the lease does not sweep the replaced item; one AFTER the lease does", async () => {
    const { l, itemId } = await withItem();
    expect(await settle(l, itemId, "failed", "provider_error", l.invId)).toBe("settled");
    const r = await replace(l);
    expect(r[0].result).toBe("replaced");
    await q(`select * from public.claim_waitlist_batch_items(1,1,600)`); // lease 600 s: the fresh issued_at is inside it
    expect((await row(itemId)).state).toBe("issued");
    await q(`update public.waitlist_invitation_batch_items set issued_at = now() - interval '1 hour' where id = $1`, [itemId]);
    await q(`select * from public.claim_waitlist_batch_items(1,1,600)`);
    expect(await row(itemId)).toMatchObject({ state: "unknown", reason_class: "delivery_unconfirmed" });
  });
  it("a late answer for the OLD invitation stays state_changed and changes nothing", async () => {
    const { l, itemId } = await withItem();
    expect(await settle(l, itemId, "failed", "provider_error", l.invId)).toBe("settled");
    const r = await replace(l);
    const before = await row(itemId);
    expect(await settle(l, itemId, "sent", null, l.invId)).toBe("state_changed");
    expect(await row(itemId)).toEqual(before);
    expect(r[0].invitation_id).not.toBe(l.invId);
  });
  it("the refusal set stays closed: every result string is a known one", async () => {
    const known = new Set(["replaced","not_owner","not_found","no_live_invitation","invitation_redeemed","invitation_ended","invitation_expired","invalid_service","pending_owner_review","state_changed"]);
    const l = await seedLive();
    const outs = [(await replace(l, randomUUID()))[0].result, (await q(`select * from public.replace_waitlist_invitation($1,$2,$3,$4)`, [l.studioId, randomUUID(), l.entryId, l.invId]))[0].result,
      (await q(`select * from public.replace_waitlist_invitation($1,$2,$3,$4)`, [l.studioId, l.userId, randomUUID(), l.invId]))[0].result];
    for (const o of outs) expect(known.has(o) || /^refused:[a-z_]+$/.test(o), o).toBe(true);
  });
});

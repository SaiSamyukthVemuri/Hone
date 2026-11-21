import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { adminQuery, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";

const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => (await adminQuery(text, params)).rows as T[];
afterAll(async () => { await closePool(); });

// 0364 -- replace_waitlist_invitation: round-before-invitation lock order, and a replace is for a LIVE invitation only (Codex P1 / P2 on 0363).
// Synthetic data, owned local stack. NOT YET RUN: written against the 0363 helpers; a lane must run it on the T3 stack and the mutants (mutants/).
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
const replace = (l: L, expected: string = l.invId) =>
  q(`select * from public.replace_waitlist_invitation($1,$2,$3,$4)`, [l.studioId, l.userId, l.entryId, expected]);

describe("P2: a replace is for a LIVE invitation only", () => {
  it("an invitation whose time has run out (status still invited) is refused: invitation_expired, nothing written, no new invitation", async () => {
    const l = await seedLive();
    await q(`update public.new_client_waitlist_invitations set issued_at = now() - interval '3 days', expires_at = now() - interval '1 hour' where id = $1`, [l.invId]);
    const before = await q(`select count(*)::int n from public.new_client_waitlist_invitations where entry_id = $1`, [l.entryId]);
    const r = await replace(l);
    expect(r[0].result).toBe("invitation_expired");
    expect(r[0].raw_token).toBeNull();
    expect((await q(`select count(*)::int n from public.new_client_waitlist_invitations where entry_id = $1`, [l.entryId]))[0].n).toBe(before[0].n);
    expect((await q(`select status from public.new_client_waitlist_entries where id = $1`, [l.entryId]))[0].status).toBe("invited");
    expect((await q(`select released_at from public.new_client_waitlist_invitations where id = $1`, [l.invId]))[0].released_at).toBeNull();
  });
  for (const col of ["expired_at", "released_at", "declined_at"] as const) {
    it(`an invitation stamped ${col} is refused: invitation_ended, nothing written`, async () => {
      const l = await seedLive();
      await q(`update public.new_client_waitlist_invitations set ${col} = now() where id = $1`, [l.invId]);
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

// P1: two sessions. D takes redemption's lock order on the same invitation (the invitation's round FOR UPDATE, then the invitation FOR UPDATE) while R replaces
// it. On 0363 R holds the invitation (inside release) and waits for the round while D holds the round and waits for the invitation: a deadlock (40P01).
// On 0364 R takes the round first, so it waits BEFORE touching the invitation and D gets the invitation.
describe("P1: a replace and a redemption on one invitation never deadlock", () => {
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
      await new Promise((r) => setTimeout(r, 1500)); // R is now waiting (0364: on the round; 0363: on the round while holding the invitation)
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

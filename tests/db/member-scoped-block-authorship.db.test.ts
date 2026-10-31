import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, asUser, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioA, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";

// HON-48 F1 (migration 0253), decision 14: a non-owner creates, edits and deletes
// blocks ONLY on their own schedule; owners may block any practitioner or the
// whole studio. A member may no longer write a studio-wide block (any capacity)
// or a full-day blockout. Synthetic studios only. Studio B = owner + two members;
// Studio A = another tenant (owner only).

let A: SynthStudio;
let B: SynthStudio;
const owner = (s: SynthStudio) => s.practitioners.find((p) => p.role === "owner")!;
const members = () => B.practitioners.filter((p) => p.role === "practitioner");
const bo = () => members()[0];
const di = () => members()[1];

const setCapacity = (s: SynthStudio, on: boolean) =>
  adminQuery(`update public.studios set practitioner_capacity_enabled = $2 where id = $1`, [s.studioId, on]);

beforeEach(async () => {
  A = await seedSynthStudioA();
  B = await seedSynthStudioB();
  await setCapacity(B, true);
});
afterEach(async () => {
  for (const s of [A, B]) if (s) await dropSynthStudio(s);
});
afterAll(async () => {
  await closePool();
});

let slot = 0;
const nextSlot = () => {
  const hour = String(8 + (slot++ % 12)).padStart(2, "0");
  return [`2031-06-10T${hour}:00:00Z`, `2031-06-10T${hour}:30:00Z`] as const;
};
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as { code?: string }).code ?? String(e));

/** A block written by the admin path (the guard still runs); returns its id. */
async function seedBlock(studio: SynthStudio, practitionerId: string | null) {
  const [s, e] = nextSlot();
  const id = randomUUID();
  await adminQuery(
    `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id) values ($1,$2,$3,$4,'break',$5)`,
    [id, studio.studioId, s, e, practitionerId],
  );
  return id;
}
function insertAs(userId: string, studioId: string, practitionerId: string | null) {
  const [s, e] = nextSlot();
  const id = randomUUID();
  return asUser(userId, (q) =>
    q(
      `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id) values ($1,$2,$3,$4,'break',$5)`,
      [id, studioId, s, e, practitionerId],
    ),
  ).then((r) => ({ id, rows: r.rowCount }));
}
const updateAs = (userId: string, id: string, set = `ends_at = ends_at + interval '10 minutes'`) =>
  asUser(userId, (q) => q(`update public.studio_timed_blocks set ${set} where id = $1`, [id]));
const deleteAs = (userId: string, id: string) =>
  asUser(userId, (q) => q(`delete from public.studio_timed_blocks where id = $1`, [id]));
const exists = async (id: string) => (await adminQuery(`select 1 from public.studio_timed_blocks where id = $1`, [id])).rowCount === 1;
const reservationKeys = async (blockId: string) =>
  (await adminQuery(`select resource_key from public.studio_calendar_reservations where source_kind = 'timed_block' and source_id = $1 order by resource_key`, [blockId])).rows.map((r) => r.resource_key as string);

describe("INSERT — a member blocks only their own schedule", () => {
  it("capacity ON: own accepted (one reservation keyed to them); colleague, owner and studio-wide refused (42501)", async () => {
    const r = await insertAs(bo().userId, B.studioId, bo().practitionerId);
    expect(r.rows).toBe(1);
    expect(await reservationKeys(r.id)).toEqual([bo().practitionerId]);
    expect(await code(insertAs(bo().userId, B.studioId, di().practitionerId))).toBe("42501");
    expect(await code(insertAs(bo().userId, B.studioId, owner(B).practitionerId))).toBe("42501");
    expect(await code(insertAs(bo().userId, B.studioId, null))).toBe("42501");
  });
  it("capacity OFF: a member may NOT insert a studio-wide block (behaviour change, decision 14), nor a scoped one", async () => {
    await setCapacity(B, false);
    expect(await code(insertAs(bo().userId, B.studioId, null))).toBe("42501");
    expect(await code(insertAs(bo().userId, B.studioId, bo().practitionerId))).toBe("42501");
  });
  it("a deactivated member may not insert anything (the guard's 23514 runs ahead of RLS for a scoped row)", async () => {
    await adminQuery(`update public.practitioners set active = false where id = $1`, [bo().practitionerId]);
    expect(["23514", "42501"]).toContain(await code(insertAs(bo().userId, B.studioId, bo().practitionerId)));
    expect(await code(insertAs(bo().userId, B.studioId, null))).toBe("42501");
  });
  it("cross-studio: a member of B cannot write into A, and the owner of A cannot write into B", async () => {
    for (const target of [bo().practitionerId, owner(A).practitionerId, null]) {
      expect(await code(insertAs(bo().userId, A.studioId, target)), String(target)).toBe("42501");
    }
    expect(await code(insertAs(bo().userId, B.studioId, owner(A).practitionerId))).toBe("42501");
    expect(await code(insertAs(owner(A).userId, B.studioId, bo().practitionerId))).toBe("42501");
    expect(await code(insertAs(owner(A).userId, B.studioId, null))).toBe("42501");
  });
  it("the owner may block any practitioner, themselves, or the whole studio at either capacity", async () => {
    for (const target of [bo().practitionerId, di().practitionerId, owner(B).practitionerId, null]) {
      expect((await insertAs(owner(B).userId, B.studioId, target)).rows, String(target)).toBe(1);
    }
    await setCapacity(B, false);
    expect((await insertAs(owner(B).userId, B.studioId, null)).rows).toBe(1);
  });
  it("an owner's scoped block for an inactive practitioner is still refused by the guard (23514)", async () => {
    await adminQuery(`update public.practitioners set active = false where id = $1`, [di().practitionerId]);
    expect(await code(insertAs(owner(B).userId, B.studioId, di().practitionerId))).toBe("23514");
  });
});

describe("UPDATE and DELETE — a member edits only their OWN scoped block", () => {
  it("capacity ON: own block updates and deletes; the reservation stays keyed to them", async () => {
    const id = await seedBlock(B, bo().practitionerId);
    expect((await updateAs(bo().userId, id)).rowCount).toBe(1);
    expect(await reservationKeys(id)).toEqual([bo().practitionerId]);
    expect((await deleteAs(bo().userId, id)).rowCount).toBe(1);
    expect(await exists(id)).toBe(false);
  });
  it("capacity ON: a colleague's block, the owner's block and a studio-wide block are untouchable (0 rows, still there)", async () => {
    for (const target of [di().practitionerId, owner(B).practitionerId, null]) {
      const id = await seedBlock(B, target);
      expect((await updateAs(bo().userId, id)).rowCount, `update ${target}`).toBe(0);
      expect((await deleteAs(bo().userId, id)).rowCount, `delete ${target}`).toBe(0);
      expect(await exists(id)).toBe(true);
    }
  });
  it("a member cannot re-scope their own block to a colleague, the owner or studio-wide (WITH CHECK, 42501)", async () => {
    const id = await seedBlock(B, bo().practitionerId);
    expect(await code(updateAs(bo().userId, id, `practitioner_id = '${di().practitionerId}'`))).toBe("42501");
    expect(await code(updateAs(bo().userId, id, `practitioner_id = '${owner(B).practitionerId}'`))).toBe("42501");
    expect(await code(updateAs(bo().userId, id, `practitioner_id = null`))).toBe("42501");
    expect((await adminQuery(`select practitioner_id from public.studio_timed_blocks where id = $1`, [id])).rows[0].practitioner_id).toBe(bo().practitionerId);
  });
  it("a member cannot move their own block into another studio", async () => {
    const id = await seedBlock(B, bo().practitionerId);
    expect(await code(updateAs(bo().userId, id, `studio_id = '${A.studioId}'`))).not.toBe("ok");
    expect(await exists(id)).toBe(true);
  });
  it("capacity OFF: a member edits or removes nothing, not even a block scoped to them before the flip", async () => {
    const own = await seedBlock(B, bo().practitionerId);
    const wide = await seedBlock(B, null);
    await setCapacity(B, false);
    for (const id of [own, wide]) {
      expect((await updateAs(bo().userId, id)).rowCount, "update").toBe(0);
      expect((await deleteAs(bo().userId, id)).rowCount).toBe(0);
      expect(await exists(id)).toBe(true);
    }
  });
  it("a deactivated member edits and removes nothing", async () => {
    const id = await seedBlock(B, bo().practitionerId);
    await adminQuery(`update public.practitioners set active = false where id = $1`, [bo().practitionerId]);
    expect((await updateAs(bo().userId, id)).rowCount).toBe(0);
    expect((await deleteAs(bo().userId, id)).rowCount).toBe(0);
    expect(await exists(id)).toBe(true);
  });
  it("cross-studio: a member of B and the owner of A change and remove nothing of the other studio", async () => {
    const inB = await seedBlock(B, bo().practitionerId);
    const inA = await seedBlock(A, null);
    expect((await updateAs(owner(A).userId, inB)).rowCount).toBe(0);
    expect((await deleteAs(owner(A).userId, inB)).rowCount).toBe(0);
    expect((await updateAs(bo().userId, inA)).rowCount).toBe(0);
    expect((await deleteAs(bo().userId, inA)).rowCount).toBe(0);
    expect(await exists(inB)).toBe(true);
    expect(await exists(inA)).toBe(true);
  });
  it("the owner updates and deletes any block, scoped or studio-wide (unchanged)", async () => {
    for (const target of [bo().practitionerId, di().practitionerId, null]) {
      const id = await seedBlock(B, target);
      expect((await updateAs(owner(B).userId, id)).rowCount, `update ${target}`).toBe(1);
      expect((await deleteAs(owner(B).userId, id)).rowCount, `delete ${target}`).toBe(1);
    }
  });
});

describe("studio_blockouts — studio-wide by construction, so owners only write", () => {
  const ins = (userId: string, studioId: string) =>
    asUser(userId, (q) => q(`insert into public.studio_blockouts (studio_id, starts_on, ends_on, reason) values ($1, '2031-07-01', '2031-07-02', 'synthetic') returning id`, [studioId]));
  const seedBlockout = async (studio: SynthStudio) =>
    (await adminQuery(`insert into public.studio_blockouts (studio_id, starts_on, ends_on) values ($1, '2031-08-01', '2031-08-02') returning id`, [studio.studioId])).rows[0].id as string;
  it("the table has no practitioner column (the reason a member write can never be 'their own')", async () => {
    const r = await adminQuery(`select 1 from information_schema.columns where table_schema='public' and table_name='studio_blockouts' and column_name='practitioner_id'`);
    expect(r.rowCount).toBe(0);
  });
  for (const on of [true, false]) {
    it(`capacity ${on ? "ON" : "OFF"}: a member cannot create, update or delete one, but can read it`, async () => {
      await setCapacity(B, on);
      const id = await seedBlockout(B);
      expect(await code(ins(bo().userId, B.studioId))).toBe("42501");
      expect((await asUser(bo().userId, (q) => q(`update public.studio_blockouts set reason = 'x' where id = $1`, [id]))).rowCount).toBe(0);
      expect((await asUser(bo().userId, (q) => q(`delete from public.studio_blockouts where id = $1`, [id]))).rowCount).toBe(0);
      expect((await asUser(bo().userId, (q) => q(`select id from public.studio_blockouts where id = $1`, [id]))).rowCount).toBe(1);
      expect((await adminQuery(`select 1 from public.studio_blockouts where id = $1`, [id])).rowCount).toBe(1);
    });
  }
  it("a deactivated member cannot read or write", async () => {
    const id = await seedBlockout(B);
    await adminQuery(`update public.practitioners set active = false where id = $1`, [bo().practitionerId]);
    expect(await code(ins(bo().userId, B.studioId))).toBe("42501");
    expect((await asUser(bo().userId, (q) => q(`select id from public.studio_blockouts where id = $1`, [id]))).rowCount).toBe(0);
  });
  it("the owner creates, updates and deletes; the owner of another studio cannot touch it", async () => {
    expect((await ins(owner(B).userId, B.studioId)).rowCount).toBe(1);
    const id = await seedBlockout(B);
    expect((await asUser(owner(B).userId, (q) => q(`update public.studio_blockouts set reason = 'x' where id = $1`, [id]))).rowCount).toBe(1);
    expect(await code(ins(owner(A).userId, B.studioId))).toBe("42501");
    expect((await asUser(owner(A).userId, (q) => q(`delete from public.studio_blockouts where id = $1`, [id]))).rowCount).toBe(0);
    expect((await asUser(owner(B).userId, (q) => q(`delete from public.studio_blockouts where id = $1`, [id]))).rowCount).toBe(1);
  });
  it("a member of A cannot read B's blockouts", async () => {
    const id = await seedBlockout(B);
    expect((await asUser(owner(A).userId, (q) => q(`select id from public.studio_blockouts where id = $1`, [id]))).rowCount).toBe(0);
  });
});

describe("the decision function's privileges, measured", () => {
  const FN = "public.member_owns_scoped_timed_block(uuid, uuid)";
  const has = (role: string) => adminQuery(`select has_function_privilege($1, '${FN}', 'execute') as ok`, [role]).then((r) => r.rows[0].ok as boolean);
  it("only authenticated may execute it; anon, service_role and public may not", async () => {
    expect(await has("authenticated")).toBe(true);
    expect(await has("anon")).toBe(false);
    expect(await has("service_role")).toBe(false);
    const r = await adminQuery(`select (select proacl from pg_proc where oid = '${FN}'::regprocedure)::text as acl`);
    expect(r.rows[0].acl).not.toMatch(/(^\{|,)=X/);
  });
  it("it is SECURITY DEFINER with a pinned search_path", async () => {
    const r = await adminQuery(`select prosecdef, proconfig::text as cfg from pg_proc where oid = '${FN}'::regprocedure`);
    expect(r.rows[0].prosecdef).toBe(true);
    expect(r.rows[0].cfg).toContain("search_path=pg_catalog, pg_temp");
  });
  it("it answers only about the CALLER, only with capacity ON, and never for a null studio or practitioner", async () => {
    const q1 = `select public.member_owns_scoped_timed_block($1, $2) as own, public.member_owns_scoped_timed_block($1, $3) as other, public.member_owns_scoped_timed_block(null, $2) as nostudio, public.member_owns_scoped_timed_block($1, null) as wide`;
    const on = await asUser(bo().userId, (q) => q(q1, [B.studioId, bo().practitionerId, di().practitionerId]));
    expect(on.rows[0]).toEqual({ own: true, other: false, nostudio: false, wide: false });
    await setCapacity(B, false);
    const off = await asUser(bo().userId, (q) => q(q1, [B.studioId, bo().practitionerId, di().practitionerId]));
    expect(off.rows[0].own).toBe(false);
  });
  it("anon cannot insert a block or a blockout at all", async () => {
    expect(await code(asRole("anon", (q) => q(`insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category) values ($1, $2, now(), now() + interval '1 hour', 'break')`, [randomUUID(), B.studioId])))).toBe("42501");
    expect(await code(asRole("anon", (q) => q(`insert into public.studio_blockouts (studio_id, starts_on, ends_on) values ($1, '2031-07-01', '2031-07-02')`, [B.studioId])))).toBe("42501");
  });
});

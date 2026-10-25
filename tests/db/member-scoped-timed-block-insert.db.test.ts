import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, asUser, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioA, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";

// HON-48 F1 (migration 0253): a non-owner blocks only THEIR OWN schedule; an
// owner may block any practitioner or the whole studio. Synthetic studios only.
// Studio B = owner + two members; Studio A = a different tenant (owner only).

let A: SynthStudio;
let B: SynthStudio;
const owner = (s: SynthStudio) => s.practitioners.find((p) => p.role === "owner")!;
const members = () => B.practitioners.filter((p) => p.role === "practitioner");
const bo = () => members()[0];
const di = () => members()[1];

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

const setCapacity = (s: SynthStudio, on: boolean) =>
  adminQuery(`update public.studios set practitioner_capacity_enabled = $2 where id = $1`, [s.studioId, on]);

let slot = 0;
function insertAs(userId: string, studioId: string, practitionerId: string | null) {
  const hour = String(8 + (slot++ % 12)).padStart(2, "0");
  const id = randomUUID();
  return asUser(userId, (q) =>
    q(
      `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id)
       values ($1, $2, $3, $4, 'break', $5)`,
      [id, studioId, `2031-06-10T${hour}:00:00Z`, `2031-06-10T${hour}:30:00Z`, practitionerId],
    ),
  ).then((r) => ({ id, rows: r.rowCount }));
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as { code?: string }).code ?? String(e));
const reservationKeys = async (blockId: string) =>
  (await adminQuery(`select resource_key from public.studio_calendar_reservations where source_kind = 'timed_block' and source_id = $1 order by resource_key`, [blockId])).rows.map((r) => r.resource_key as string);

describe("capacity ON — a member blocks only their own schedule", () => {
  it("a member may insert a block scoped to THEMSELVES, and exactly one reservation is keyed to them", async () => {
    const r = await insertAs(bo().userId, B.studioId, bo().practitionerId);
    expect(r.rows).toBe(1);
    expect(await reservationKeys(r.id)).toEqual([bo().practitionerId]);
  });
  it("a member may NOT block a colleague (42501), nor the owner", async () => {
    expect(await code(insertAs(bo().userId, B.studioId, di().practitionerId))).toBe("42501");
    expect(await code(insertAs(bo().userId, B.studioId, owner(B).practitionerId))).toBe("42501");
  });
  it("a member may NOT close the whole studio (42501)", async () => {
    expect(await code(insertAs(bo().userId, B.studioId, null))).toBe("42501");
  });
  it("a deactivated member may not insert anything", async () => {
    await adminQuery(`update public.practitioners set active = false where id = $1`, [bo().practitionerId]);
    // The BEFORE INSERT guard runs ahead of RLS and names an inactive target (23514);
    // either way the row is refused.
    expect(["23514", "42501"]).toContain(await code(insertAs(bo().userId, B.studioId, bo().practitionerId)));
    expect(await code(insertAs(bo().userId, B.studioId, null))).toBe("42501");
  });
  it("tenant isolation: a member of B cannot write into studio A, with their own id or A's", async () => {
    expect(await code(insertAs(bo().userId, A.studioId, bo().practitionerId))).toBe("42501");
    expect(await code(insertAs(bo().userId, A.studioId, owner(A).practitionerId))).toBe("42501");
    expect(await code(insertAs(bo().userId, A.studioId, null))).toBe("42501");
    // studio B with a practitioner id from tenant A: refused by RLS before the FK
    expect(await code(insertAs(bo().userId, B.studioId, owner(A).practitionerId))).toBe("42501");
  });
  it("tenant isolation: the owner of A cannot write into studio B", async () => {
    expect(await code(insertAs(owner(A).userId, B.studioId, bo().practitionerId))).toBe("42501");
    expect(await code(insertAs(owner(A).userId, B.studioId, null))).toBe("42501");
  });
  it("the owner may block any practitioner, themselves, or the whole studio (unchanged)", async () => {
    for (const target of [bo().practitionerId, di().practitionerId, owner(B).practitionerId, null]) {
      expect((await insertAs(owner(B).userId, B.studioId, target)).rows, String(target)).toBe(1);
    }
  });
  it("an owner's scoped block for an inactive practitioner is still refused by the guard (23514)", async () => {
    await adminQuery(`update public.practitioners set active = false where id = $1`, [di().practitionerId]);
    expect(await code(insertAs(owner(B).userId, B.studioId, di().practitionerId))).toBe("23514");
  });
  it("UPDATE and DELETE stay owner-only: a member changes and removes nothing, even their own block", async () => {
    const own = await insertAs(bo().userId, B.studioId, bo().practitionerId);
    const upd = await asUser(bo().userId, (q) => q(`update public.studio_timed_blocks set ends_at = ends_at + interval '10 minutes' where id = $1`, [own.id]));
    expect(upd.rowCount).toBe(0);
    const del = await asUser(bo().userId, (q) => q(`delete from public.studio_timed_blocks where id = $1`, [own.id]));
    expect(del.rowCount).toBe(0);
    expect((await adminQuery(`select 1 from public.studio_timed_blocks where id = $1`, [own.id])).rowCount).toBe(1);
    const ownerDel = await asUser(owner(B).userId, (q) => q(`delete from public.studio_timed_blocks where id = $1`, [own.id]));
    expect(ownerDel.rowCount).toBe(1);
  });
});

describe("capacity OFF — unchanged for studios without per-practitioner scheduling", () => {
  beforeEach(() => setCapacity(B, false));
  it("a member may still insert a studio-wide block", async () => {
    expect((await insertAs(bo().userId, B.studioId, null)).rows).toBe(1);
  });
  it("a member may not insert a scoped block (RLS 42501), not even their own", async () => {
    expect(await code(insertAs(bo().userId, B.studioId, bo().practitionerId))).toBe("42501");
  });
  it("tenant isolation still holds", async () => {
    expect(await code(insertAs(bo().userId, A.studioId, null))).toBe("42501");
  });
});

describe("the decision function's privileges, measured", () => {
  const has = (role: string) =>
    adminQuery(`select has_function_privilege($1, 'public.member_may_insert_timed_block(uuid, uuid)', 'execute') as ok`, [role]).then((r) => r.rows[0].ok as boolean);
  it("only authenticated may execute it; anon, service_role and public may not", async () => {
    expect(await has("authenticated")).toBe(true);
    expect(await has("anon")).toBe(false);
    expect(await has("service_role")).toBe(false);
    const pub = await adminQuery(`select (select proacl from pg_proc where oid = 'public.member_may_insert_timed_block(uuid, uuid)'::regprocedure)::text as acl`);
    expect(pub.rows[0].acl).not.toMatch(/(^\{|,)=X/);
  });
  it("it is SECURITY DEFINER with a pinned search_path", async () => {
    const r = await adminQuery(`select prosecdef, proconfig::text as cfg from pg_proc where oid = 'public.member_may_insert_timed_block(uuid, uuid)'::regprocedure`);
    expect(r.rows[0].prosecdef).toBe(true);
    expect(r.rows[0].cfg).toContain("search_path=pg_catalog, pg_temp");
  });
  it("it answers only about the CALLER: another user's practitioner id is false", async () => {
    const r = await asUser(bo().userId, (q) => q(`select public.member_may_insert_timed_block($1, $2) as ok, public.member_may_insert_timed_block($1, $3) as other, public.member_may_insert_timed_block(null, $2) as nostudio`, [B.studioId, bo().practitionerId, di().practitionerId]));
    expect(r.rows[0]).toEqual({ ok: true, other: false, nostudio: false });
  });
  it("anon cannot insert a block at all", async () => {
    const r = await code(asRole("anon", (q) => q(`insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category) values ($1, $2, now(), now() + interval '1 hour', 'break')`, [randomUUID(), B.studioId])));
    expect(r).toBe("42501");
  });
});

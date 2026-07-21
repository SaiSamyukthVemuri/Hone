import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, asRole, asUser, closePool, resolveLocalDbUrl } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B 3E-0..3E-4 — lock coverage on every structural source mutation (incl.
// DELETE + blockouts + timezone), Legacy occurrence dormancy, lock-then-reread
// materialization, and authenticated-owner RLS for scoped timed blocks.

let B: SynthStudio;
const P = (i: number) => B.practitioners[i].practitionerId;
const owner = () => B.practitioners.find((p) => p.role === "owner")!;
const member = () => B.practitioners.find((p) => p.role === "practitioner")!;
const HORIZON = "2032-12-31";

beforeEach(async () => {
  B = await seedSynthStudioB();
  await adminQuery(`update public.studios set practitioner_capacity_enabled = true where id = $1`, [B.studioId]);
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

const setCap = (v: boolean) =>
  adminQuery(`update public.studios set practitioner_capacity_enabled = $2 where id = $1`, [B.studioId, v]);
const insBlock = (practitionerId: string | null) =>
  adminQuery(
    `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id)
     values ($1,$2,'2031-05-10T10:00:00Z','2031-05-10T11:00:00Z','break',$3) returning id`,
    [randomUUID(), B.studioId, practitionerId],
  ).then((r) => r.rows[0].id as string);

// A holds the studio capacity lock; the given mutation (in B) must block -> 57014.
async function expectBlockedByLock(mutation: (b: Client) => Promise<unknown>) {
  const a = new Client({ connectionString: resolveLocalDbUrl() });
  const b = new Client({ connectionString: resolveLocalDbUrl() });
  await a.connect();
  await b.connect();
  try {
    await a.query("begin");
    await a.query("select public.acquire_studio_capacity_lock($1)", [B.studioId]);
    await b.query("begin");
    await b.query("set local statement_timeout = '800ms'");
    await expect(mutation(b)).rejects.toMatchObject({ code: "57014" });
    await b.query("rollback").catch(() => undefined);
    await a.query("rollback");
  } finally {
    await a.end();
    await b.end();
  }
}

describe("3E-0: the advisory lock covers every structural source mutation", () => {
  it("timed-block DELETE blocks on the lock", async () => {
    const id = await insBlock(P(1));
    await expectBlockedByLock((b) => b.query(`delete from public.studio_timed_blocks where id = $1`, [id]));
  });
  it("timed-block UPDATE blocks on the lock", async () => {
    const id = await insBlock(P(1));
    await expectBlockedByLock((b) =>
      b.query(`update public.studio_timed_blocks set practitioner_id = null where id = $1`, [id]),
    );
  });
  it("full-day blockout INSERT + DELETE block on the lock", async () => {
    await expectBlockedByLock((b) =>
      b.query(
        `insert into public.studio_blockouts (id, studio_id, starts_on, ends_on) values ($1,$2,'2031-07-01','2031-07-03')`,
        [randomUUID(), B.studioId],
      ),
    );
    const bo = randomUUID();
    await adminQuery(`insert into public.studio_blockouts (id, studio_id, starts_on, ends_on) values ($1,$2,'2031-08-01','2031-08-02')`, [bo, B.studioId]);
    await expectBlockedByLock((b) => b.query(`delete from public.studio_blockouts where id = $1`, [bo]));
  });
  it("a studio timezone change blocks on the lock", async () => {
    await expectBlockedByLock((b) =>
      b.query(`update public.studios set timezone = 'America/Vancouver' where id = $1`, [B.studioId]),
    );
  });
});

describe("3E-1: Legacy recurring-rule dormancy (materialization must not 42501)", () => {
  async function createRule(practitionerId: string) {
    const r = await adminQuery(
      `select public.create_recurring_break_rule_and_materialize($1,'lunch','{1,2,3,4,5}'::int[],'12:00','13:00',true,$2,$3::date,$4) id`,
      [B.studioId, owner().practitionerId, "2031-07-01", practitionerId],
    );
    return r.rows[0].id as string;
  }
  const occCount = async (rule: string) =>
    Number((await adminQuery(`select count(*)::int c from public.studio_recurring_break_occurrences where rule_id=$1`, [rule])).rows[0].c);
  const resForRule = async (rule: string) =>
    Number(
      (await adminQuery(
        `select count(*)::int c from public.studio_calendar_reservations res
           join public.studio_recurring_break_occurrences o on o.id = res.source_id and res.source_kind='recurring_break_occurrence'
          where o.rule_id = $1`,
        [rule],
      )).rows[0].c,
    );

  it("a retained scoped rule extends its horizon in Legacy: occurrences stored, ZERO reservations, no 42501", async () => {
    const rule = await createRule(P(1)); // capacity ON
    const before = await occCount(rule);
    await setCap(false); // Legacy — reservations drained
    expect(await resForRule(rule)).toBe(0);
    // Extend the horizon — must SUCCEED (not 42501) and store more occurrences.
    await expect(
      adminQuery(`select public.materialize_recurring_break_rule($1, $2::date)`, [rule, HORIZON]),
    ).resolves.toBeTruthy();
    expect(await occCount(rule)).toBeGreaterThan(before);
    // Newly materialized occurrences are dormant (zero reservations) + keep P(1) scope.
    expect(await resForRule(rule)).toBe(0);
    const scopes = await adminQuery(
      `select distinct practitioner_id from public.studio_recurring_break_occurrences where rule_id=$1`,
      [rule],
    );
    expect(scopes.rows.map((r) => r.practitioner_id)).toEqual([P(1)]);
    // Reactivate -> rematerializes under the original practitioner.
    await setCap(true);
    expect(await resForRule(rule)).toBeGreaterThan(0);
  });
});

describe("3E-2: materialize is a no-op for a deleted rule (lock-then-reread)", () => {
  it("materializing a nonexistent rule returns safely (no rows, no error)", async () => {
    await expect(
      adminQuery(`select public.materialize_recurring_break_rule($1, $2::date)`, [randomUUID(), HORIZON]),
    ).resolves.toBeTruthy();
  });
});

describe("3E-4: authenticated-owner RLS CRUD for scoped timed blocks", () => {
  const ownerIns = (
    q: (t: string, p?: unknown[]) => Promise<{ rowCount: number | null; rows: { id: string }[] }>,
    pid: string | null,
    starts = "2031-05-10T10:00:00Z",
    ends = "2031-05-10T11:00:00Z",
  ) =>
    q(
      `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id)
       values ($1,$2,$4,$5,'break',$3) returning id`,
      [randomUUID(), B.studioId, pid, starts, ends],
    );

  it("owner can INSERT studio-wide + scoped, UPDATE scope, DELETE — all via authenticated RLS", async () => {
    const scopedId = await asUser(owner().userId, async (q) => {
      // Different times so the studio-wide fan-out (incl P1) and the P1-scoped
      // block do not both reserve P1 at the same instant.
      const wide = await ownerIns(q, null, "2031-05-10T10:00:00Z", "2031-05-10T11:00:00Z");
      expect(wide.rowCount).toBe(1);
      const scoped = await ownerIns(q, P(1), "2031-05-10T13:00:00Z", "2031-05-10T14:00:00Z");
      expect(scoped.rowCount).toBe(1);
      return scoped.rows[0].id;
    });
    // UPDATE scope P1 -> P2, then DELETE — same authenticated owner.
    await asUser(owner().userId, async (q) => {
      const upd = await q(`update public.studio_timed_blocks set practitioner_id = $2 where id = $1`, [scopedId, P(2)]);
      expect(upd.rowCount).toBe(1);
      const del = await q(`delete from public.studio_timed_blocks where id = $1`, [scopedId]);
      expect(del.rowCount).toBe(1);
    });
  });

  it("a non-owner member is denied scoped INSERT but keeps studio-wide; anon denied", async () => {
    const scoped = await asUser(member().userId, (q) => ownerIns(q, P(1)))
      .then((r) => ({ rows: r.rowCount, err: null as string | null }))
      .catch((e) => ({ rows: null, err: e.code as string }));
    expect(scoped.rows === 0 || scoped.err != null).toBe(true);
    const wide = await asUser(member().userId, (q) => ownerIns(q, null));
    expect(wide.rowCount).toBe(1);
    const anon = await asRole("anon", (q) => ownerIns(q, null))
      .then((r) => ({ rows: r.rowCount, err: null as string | null }))
      .catch((e) => ({ rows: null, err: e.code as string }));
    expect(anon.rows === 0 || anon.err != null).toBe(true);
  });
});

import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, asRole, asUser, closePool, resolveLocalDbUrl } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioA,
  seedSynthStudioB,
  type SynthStudio,
} from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// PR B 3C-3E (DB engine), practitioner-scoped timed blocks + recurring breaks,
// the canonical scope-aware reservation synchronizer, scope transitions,
// retirement/reactivation dormancy, integrity guards, and concurrency. On
// synthetic Studio B (owner P0 + members P1, P2). Never Willow.

let B: SynthStudio;
const P = (i: number) => B.practitioners[i].practitionerId;
const owner = () => B.practitioners.find((p) => p.role === "owner")!;
const member = () => B.practitioners.find((p) => p.role === "practitioner")!;

beforeEach(async () => {
  B = await seedSynthStudioB();
  await adminQuery(
    `update public.studios set practitioner_capacity_enabled = true where id = $1`,
    [B.studioId],
  );
});
afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

const T10 = "2031-05-10T10:00:00Z";
const T11 = "2031-05-10T11:00:00Z";

function insBlock(practitionerId: string | null, starts = T10, ends = T11) {
  return adminQuery(
    `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id)
     values ($1, $2, $3, $4, 'break', $5) returning id`,
    [randomUUID(), B.studioId, starts, ends, practitionerId],
  ).then((r) => r.rows[0].id as string);
}
async function resKeys(sourceKind: string, sourceId: string): Promise<string[]> {
  const r = await adminQuery(
    `select resource_key from public.studio_calendar_reservations
       where source_kind = $1 and source_id = $2 order by resource_key`,
    [sourceKind, sourceId],
  );
  return r.rows.map((x) => x.resource_key as string).sort();
}
const setCap = (v: boolean) =>
  adminQuery(`update public.studios set practitioner_capacity_enabled = $2 where id = $1`, [B.studioId, v]);

describe("3C: scoped timed-block reservation keying", () => {
  it("a practitioner-scoped block creates exactly ONE reservation keyed to that practitioner", async () => {
    const id = await insBlock(P(1));
    expect(await resKeys("timed_block", id)).toEqual([P(1)]);
  });
  it("a studio-wide block fans out to every practitioner", async () => {
    const id = await insBlock(null);
    expect(await resKeys("timed_block", id)).toEqual([P(0), P(1), P(2)].sort());
  });
  it("deleting a scoped block removes only its reservation", async () => {
    const a = await insBlock(P(1));
    const wide = await insBlock(null, "2031-05-10T13:00:00Z", "2031-05-10T14:00:00Z");
    await adminQuery(`delete from public.studio_timed_blocks where id = $1`, [a]);
    expect(await resKeys("timed_block", a)).toEqual([]);
    expect((await resKeys("timed_block", wide)).length).toBe(3); // studio-wide intact
  });
});

describe("3C: timed-block scope transitions (atomic)", () => {
  it("studio-wide -> A -> studio-wide -> B leaves only the correct keys each time", async () => {
    const id = await insBlock(null);
    expect((await resKeys("timed_block", id)).length).toBe(3);
    await adminQuery(`update public.studio_timed_blocks set practitioner_id = $2 where id = $1`, [id, P(1)]);
    expect(await resKeys("timed_block", id)).toEqual([P(1)]); // no stale fan-out rows
    await adminQuery(`update public.studio_timed_blocks set practitioner_id = null where id = $1`, [id]);
    expect((await resKeys("timed_block", id)).length).toBe(3);
    await adminQuery(`update public.studio_timed_blocks set practitioner_id = $2 where id = $1`, [id, P(2)]);
    expect(await resKeys("timed_block", id)).toEqual([P(2)]); // only B, none for A
  });

  it("a time-only edit keeps the scope and updates the interval", async () => {
    const id = await insBlock(P(1));
    await adminQuery(
      `update public.studio_timed_blocks set starts_at = $2, ends_at = $3 where id = $1`,
      [id, "2031-05-10T15:00:00Z", "2031-05-10T16:00:00Z"],
    );
    const r = await adminQuery(
      `select resource_key, starts_at from public.studio_calendar_reservations where source_kind='timed_block' and source_id=$1`,
      [id],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].resource_key).toBe(P(1));
    expect(new Date(r.rows[0].starts_at).toISOString()).toBe("2031-05-10T15:00:00.000Z");
  });

  it("a scope change that CONFLICTS rolls back, prior source + reservations intact", async () => {
    // A already has an appointment 10-11 (blocks A). A studio-wide block at 10-11
    // fans to everyone incl A -> would collide with A's appointment.
    const clientId = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,'c')`, [clientId, B.studioId]);
    await adminQuery(`update public.studios set buffer_minutes = 0 where id = $1`, [B.studioId]);
    await adminQuery(
      `insert into public.appointments (id, studio_id, client_id, practitioner_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
       values ($1,$2,$3,$4,$5,$6,60,0,$6,'confirmed')`,
      [randomUUID(), B.studioId, clientId, P(1), T10, T11],
    );
    // A block scoped to P(2) at 10-11 is fine (different practitioner).
    const id = await insBlock(P(2));
    expect(await resKeys("timed_block", id)).toEqual([P(2)]);
    // Transition it to studio-wide -> fans to P(1) too -> collides with P(1)'s appt -> 23P01, rollback.
    await expect(
      adminQuery(`update public.studio_timed_blocks set practitioner_id = null where id = $1`, [id]),
    ).rejects.toMatchObject({ code: "23P01" });
    // Prior state intact: still scoped to P(2).
    const still = await adminQuery(`select practitioner_id from public.studio_timed_blocks where id = $1`, [id]);
    expect(still.rows[0].practitioner_id).toBe(P(2));
    expect(await resKeys("timed_block", id)).toEqual([P(2)]);
  });
});

describe("3C: Legacy dormancy + reactivation", () => {
  it("disabling capacity makes a scoped block dormant (zero reservations); re-enabling restores it", async () => {
    const scoped = await insBlock(P(1));
    const wide = await insBlock(null, "2031-05-10T13:00:00Z", "2031-05-10T14:00:00Z");
    await setCap(false); // Legacy
    expect(await resKeys("timed_block", scoped)).toEqual([]); // retained but dormant
    expect(await resKeys("timed_block", wide)).toEqual([B.studioId]); // studio-wide -> one studio row
    // Source row is still stored.
    const kept = await adminQuery(`select practitioner_id from public.studio_timed_blocks where id = $1`, [scoped]);
    expect(kept.rows[0].practitioner_id).toBe(P(1));
    await setCap(true); // reactivate
    expect(await resKeys("timed_block", scoped)).toEqual([P(1)]); // restored under original scope
  });
});

describe("3C: integrity (guard / RLS / FK)", () => {
  it("a scoped block on a capacity-OFF studio is rejected (42501)", async () => {
    await setCap(false);
    await expect(insBlock(P(1))).rejects.toMatchObject({ code: "42501" });
  });
  it("an inactive practitioner target is rejected (23514)", async () => {
    await adminQuery(`update public.practitioners set active = false where id = $1`, [P(2)]);
    await expect(insBlock(P(2))).rejects.toMatchObject({ code: "23514" });
  });
  it("a cross-studio practitioner is rejected by the composite FK (23503)", async () => {
    const A = await seedSynthStudioA();
    try {
      await expect(insBlock(A.practitioners[0].practitionerId)).rejects.toMatchObject({ code: "23503" });
    } finally {
      await dropSynthStudio(A);
    }
  });
  it("operator/service-role writes a scoped block; a browser member is denied scoped but keeps studio-wide", async () => {
    // Privileged path (service-role / admin client, which the owner server
    // action uses) writes a scoped block; the guard still runs.
    const ok = await asRole("service_role", (q) =>
      q(
        `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id)
         values ($1,$2,$3,$4,'break',$5)`,
        [randomUUID(), B.studioId, T10, T11, P(1)],
      ),
    );
    expect(ok.rowCount).toBe(1);
    // A non-owner MEMBER cannot write a SCOPED block (member INSERT is now
    // limited to studio-wide rows), denied by RLS (throws or 0 rows).
    const scoped = await asUser(member().userId, (q) =>
      q(
        `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id)
         values ($1,$2,$3,$4,'break',$5)`,
        [randomUUID(), B.studioId, "2031-05-10T12:00:00Z", "2031-05-10T12:30:00Z", P(1)],
      ),
    )
      .then((r) => ({ rows: r.rowCount, err: null as string | null }))
      .catch((e) => ({ rows: null, err: e.code as string }));
    expect(scoped.rows === 0 || scoped.err != null).toBe(true);
    // ...but a member CAN still create a STUDIO-WIDE block (existing drag-to-block).
    const wide = await asUser(member().userId, (q) =>
      q(
        `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id)
         values ($1,$2,$3,$4,'break',null)`,
        [randomUUID(), B.studioId, "2031-05-10T18:00:00Z", "2031-05-10T18:30:00Z"],
      ),
    );
    expect(wide.rowCount).toBe(1);
  });
  it("a practitioner with a scoped block cannot be hard-deleted (FK RESTRICT); studio delete still cascades", async () => {
    await insBlock(P(2));
    await expect(
      adminQuery(`delete from public.practitioners where id = $1`, [P(2)]),
    ).rejects.toMatchObject({ code: "23503" });
    // Studio delete cascades (dropSynthStudio in afterEach must still succeed).
  });
});

describe("3D: scoped recurring breaks", () => {
  const horizon = "2031-06-30";
  async function createRule(practitionerId: string | null, days = [1]) {
    const r = await adminQuery(
      `select public.create_recurring_break_rule_and_materialize(
         $1,'lunch',$2::int[],'12:00','13:00',true,$3,$4::date,$5) as id`,
      [B.studioId, days, owner().practitionerId, horizon, practitionerId],
    );
    return r.rows[0].id as string;
  }
  const occKeys = async (ruleId: string) => {
    const r = await adminQuery(
      `select res.resource_key
         from public.studio_recurring_break_occurrences occ
         join public.studio_calendar_reservations res
           on res.source_kind='recurring_break_occurrence' and res.source_id = occ.id
        where occ.rule_id = $1`,
      [ruleId],
    );
    return r.rows.map((x) => x.resource_key as string);
  };
  const occCount = async (ruleId: string) =>
    Number(
      (await adminQuery(`select count(*)::int c from public.studio_recurring_break_occurrences where rule_id=$1`, [ruleId])).rows[0].c,
    );

  it("occurrences copy a B-scoped rule and reserve only B's resource", async () => {
    const rule = await createRule(P(1));
    const keys = await occKeys(rule);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set([P(1)])); // every occurrence keyed to B only
  });

  it("re-materializing produces no duplicate occurrences or reservations", async () => {
    const rule = await createRule(P(1));
    const before = await occCount(rule);
    await adminQuery(`select public.materialize_recurring_break_rule($1, $2::date)`, [rule, horizon]);
    expect(await occCount(rule)).toBe(before); // idempotent
  });

  it("a studio-wide rule fans its occurrences to all practitioners", async () => {
    const rule = await createRule(null);
    const keys = new Set(await occKeys(rule));
    expect(keys).toEqual(new Set([P(0), P(1), P(2)]));
  });

  it("updating rule scope B -> A replaces future occurrences under A", async () => {
    const rule = await createRule(P(1));
    await adminQuery(
      `select public.update_recurring_break_rule_and_rematerialize(
         $1,$2,'lunch',$3::int[],'12:00','13:00',true,$4::date,$5)`,
      [rule, B.studioId, [1], horizon, P(2)],
    );
    expect(new Set(await occKeys(rule))).toEqual(new Set([P(2)])); // now A(=P2), no B rows
  });

  it("deleting the rule removes future occurrences + their reservations", async () => {
    const rule = await createRule(P(1));
    expect(await occCount(rule)).toBeGreaterThan(0);
    await adminQuery(`select public.delete_recurring_break_rule($1,$2)`, [rule, B.studioId]);
    expect(await occCount(rule)).toBe(0);
  });

  it("a scoped rule on a capacity-OFF studio is rejected (42501)", async () => {
    await setCap(false);
    await expect(createRule(P(1))).rejects.toMatchObject({ code: "42501" });
  });

  it("Legacy makes scoped occurrences dormant; reactivation restores them", async () => {
    const rule = await createRule(P(1));
    expect((await occKeys(rule)).length).toBeGreaterThan(0);
    await setCap(false);
    expect(await occKeys(rule)).toEqual([]); // dormant (occurrences retained, no reservations)
    expect(await occCount(rule)).toBeGreaterThan(0); // occurrences still stored
    await setCap(true);
    expect(new Set(await occKeys(rule))).toEqual(new Set([P(1)]));
  });
});

describe("3B-4/3E: concurrency, a block mutation cannot interleave with retirement", () => {
  it("a timed-block insert blocks on the studio capacity lock held by a retiring txn", async () => {
    const a = new Client({ connectionString: resolveLocalDbUrl() });
    const b = new Client({ connectionString: resolveLocalDbUrl() });
    await a.connect();
    await b.connect();
    try {
      // A holds the studio lock (as retirement would, before its preflight).
      await a.query("begin");
      await a.query("select public.acquire_studio_capacity_lock($1)", [B.studioId]);
      // B's block insert takes the same lock in its BEFORE guard -> blocks -> times out.
      await b.query("begin");
      await b.query("set local statement_timeout = '800ms'");
      await expect(
        b.query(
          `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id)
           values ($1,$2,$3,$4,'break',$5)`,
          [randomUUID(), B.studioId, T10, T11, P(1)],
        ),
      ).rejects.toMatchObject({ code: "57014" });
      await b.query("rollback").catch(() => undefined);
      await a.query("rollback");
    } finally {
      await a.end();
      await b.end();
    }
  });
});

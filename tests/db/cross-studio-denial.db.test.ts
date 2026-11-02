import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import {
  adminQuery,
  asUser,
  closePool,
  resolveLocalDbUrl,
  seedMember,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// HON-44: two studios, REAL sessions (role authenticated + the user's JWT claims, so every RLS policy and auth.uid() behave as
// through PostgREST), direct table writes and RPCs. Every denial has a POSITIVE CONTROL with the same statement shape from the
// rightful actor, so a denial cannot pass because the statement was malformed or the row never existed.
//
// OPEN GAPS (team/HON44-GAPS.md H1, H2) are asserted with `it.fails`: the test passes today BECAUSE the gap exists and turns red
// the moment it is closed, which is the signal to change `it.fails` to `it`. The fix is held (unnumbered SQL, never hosted).

let A: SeededStudio;
let B: SeededStudio;
let memberA: { userId: string; practitionerId: string };

type Row = Record<string, unknown>;
const RLS = "42501";

// Runs a statement as `userId`; returns { rows, rowCount } or { code } when it raises.
async function attempt(userId: string, sql: string, params: unknown[] = []) {
  try {
    const r = await asUser(userId, (q) => q(sql, params));
    return { rows: r.rows as Row[], rowCount: r.rowCount ?? 0, code: null as string | null };
  } catch (e) {
    return { rows: [] as Row[], rowCount: 0, code: (e as { code?: string }).code ?? "ERR" };
  }
}
const denied = (r: { rowCount: number; code: string | null }) => r.code !== null || r.rowCount === 0;

type TableSpec = {
  table: string;
  /** owner-only by product design (a non-owner practitioner must not write it) */
  ownerOnly: boolean;
  /** an OPEN GAP in the current chain (see header) */
  openGap?: "H1" | "H2";
  seed: (s: SeededStudio) => Promise<string>; // returns the id of a seeded row
  insert: (s: SeededStudio) => { sql: string; params: unknown[] };
};

const TABLES: TableSpec[] = [
  {
    table: "clients",
    ownerOnly: false,
    seed: async (s) => s.clientId,
    insert: (s) => ({ sql: `insert into public.clients (studio_id, name) values ($1, 'denial probe')`, params: [s.studioId] }),
  },
  {
    table: "services",
    ownerOnly: true,
    openGap: "H1",
    seed: async (s) => {
      const id = randomUUID();
      await adminQuery(`insert into public.services (id, studio_id, name) values ($1, $2, 'Probe service')`, [id, s.studioId]);
      return id;
    },
    insert: (s) => ({ sql: `insert into public.services (studio_id, name) values ($1, 'denial probe')`, params: [s.studioId] }),
  },
  {
    table: "consent_form_templates",
    ownerOnly: true,
    openGap: "H2",
    seed: async (s) => {
      const id = randomUUID();
      await adminQuery(
        `insert into public.consent_form_templates (id, studio_id, title, body) values ($1, $2, 'Probe', 'Probe body')`,
        [id, s.studioId],
      );
      return id;
    },
    insert: (s) => ({
      sql: `insert into public.consent_form_templates (studio_id, title, body) values ($1, 'denial probe', 'denial probe body')`,
      params: [s.studioId],
    }),
  },
  {
    table: "client_pricing",
    ownerOnly: true,
    seed: async (s) => {
      const id = randomUUID();
      await adminQuery(
        `insert into public.client_pricing (id, studio_id, client_id, service_name, price_cents) values ($1, $2, $3, 'Probe', 1000)`,
        [id, s.studioId, s.clientId],
      );
      return id;
    },
    insert: (s) => ({
      sql: `insert into public.client_pricing (studio_id, client_id, service_name, price_cents) values ($1, $2, 'Probe', 1000)`,
      params: [s.studioId, s.clientId],
    }),
  },
  {
    table: "pending_invitations",
    ownerOnly: true,
    seed: async (s) => {
      const id = randomUUID();
      await adminQuery(`insert into public.pending_invitations (id, studio_id, email) values ($1, $2, $3)`, [
        id,
        s.studioId,
        `probe-${id.slice(0, 8)}@harness.local`,
      ]);
      return id;
    },
    insert: (s) => ({
      sql: `insert into public.pending_invitations (studio_id, email) values ($1, $2)`,
      params: [s.studioId, `probe-${randomUUID().slice(0, 8)}@harness.local`],
    }),
  },
  {
    table: "studio_blockouts",
    ownerOnly: true,
    seed: async (s) => {
      const id = randomUUID();
      await adminQuery(`insert into public.studio_blockouts (id, studio_id, starts_on, ends_on) values ($1, $2, '2031-01-01', '2031-01-02')`, [
        id,
        s.studioId,
      ]);
      return id;
    },
    insert: (s) => ({
      // a fresh far-future day each call: overlapping blockouts are refused by an exclusion constraint (23P01)
      sql: `insert into public.studio_blockouts (studio_id, starts_on, ends_on) values ($1, $2::date, $2::date)`,
      params: [s.studioId, new Date(Date.UTC(2040, 0, 1) + Math.floor(Math.random() * 1e5) * 864e5).toISOString().slice(0, 10)],
    }),
  },
];

const seeded = new Map<string, { a: string; b: string }>();

beforeAll(async () => {
  A = await seedStudio("denial-a");
  B = await seedStudio("denial-b");
  memberA = await seedMember(A, "denial-a-member");
  for (const t of TABLES) seeded.set(t.table, { a: await t.seed(A), b: await t.seed(B) });
});

afterAll(async () => {
  await closePool();
});

describe("HON-44 cross-studio: an owner of studio A cannot read or write studio B's rows (direct table access)", () => {
  for (const t of TABLES) {
    describe(t.table, () => {
      it("positive control: the owner of B sees and updates B's row", async () => {
        const id = seeded.get(t.table)!.b;
        const sel = await attempt(B.userId, `select 1 from public.${t.table} where id = $1`, [id]);
        expect(sel.rowCount).toBe(1);
        const upd = await attempt(B.userId, `update public.${t.table} set studio_id = studio_id where id = $1`, [id]);
        expect(upd.code).toBeNull();
        expect(upd.rowCount).toBe(1);
      });
      it("the owner of A cannot read B's row", async () => {
        const r = await attempt(A.userId, `select 1 from public.${t.table} where id = $1`, [seeded.get(t.table)!.b]);
        expect(r.rowCount).toBe(0);
      });
      it("the owner of A cannot update B's row", async () => {
        const r = await attempt(A.userId, `update public.${t.table} set studio_id = studio_id where id = $1`, [seeded.get(t.table)!.b]);
        expect(denied(r)).toBe(true);
        expect(r.rowCount).toBe(0);
      });
      it("the owner of A cannot delete B's row", async () => {
        const r = await attempt(A.userId, `delete from public.${t.table} where id = $1`, [seeded.get(t.table)!.b]);
        expect(r.rowCount).toBe(0);
        const still = await adminQuery(`select 1 from public.${t.table} where id = $1`, [seeded.get(t.table)!.b]);
        expect(still.rowCount).toBe(1);
      });
      it("the owner of A cannot insert a row into B's studio", async () => {
        const { sql, params } = t.insert(B);
        const r = await attempt(A.userId, sql, params);
        expect(r.code).toBe(RLS);
      });
      it("positive control: the same insert shape for the owner's OWN studio is accepted", async () => {
        const { sql, params } = t.insert(A);
        const r = await attempt(A.userId, sql, params);
        expect(r.code).toBeNull();
        expect(r.rowCount).toBe(1);
      });
    });
  }

  it("the owner of A cannot update studio B's settings row, and the owner of B can (positive control)", async () => {
    const no = await attempt(A.userId, `update public.studios set name = name where id = $1`, [B.studioId]);
    expect(no.rowCount).toBe(0);
    const yes = await attempt(B.userId, `update public.studios set name = name where id = $1`, [B.studioId]);
    expect(yes.rowCount).toBe(1);
  });
});

describe("HON-44 role: a non-owner practitioner of the same studio cannot write owner-only tables", () => {
  for (const t of TABLES.filter((x) => x.ownerOnly)) {
    const body = async () => {
      const id = seeded.get(t.table)!.a;
      // positive control inside the test: the OWNER of the same studio can do the same update and insert
      const ownerUpd = await attempt(A.userId, `update public.${t.table} set studio_id = studio_id where id = $1`, [id]);
      expect(ownerUpd.rowCount).toBe(1);
      const ins = t.insert(A);
      const ownerIns = await attempt(A.userId, ins.sql, ins.params);
      expect(ownerIns.code).toBeNull();

      const upd = await attempt(memberA.userId, `update public.${t.table} set studio_id = studio_id where id = $1`, [id]);
      expect(upd.rowCount).toBe(0);
      const ins2 = t.insert(A);
      const memberIns = await attempt(memberA.userId, ins2.sql, ins2.params);
      expect(memberIns.code).toBe(RLS);
    };
    if (t.openGap) {
      // OPEN GAP: passes while the member policy exists; turns red when the held fix lands. Then change `it.fails` to `it`.
      it.fails(`${t.table}: member write is denied (OPEN GAP ${t.openGap}, see HON44-GAPS.md; remove .fails when fixed)`, body);
    } else {
      it(`${t.table}: member write is denied`, body);
    }
  }

  it("a non-owner practitioner CAN write the shared clinical table clients in their own studio (positive control for the matrix)", async () => {
    const r = await attempt(memberA.userId, `update public.clients set name = name where id = $1`, [A.clientId]);
    expect(r.rowCount).toBe(1);
  });
});

describe("HON-44 direct API: service-role-only commands are not callable by a signed-in user", () => {
  const CASES: [string, string][] = [
    ["practitioner_cancel_appointment", `select public.practitioner_cancel_appointment($1::uuid, $2::uuid, $3::uuid, 'x')`],
    ["mark_appointment_no_show", `select public.mark_appointment_no_show($1::uuid, $2::uuid, $3::uuid)`],
    ["mark_appointment_complete", `select public.mark_appointment_complete($1::uuid, $2::uuid, $3::uuid)`],
    ["set_appointment_notes", `select public.set_appointment_notes($1::uuid, $2::uuid, $3::uuid, 'x')`],
  ];
  it.each(CASES)("%s: EXECUTE is refused for authenticated (42501)", async (_name, sql) => {
    const r = await attempt(A.userId, sql, [randomUUID(), A.studioId, A.practitionerId]);
    expect(r.code).toBe(RLS);
  });
  it("positive control: the same function IS executable by the service role, so the refusal is the ACL and not a typo", async () => {
    const r = await adminQuery(`select public.mark_appointment_no_show($1::uuid, $2::uuid, $3::uuid) as r`, [
      randomUUID(),
      A.studioId,
      A.practitionerId,
    ]);
    expect(r.rows[0].r).toBe("wrong_status"); // unknown appointment: reached the body
  });
});

describe("HON-44 cross-studio RPCs that a signed-in user CAN execute", () => {
  let sessB: { sessionId: string; blockId: string };
  let sessA: { sessionId: string; blockId: string };
  beforeAll(async () => {
    sessB = await seedSession(B);
    sessA = await seedSession(A);
  });

  it("set_next_session_note: B's owner can; A's owner cannot touch B's session", async () => {
    const ok = await attempt(B.userId, `select public.set_next_session_note($1::uuid, $2::uuid, 'ok')`, [sessB.sessionId, B.clientId]);
    expect(ok.code).toBeNull();
    const no = await attempt(A.userId, `select public.set_next_session_note($1::uuid, $2::uuid, 'cross')`, [sessB.sessionId, B.clientId]);
    expect(no.code).not.toBeNull();
    const after = await adminQuery(`select next_session_note from public.sessions where id = $1`, [sessB.sessionId]);
    expect(after.rows[0].next_session_note).toBe("ok");
  });

  it("set_session_aftercare_explained: B's owner can; A's owner cannot", async () => {
    const ok = await attempt(B.userId, `select public.set_session_aftercare_explained($1::uuid, true)`, [sessB.sessionId]);
    expect(ok.code).toBeNull();
    const no = await attempt(A.userId, `select public.set_session_aftercare_explained($1::uuid, false)`, [sessB.sessionId]);
    expect(no.code).not.toBeNull();
    const after = await adminQuery(`select aftercare_and_risks_explained_at is not null as set from public.sessions where id = $1`, [sessB.sessionId]);
    expect(after.rows[0].set).toBe(true);
  });

  it("set_session_performer: cross-studio session and cross-studio performer are both refused; the rightful call works", async () => {
    const ok = await attempt(A.userId, `select public.set_session_performer($1::uuid, $2::uuid, $3::uuid)`, [sessA.sessionId, A.clientId, memberA.practitionerId]);
    expect(ok.code).toBeNull();
    const crossSession = await attempt(A.userId, `select public.set_session_performer($1::uuid, $2::uuid, $3::uuid)`, [sessB.sessionId, B.clientId, A.practitionerId]);
    expect(crossSession.code).not.toBeNull();
    const crossPerformer = await attempt(A.userId, `select public.set_session_performer($1::uuid, $2::uuid, $3::uuid)`, [sessA.sessionId, A.clientId, B.practitionerId]);
    expect(crossPerformer.code).not.toBeNull();
    const after = await adminQuery(`select performed_by_practitioner_id as p from public.sessions where id = $1`, [sessA.sessionId]);
    expect(after.rows[0].p).toBe(memberA.practitionerId);
  });

  it("set_session_price is owner-only: A's member is refused on A's own session, A's owner is accepted, A's owner is refused on B's", async () => {
    const owner = await attempt(A.userId, `select public.set_session_price($1::uuid, $2::uuid, 5000)`, [sessA.sessionId, A.clientId]);
    expect(owner.code).toBeNull();
    const member = await attempt(memberA.userId, `select public.set_session_price($1::uuid, $2::uuid, 6000)`, [sessA.sessionId, A.clientId]);
    expect(member.code).not.toBeNull();
    const cross = await attempt(A.userId, `select public.set_session_price($1::uuid, $2::uuid, 7000)`, [sessB.sessionId, B.clientId]);
    expect(cross.code).not.toBeNull();
  });

  it("owner-scoped setting RPCs that take a studio id refuse another studio's id and accept the caller's own", async () => {
    // reorder_studio_service: owner of the named studio only (0161).
    const svcB = randomUUID();
    await adminQuery(`insert into public.services (id, studio_id, name) values ($1, $2, 'Probe')`, [svcB, B.studioId]);
    const cross = await attempt(A.userId, `select * from public.reorder_studio_service($1::uuid, $2::uuid, 'up', 0)`, [B.studioId, svcB]);
    const own = await attempt(B.userId, `select * from public.reorder_studio_service($1::uuid, $2::uuid, 'up', 0)`, [B.studioId, svcB]);
    // The rightful call must reach the function body (any outcome except a privilege/authorization error); the cross call must not.
    expect(own.code === null || own.code !== RLS).toBe(true);
    expect(cross.code !== null || cross.rows.length === 0 || JSON.stringify(cross.rows).includes("not_")).toBe(true);
    expect(JSON.stringify(cross.rows)).not.toContain(svcB);
  });
});

// The fix for H1/H2 is held as unnumbered SQL. When HONE_HELD_FIX_SQL points at it, apply it INSIDE a transaction (DDL is
// transactional) and prove it: a non-owner practitioner is refused, the owner is not, cross-studio stays refused, and nothing
// persists. Skipped in CI. Never run against a hosted database.
const HELD = process.env.HONE_HELD_FIX_SQL;
describe.skipIf(!HELD)("HON-44 held fix H1/H2 (unnumbered SQL, applied in a rolled-back transaction on an isolated stack only)", () => {
  it("after the fix: members are refused on services and consent_form_templates, owners are accepted, B stays out of reach", async () => {
    const sql = readFileSync(HELD!, "utf8").replace(/^\s*begin;\s*$/im, "").replace(/^\s*commit;\s*$/im, "");
    const pool = new pg.Pool({ connectionString: resolveLocalDbUrl(), max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      try {
        await client.query(sql);
        const run = async (userId: string, text: string, params: unknown[]) => {
          await client.query("savepoint s");
          await client.query("set local role authenticated");
          await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
          try {
            const r = await client.query(text, params);
            return { code: null as string | null, rowCount: r.rowCount ?? 0 };
          } catch (e) {
            return { code: (e as { code?: string }).code ?? "ERR", rowCount: 0 };
          } finally {
            await client.query("rollback to savepoint s");
            await client.query("reset role");
          }
        };
        for (const t of TABLES.filter((x) => x.openGap)) {
          const id = seeded.get(t.table)!.a;
          const ins = t.insert(A);
          expect((await run(A.userId, `update public.${t.table} set studio_id = studio_id where id = $1`, [id])).rowCount).toBe(1);
          expect((await run(A.userId, ins.sql, ins.params)).code).toBeNull();
          expect((await run(memberA.userId, `update public.${t.table} set studio_id = studio_id where id = $1`, [id])).rowCount).toBe(0);
          expect((await run(memberA.userId, ins.sql, ins.params)).code).toBe(RLS);
          const insB = t.insert(B);
          expect((await run(A.userId, insB.sql, insB.params)).code).toBe(RLS);
        }
      } finally {
        await client.query("rollback");
      }
    } finally {
      client.release();
      await pool.end();
    }
    // nothing persisted: members are still (wrongly) able to update services until the fix is really applied
    const probe = await attempt(memberA.userId, `update public.services set studio_id = studio_id where id = $1`, [seeded.get("services")!.a]);
    expect(probe.rowCount).toBe(1);
  });
});

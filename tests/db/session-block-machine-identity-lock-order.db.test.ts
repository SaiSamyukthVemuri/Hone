import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import {
  adminQuery,
  asUser,
  closePool,
  resolveLocalDbUrl,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// 0301: LOCK ORDER OF THE SETUP-SAVE WRAPPER (Insurance Z-3).
//
// 0223 fixes the order SESSION, then BLOCK (assert_setup_scope). copy_session_setup
// (0157) and correct_finalized_session (0120) hold the SESSION FOR UPDATE and then
// want its blocks. A wrapper that took the BLOCK first and the session second formed
// a cycle with them. The wrapper takes the session FOR SHARE first, then the block
// FOR UPDATE.
//
// Three proofs here:
//   1. copy_session_setup FROM a session vs a setup save on one of its blocks.
//   2. correct_finalized_session (RETIRED by 0159: EXECUTE is revoked from every API
//      role, so this runs as the table owner with the caller's identity set) vs a
//      setup save. It locks the session FOR UPDATE and is then REFUSED ("not enabled")
//      BEFORE it touches any block, because a CHECK on studios forbids enabling
//      corrections at all. So the inversion cannot form with it today; the guard pins
//      exactly that (it is refused before the block step, and the flag cannot be set),
//      so the day the retirement is lifted this test goes red and the order is
//      re-examined instead of silently assumed.
//   3. A deterministic control that replays the lock SEQUENCE of both writers with an
//      explicit pause, so the cycle forms every time on a wrapper that takes the block
//      first, rather than on a lucky interleaving.
// ===========================================================================

const PROFILE = "fixture:db-lockorder";
const VERSION = 1;
const ROUNDS = Number(process.env.LOCKORDER_ROUNDS ?? 24);

afterAll(async () => {
  await closePool();
});

async function register(studio: SeededStudio): Promise<string> {
  await adminQuery(`select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`, [
    PROFILE,
    VERSION,
    "galvanic",
    4,
    null,
    JSON.stringify([{ field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true }]),
  ]);
  return asUser(studio.userId, async (q) => {
    const r = await q(`select public.register_studio_machine($1,$2,$3,$4,$5) as id`, [
      studio.studioId,
      PROFILE,
      VERSION,
      "Room 1",
      [],
    ]);
    return r.rows[0].id as string;
  });
}

const groups = (channel: number) => [
  {
    new_group_ref: `g${channel}`,
    channels: [channel],
    readings: [{ field_key: "current", value: String(channel), observation_source: "practitioner-entered" }],
  },
];

const save = (studio: SeededStudio, sessionId: string, blockId: string, machine: string, key: string) =>
  asUser(studio.userId, (q) =>
    q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7) as r`, [
      blockId,
      machine,
      "galvanic",
      key,
      JSON.stringify(groups(1)),
      sessionId,
      studio.clientId,
    ]),
  );

async function seedSource(studio: SeededStudio, finalized: boolean) {
  const sessionId = randomUUID();
  const blockId = randomUUID();
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  try {
    // Triggers off for THIS connection only: a finalized native record cannot be built
    // through the (retired) commands, and this file needs one to exercise the lock order.
    await c.query("set session_replication_role = replica");
    await c.query(
      `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, record_status, record_origin, record_version, started_at)
       values ($1,$2,$3,$4,'electrolysis',$5,'native',1,'2026-01-01T10:00:00Z')`,
      [sessionId, studio.studioId, studio.clientId, studio.practitionerId, finalized ? "finalized" : "draft"],
    );
    await c.query(
      `insert into public.session_blocks (id, studio_id, session_id, sort_order, primary_area, side, mode, energy_level)
       values ($1,$2,$3,1,'Chin','left','blend',10)`,
      [blockId, studio.studioId, sessionId],
    );
    await c.query(
      `insert into public.session_block_areas (id, studio_id, session_block_id, area, laterality, display_order)
       values ($1,$2,$3,'Chin','left',0)`,
      [randomUUID(), studio.studioId, blockId],
    );
  } finally {
    await c.end();
  }
  return { sessionId, blockId };
}

const deadlocked = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" &&
  (((r.reason as { code?: string })?.code === "40P01") || /deadlock detected/i.test(String((r.reason as Error)?.message ?? r.reason)));

const jitter = () => new Promise((res) => setTimeout(res, Math.floor(Math.random() * 25)));

describe("0301: the setup-save wrapper takes SESSION then BLOCK (Insurance Z-3)", () => {
  it("(1) copy_session_setup FROM the session vs a setup save on one of its blocks: no deadlock, round after round", async () => {
    const studio = await seedStudio("lockorder-copy");
    const machine = await register(studio);
    const spec = [
      {
        block: { mode: "blend", energy_level: 12, machine_frequency: "13.56 MHz", primary_area: "Chin", side: "left" },
        areas: [{ area: "Chin", laterality: "left", display_order: 0 }],
        entry: { area: "Chin", areas: ["Chin"], mode: "blend", thermolysis_intensity_percent: 40 },
      },
    ];
    let bothCommitted = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const { sessionId: source, blockId } = await seedSource(studio, false);
      const target = (await seedSource(studio, false)).sessionId;
      await adminQuery(`delete from public.session_blocks where session_id = $1`, [target]);
      const fp = (await adminQuery("select public._whole_session_copy_fingerprint($1) as fp", [source])).rows[0].fp as string;
      const copier = new Client({ connectionString: resolveLocalDbUrl() });
      await copier.connect();
      try {
        await copier.query("set statement_timeout = '20s'");
        const settled = await Promise.allSettled([
          (async () => {
            await jitter();
            return copier.query(`select public.copy_session_setup($1,$2,$3,$4::jsonb,$5,$6,$7)`, [
              studio.studioId, target, studio.practitionerId, JSON.stringify(spec), randomUUID(), fp, source,
            ]);
          })(),
          (async () => {
            await jitter();
            return save(studio, source, blockId, machine, `lockorder-copy-${round}`);
          })(),
        ]);
        expect(settled.filter(deadlocked).length, `round ${round}: ${JSON.stringify(settled.map((s) => s.status))}`).toBe(0);
        // Both commit, or one is refused cleanly: never both refused.
        expect(settled.some((s) => s.status === "fulfilled"), `round ${round}`).toBe(true);
        if (settled.every((s) => s.status === "fulfilled")) bothCommitted++;
      } finally {
        await copier.end();
      }
    }
    expect(bothCommitted).toBeGreaterThanOrEqual(0);
  }, 900_000);

  it("(2) guard: correct_finalized_session is refused BEFORE its block step, and the studio flag that would let it past cannot be set", async () => {
    const studio = await seedStudio("lockorder-correct-guard");
    const { sessionId, blockId } = await seedSource(studio, true);
    await expect(
      adminQuery(`update public.studios set clinical_corrections_enabled = true where id = $1`, [studio.studioId]),
    ).rejects.toThrow(/studios_clinical_corrections_retired/);
    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    try {
      await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: studio.userId, role: "authenticated" })]);
      await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [studio.userId]);
      await expect(
        c.query(`select * from public.correct_finalized_session($1,1,'lock order',$2::jsonb)`, [
          sessionId,
          JSON.stringify({ blocks: [{ id: blockId, tolerance_rating: 3 }] }),
        ]),
      ).rejects.toThrow(/not enabled/i);
    } finally {
      await c.end();
    }
    const after = await adminQuery(`select tolerance_rating from public.session_blocks where id = $1`, [blockId]);
    expect(after.rows[0].tolerance_rating).toBeNull();
  });

  it("(2) correct_finalized_session vs a setup save: refused or committed, never a deadlock", async () => {
    const studio = await seedStudio("lockorder-correct");
    const machine = await register(studio);
    for (let round = 0; round < ROUNDS; round++) {
      const { sessionId, blockId } = await seedSource(studio, true);
      const c = new Client({ connectionString: resolveLocalDbUrl() });
      await c.connect();
      try {
        await c.query("set statement_timeout = '20s'");
        await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: studio.userId, role: "authenticated" })]);
        await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [studio.userId]);
        const settled = await Promise.allSettled([
          (async () => {
            await jitter();
            return c.query(`select * from public.correct_finalized_session($1,1,'lock order',$2::jsonb)`, [
              sessionId,
              JSON.stringify({ blocks: [{ id: blockId, tolerance_rating: 3 }] }),
            ]);
          })(),
          (async () => {
            await jitter();
            return save(studio, sessionId, blockId, machine, `lockorder-correct-${round}`);
          })(),
        ]);
        expect(settled.filter(deadlocked).length, `round ${round}: ${JSON.stringify(settled.map((s) => s.status))}`).toBe(0);
      } finally {
        await c.end();
      }
    }
  }, 900_000);

  it("(3) CONTROL, deterministic: a writer holding the SESSION FOR UPDATE and then wanting the BLOCK (the lock sequence of both) never deadlocks with a save", async () => {
    const studio = await seedStudio("lockorder-sequence");
    const machine = await register(studio);
    const { sessionId, blockId } = await seedSource(studio, false);
    const a = new Client({ connectionString: resolveLocalDbUrl() });
    await a.connect();
    try {
      await a.query("set statement_timeout = '30s'");
      await a.query("begin");
      await a.query(`select 1 from public.sessions where id = $1 for update`, [sessionId]);
      // The save starts while the writer holds the session and has not yet asked for the block.
      const saveP = Promise.allSettled([save(studio, sessionId, blockId, machine, "lockorder-seq")]);
      // Long enough for the save to take whatever it takes first, and past deadlock_timeout (1s)
      // once the writer then asks for the block.
      await new Promise((res) => setTimeout(res, 600));
      const writer = await Promise.allSettled([
        a.query(`select 1 from public.session_blocks where id = $1 for update`, [blockId]),
      ]);
      expect(writer.filter(deadlocked).length, "the writer").toBe(0);
      await a.query("commit");
      const [saved] = await saveP;
      expect(deadlocked(saved), "the save").toBe(false);
      expect(saved.status).toBe("fulfilled");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await a.end();
    }
  }, 60_000);

  // V-2 / EZ-2: an EXECUTED negative control on the OLD lock order, in the suite so it runs every time. The lock
  // sequence is the wrapper's own, on a raw connection, against a writer holding the SESSION FOR UPDATE and then
  // asking for the BLOCK (what copy_session_setup does). Block-then-session (the c8ff4cc16 order) must deadlock;
  // session-then-block (the shipped order) must not. The pair proves the harness CAN see the cycle, so the green
  // on the shipped order is not a blind spot.
  const lockSequence = async (order: "block-first" | "session-first") => {
    const studio = await seedStudio(`lockorder-variant-${order}`);
    const { sessionId, blockId } = await seedSource(studio, false);
    const writer = new Client({ connectionString: resolveLocalDbUrl() });
    const saver = new Client({ connectionString: resolveLocalDbUrl() });
    await writer.connect();
    await saver.connect();
    try {
      await writer.query("set statement_timeout = '30s'");
      await saver.query("set statement_timeout = '30s'");
      await writer.query("begin");
      await writer.query(`select 1 from public.sessions where id = $1 for update`, [sessionId]);
      const saverP = Promise.allSettled([
        (async () => {
          await saver.query("begin");
          if (order === "block-first") {
            await saver.query(`select 1 from public.session_blocks where id = $1 for update`, [blockId]);
            await saver.query(`select 1 from public.sessions where id = $1 for share`, [sessionId]);
          } else {
            await saver.query(`select 1 from public.sessions where id = $1 for share`, [sessionId]);
            await saver.query(`select 1 from public.session_blocks where id = $1 for update`, [blockId]);
          }
          await saver.query("commit");
        })(),
      ]);
      await new Promise((res) => setTimeout(res, 600));
      const writerR = await Promise.allSettled([
        writer.query(`select 1 from public.session_blocks where id = $1 for update`, [blockId]),
      ]);
      await writer.query("commit").catch(() => undefined);
      const [saverR] = await saverP;
      await saver.query("rollback").catch(() => undefined);
      return { writerDeadlocked: deadlocked(writerR[0]), saverDeadlocked: deadlocked(saverR) };
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await writer.end();
      await saver.end();
    }
  };

  it("NEGATIVE CONTROL (executed): the OLD order, block before session, DEADLOCKS against a session-then-block writer", async () => {
    const r = await lockSequence("block-first");
    expect(r.writerDeadlocked || r.saverDeadlocked, JSON.stringify(r)).toBe(true);
  }, 60_000);

  it("the SHIPPED order, session before block, does not deadlock against the same writer", async () => {
    const r = await lockSequence("session-first");
    expect(r, JSON.stringify(r)).toEqual({ writerDeadlocked: false, saverDeadlocked: false });
  }, 60_000);

  it("(source order) the wrapper takes the session before the block, and both before the inner command", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const sql = readFileSync("supabase/migrations/0301_session_block_machine_identity.sql", "utf8");
    const body = sql.slice(sql.indexOf("function public.record_setup_submission_with_identity"));
    const session = body.indexOf("from public.sessions s");
    const block = body.indexOf("from public.session_blocks b");
    const inner = body.indexOf("public.record_treatment_setup_submission(");
    expect(session).toBeGreaterThan(-1);
    expect(session).toBeLessThan(block);
    expect(block).toBeLessThan(inner);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
  closePool,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// L18 Phase 2 — session_blocks + electrolysis_entries commands (migration 0166)
// ===========================================================================
//
// Three workflows previously wrote a block AND an entry for ONE user intent
// across SEPARATE transactions. Each command below performs its whole workflow
// in one function body, so a failure anywhere rolls the lot back.
//
// SCOPE: additive. No table privilege is revoked, so direct DML still works —
// asserted below so this PR cannot be mistaken for having revoked production
// access. L18 remains OPEN.

const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

let A: SeededStudio;
let B: SeededStudio;
let sessionA: string;
let sessionB: string;
let blockA: string;
let blockB: string;

beforeAll(async () => {
  A = await seedStudio("l18p2-a");
  B = await seedStudio("l18p2-b");
  const a = await seedSession(A);
  sessionA = a.sessionId;
  blockA = a.blockId;
  const b = await seedSession(B);
  sessionB = b.sessionId;
  blockB = b.blockId;
});
afterAll(async () => {
  await closePool();
});

const CREATE_SQL = `select * from public.create_block_with_entry(
  $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,$15::jsonb,
  $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`;

function createArgs(over: Record<string, unknown> = {}) {
  const a: Record<string, unknown> = {
    session: sessionA,
    client: A.clientId,
    block: JSON.stringify({ block_name: "Main", mode: "thermo" }),
    extra: JSON.stringify({}),
    areas: JSON.stringify([]),
    withEntry: true,
    area: "chin",
    areasList: ["chin"],
    probeSize: null,
    probeLotId: null,
    mode: "thermo",
    pulseCount: 1,
    pulseDelay: null,
    comments: null,
    chips: JSON.stringify([]),
    apilus: null,
    energy: null,
    minutes: null,
    probeType: null,
    freq: null,
    hairs: null,
    galvMa: null,
    galvDur: null,
    thermInt: null,
    thermDur: null,
    lye: null,
    ...over,
  };
  return [
    a.session, a.client, a.block, a.extra, a.areas, a.withEntry, a.area, a.areasList,
    a.probeSize, a.probeLotId, a.mode, a.pulseCount, a.pulseDelay,
    a.comments, a.chips, a.apilus, a.energy, a.minutes, a.probeType, a.freq,
    a.hairs, a.galvMa, a.galvDur, a.thermInt, a.thermDur, a.lye,
  ];
}

const PASS_SQL = `select * from public.add_electrolysis_pass(
  $1,$2,$3,$4::jsonb,$5,$6::text[],$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,
  $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`;

function passArgs(over: Record<string, unknown> = {}) {
  const a: Record<string, unknown> = {
    session: sessionA, client: A.clientId, block: blockA,
    defaults: JSON.stringify({ block_name: "Main" }),
    area: "jaw", areasList: ["jaw"], probeSize: null, probeLotId: null,
    mode: "thermo", intensity: null, duration: null,
    pulseCount: 1, pulseDelay: null, comments: null, chips: JSON.stringify([]),
    apilus: null, energy: null, minutes: null, probeType: null, freq: null,
    hairs: null, galvMa: null, galvDur: null, thermInt: null, thermDur: null,
    lye: null, ...over,
  };
  return [
    a.session, a.client, a.block, a.defaults, a.area, a.areasList, a.probeSize,
    a.probeLotId, a.mode, a.intensity, a.duration, a.pulseCount,
    a.pulseDelay, a.comments, a.chips, a.apilus, a.energy, a.minutes,
    a.probeType, a.freq, a.hairs, a.galvMa, a.galvDur, a.thermInt, a.thermDur, a.lye,
  ];
}

async function expectDenied(
  userId: string,
  sql: string,
  params: unknown[],
  code = CHECK_VIOLATION,
) {
  let got: string | undefined;
  try {
    await userQuery(userId, sql, params);
  } catch (e) {
    got = (e as { code?: string }).code;
  }
  expect(got).toBe(code);
}

const countBlocks = async (s: string) =>
  (await adminQuery(`select count(*)::int n from public.session_blocks where session_id=$1`, [s]))
    .rows[0].n as number;
const countEntries = async (s: string) =>
  (await adminQuery(`select count(*)::int n from public.electrolysis_entries where session_id=$1`, [s]))
    .rows[0].n as number;

// --------------------------------------------------------------------------
// 1-3. Happy paths.
// --------------------------------------------------------------------------

describe("0166 — authorized workflows succeed", () => {
  it("1. same-studio block + entry creation succeeds atomically", async () => {
    const r = await userQuery(A.userId, CREATE_SQL, createArgs());
    const { block_id, entry_id } = r.rows[0];
    expect(block_id).toBeTruthy();
    expect(entry_id).toBeTruthy();
    const row = await adminQuery(
      `select e.block_id, e.session_id, e.area, b.studio_id
         from public.electrolysis_entries e join public.session_blocks b on b.id=e.block_id
        where e.id=$1`,
      [entry_id],
    );
    expect(row.rows[0].block_id).toBe(block_id);
    expect(row.rows[0].session_id).toBe(sessionA);
    expect(row.rows[0].studio_id).toBe(A.studioId);
  });

  it("2. coupled update succeeds and preserves fractional precision", async () => {
    const c = await userQuery(A.userId, CREATE_SQL, createArgs());
    const { block_id, entry_id } = c.rows[0];
    const r = await userQuery(A.userId,
      `select * from public.update_block_with_entry(
         $1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16,$17,$18::jsonb,
         $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
      [sessionA, A.clientId, block_id, JSON.stringify({}),
       JSON.stringify({ block_name: "Edited" }),
       JSON.stringify([]), null, true, entry_id, "lip", ["lip"], null, null,
       "blend", 2, null, null, JSON.stringify([]), null, null, null, null, null,
       null, 0.5, null, null, 0.733, null]);
    expect(r.rows[0].block_id).toBe(block_id);
    const e = await adminQuery(
      `select area, pulse_count, thermolysis_duration_seconds from public.electrolysis_entries where id=$1`,
      [entry_id]);
    expect(e.rows[0].area).toBe("lip");
    expect(e.rows[0].pulse_count).toBe(2);
    // PicoBlend precision must not truncate.
    expect(Number(e.rows[0].thermolysis_duration_seconds)).toBe(0.733);
  });

  it("3. add-another-pass appends without rewriting unrelated passes", async () => {
    const first = await userQuery(A.userId, PASS_SQL, passArgs({ area: "first" }));
    const firstId = first.rows[0].entry_id as string;
    const before = await adminQuery(
      `select area, comments from public.electrolysis_entries where id=$1`, [firstId]);
    const second = await userQuery(A.userId, PASS_SQL, passArgs({ area: "second" }));
    expect(second.rows[0].entry_id).not.toBe(firstId);
    const after = await adminQuery(
      `select area, comments from public.electrolysis_entries where id=$1`, [firstId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("3b. add-another-pass creates a default block when the session has none", async () => {
    const fresh = await adminQuery(
      `insert into public.sessions (studio_id, client_id, practitioner_id, modality)
       values ($1,$2,$3,'electrolysis') returning id`,
      [A.studioId, A.clientId, A.practitionerId]);
    const sid = fresh.rows[0].id as string;
    expect(await countBlocks(sid)).toBe(0);
    const r = await userQuery(A.userId, PASS_SQL,
      passArgs({ session: sid, block: null, area: "neck" }));
    expect(r.rows[0].block_id).toBeTruthy();
    expect(await countBlocks(sid)).toBe(1);
    expect(await countEntries(sid)).toBe(1);
  });

  it("3c. the default block it creates keeps probe_type and probe_size", async () => {
    // 0129's create INSERT column list contains neither, so routing the legacy
    // block-less caller through this command would otherwise have silently
    // stopped persisting both on the auto-created "Main" block — the same
    // field-drop class this migration exists to close.
    const fresh = await adminQuery(
      `insert into public.sessions (studio_id, client_id, practitioner_id, modality)
       values ($1,$2,$3,'electrolysis') returning id`,
      [A.studioId, A.clientId, A.practitionerId]);
    const sid = fresh.rows[0].id as string;
    const r = await userQuery(A.userId, PASS_SQL, passArgs({
      session: sid, block: null, area: "neck",
      defaults: JSON.stringify({
        block_name: "Main", mode: "thermo",
        probe_type: "insulated", probe_size: "F2",
        block_notes: "carried through",
      }),
    }));
    const blk = await adminQuery(
      `select block_name, mode, probe_type, probe_size, block_notes
         from public.session_blocks where id=$1`, [r.rows[0].block_id]);
    expect(blk.rows[0]).toEqual({
      block_name: "Main", mode: "thermo",
      probe_type: "insulated", probe_size: "F2",
      block_notes: "carried through",
    });
  });

  it("3d. a default-block bag may not smuggle a protected column", async () => {
    const fresh = await adminQuery(
      `insert into public.sessions (studio_id, client_id, practitioner_id, modality)
       values ($1,$2,$3,'electrolysis') returning id`,
      [A.studioId, A.clientId, A.practitionerId]);
    const sid = fresh.rows[0].id as string;
    // studio_id/session_id/deleted_at are never taken from the bag: the command
    // derives them. A forged value is ignored, not applied.
    const r = await userQuery(A.userId, PASS_SQL, passArgs({
      session: sid, block: null, area: "neck",
      defaults: JSON.stringify({
        block_name: "Main",
        studio_id: B.studioId, session_id: sessionB, deleted_at: "2000-01-01T00:00:00Z",
      }),
    }));
    const blk = await adminQuery(
      `select studio_id, session_id, deleted_at from public.session_blocks where id=$1`,
      [r.rows[0].block_id]);
    expect(blk.rows[0].studio_id).toBe(A.studioId);
    expect(blk.rows[0].session_id).toBe(sid);
    expect(blk.rows[0].deleted_at).toBeNull();
  });
});

// --------------------------------------------------------------------------
// 4-5. Atomicity — the point of this phase.
// --------------------------------------------------------------------------

describe("0166 — atomicity: no partial charting state survives", () => {
  it("4. a failing ENTRY write rolls back the block (and its areas)", async () => {
    const before = await countBlocks(sessionA);
    // An invalid mode fails the electrolysis CHECK *after* the block insert.
    await expectDenied(A.userId, CREATE_SQL, createArgs({ mode: "not_a_mode" }));
    expect(
      await countBlocks(sessionA),
      "the block created earlier in the same command must be rolled back",
    ).toBe(before);
  });

  it("4b. a failing entry rolls back the AREA rows too", async () => {
    const before = (await adminQuery(
      `select count(*)::int n from public.session_block_areas`)).rows[0].n as number;
    await expectDenied(A.userId, CREATE_SQL, createArgs({
      areas: JSON.stringify([{ area: "chin", laterality: "left", display_order: 0 }]),
      mode: "bogus",
    }));
    const after = (await adminQuery(
      `select count(*)::int n from public.session_block_areas`)).rows[0].n as number;
    expect(after).toBe(before);
  });

  it("5. a failing BLOCK/area write rolls back the entry (nothing is written)", async () => {
    const b0 = await countBlocks(sessionA);
    const e0 = await countEntries(sessionA);
    // A malformed area payload fails inside the 0129 area command.
    let threw = false;
    try {
      await userQuery(A.userId, CREATE_SQL, createArgs({
        areas: JSON.stringify([{ area: null, laterality: "left", display_order: 0 }]),
      }));
    } catch { threw = true; }
    expect(threw).toBe(true);
    expect(await countBlocks(sessionA)).toBe(b0);
    expect(await countEntries(sessionA)).toBe(e0);
  });
});

// --------------------------------------------------------------------------
// 6-11. Tenancy and forgery.
// --------------------------------------------------------------------------

describe("0166 — cross-studio and forged relationships are refused", () => {
  it("6. a cross-studio session id is rejected", async () => {
    await expectDenied(A.userId, CREATE_SQL, createArgs({ session: sessionB, client: B.clientId }));
  });

  it("7. a cross-studio block id is rejected", async () => {
    await expectDenied(A.userId, PASS_SQL, passArgs({ block: blockB }));
  });

  it("8. a cross-studio entry id is rejected", async () => {
    const other = await adminQuery(
      `insert into public.electrolysis_entries (session_id, block_id, area, mode)
       values ($1,$2,'x','thermo') returning id`, [sessionB, blockB]);
    await expectDenied(A.userId,
      `select * from public.update_block_with_entry(
         $1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16,$17,$18::jsonb,
         $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
      [sessionA, A.clientId, blockA, JSON.stringify({}), JSON.stringify({}), JSON.stringify([]), null,
       true, other.rows[0].id, "x", ["x"], null, null, "thermo", 1, null,
       null, JSON.stringify([]), null, null, null, null, null, null, null, null, null, null, null]);
  });

  it("9. a block from another session cannot be attached", async () => {
    const second = await seedSession(A);
    await expectDenied(A.userId, PASS_SQL,
      passArgs({ session: sessionA, block: second.blockId }));
  });

  it("10. an entry from another block cannot be edited", async () => {
    const c = await userQuery(A.userId, CREATE_SQL, createArgs());
    const entryId = c.rows[0].entry_id as string;
    // Same studio + session, but a DIFFERENT block.
    await expectDenied(A.userId,
      `select * from public.update_block_with_entry(
         $1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16,$17,$18::jsonb,
         $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
      [sessionA, A.clientId, blockA, JSON.stringify({}), JSON.stringify({}), JSON.stringify([]), null,
       true, entryId, "x", ["x"], null, null, "thermo", 1, null, null,
       JSON.stringify([]), null, null, null, null, null, null, null, null, null, null, null]);
  });

  it("11. studio and actor identity cannot be forged — no such parameter exists", async () => {
    const r = await adminQuery(
      `select p.proname, pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public'
          and p.proname in ('create_block_with_entry','update_block_with_entry',
                            'add_electrolysis_pass','soft_delete_session_block')`);
    expect(r.rowCount).toBe(4);
    for (const row of r.rows) {
      expect(String(row.args), `${row.proname} must take no studio/actor param`)
        .not.toMatch(/p_studio_id|practitioner|created_by|p_actor|p_user_id/i);
    }
  });

  it("11b. an INACTIVE practitioner is refused", async () => {
    await adminQuery(`update public.practitioners set active=false where id=$1`, [A.practitionerId]);
    try {
      await expectDenied(A.userId, PASS_SQL, passArgs());
    } finally {
      await adminQuery(`update public.practitioners set active=true where id=$1`, [A.practitionerId]);
    }
  });

  it("11c. a service-role caller (no auth.uid()) is refused", async () => {
    let code: string | undefined;
    try {
      await adminQuery(PASS_SQL, passArgs());
    } catch (e) { code = (e as { code?: string }).code; }
    // service_role has no EXECUTE at all, so this is a privilege refusal.
    expect([INSUFFICIENT_PRIVILEGE, CHECK_VIOLATION]).toContain(code);
  });
});

// --------------------------------------------------------------------------
// 12-17. Existing protections survive.
// --------------------------------------------------------------------------

describe("0166 — existing clinical protections are preserved", () => {
  it("12/13. retirement + legacy snapshot protections are untouched", async () => {
    const r = await adminQuery(
      `select count(*)::int n from pg_trigger t join pg_class c on c.oid=t.tgrelid
        where not t.tgisinternal and c.relname in ('session_blocks','electrolysis_entries')
          and t.tgname like '%guard_finalized%'`);
    expect(r.rows[0].n).toBeGreaterThan(0);
    const flags = await adminQuery(
      `select count(*)::int n from public.studios where clinical_finalization_enabled = true`);
    expect(flags.rows[0].n).toBe(0);
  });

  it("14. immutable lineage columns cannot be changed through the command", async () => {
    const c = await userQuery(A.userId, CREATE_SQL, createArgs());
    const entryId = c.rows[0].entry_id as string;
    // 0160 guards re-pointing an entry to another session. After 0169 there are
    // TWO layers, and both are asserted: `authenticated` is refused by the
    // PRIVILEGE layer, and the 0160 trigger itself is proven still live through
    // service_role, which retains DML.
    let privCode: string | undefined;
    try {
      await userQuery(A.userId,
        `update public.electrolysis_entries set session_id=$2 where id=$1`,
        [entryId, sessionB]);
    } catch (e) { privCode = (e as { code?: string }).code; }
    expect(privCode).toBe("42501");

    let trigCode: string | undefined;
    try {
      await asRole("service_role", (q) =>
        q(`update public.electrolysis_entries set session_id=$2 where id=$1`,
          [entryId, sessionB]));
    } catch (e) { trigCode = (e as { code?: string }).code; }
    expect(trigCode).toBe(CHECK_VIOLATION);
    // And the command itself exposes no lineage parameter.
    const args = await adminQuery(
      `select pg_get_function_arguments(p.oid) a from pg_proc p
         join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='update_block_with_entry'`);
    expect(String(args.rows[0].a)).not.toMatch(/p_session_id_new|p_new_client/i);
  });

  it("15. soft-delete semantics preserved — never a hard delete", async () => {
    const c = await userQuery(A.userId, CREATE_SQL, createArgs());
    const blockId = c.rows[0].block_id as string;
    const r = await userQuery(A.userId,
      `select public.soft_delete_session_block($1,$2,$3,$4) as id`,
      [sessionA, A.clientId, blockId, "removed during automated verification"]);
    expect(r.rows[0].id).toBe(blockId);
    const row = await adminQuery(
      `select deleted_at, deleted_by, delete_reason from public.session_blocks where id=$1`,
      [blockId]);
    expect(row.rowCount, "the row must still exist — soft delete only").toBe(1);
    expect(row.rows[0].deleted_at).not.toBeNull();
    // deleted_by is derived from auth.uid(), never caller-supplied.
    expect(row.rows[0].deleted_by).toBe(A.practitionerId);
    expect(row.rows[0].delete_reason).toBe("removed during automated verification");
  });

  it("16. probe inventory linkage stays studio-consistent", async () => {
    // A probe lot from another studio must be refused by the existing FK/CHECK
    // rather than silently accepted.
    let threw = false;
    try {
      await userQuery(A.userId, PASS_SQL, passArgs({ probeLotId: B.studioId }));
    } catch { threw = true; }
    expect(threw).toBe(true);
  });

  it("17. area linkage is atomic and studio-consistent", async () => {
    const r = await userQuery(A.userId, CREATE_SQL, createArgs({
      areas: JSON.stringify([
        { area: "chin", laterality: "left", display_order: 0 },
        { area: "chin", laterality: "right", display_order: 1 },
      ]),
    }));
    const blockId = r.rows[0].block_id as string;
    const areas = await adminQuery(
      `select count(*)::int n, min(studio_id::text) s from public.session_block_areas where session_block_id=$1`,
      [blockId]);
    expect(areas.rows[0].n).toBe(2);
    expect(areas.rows[0].s).toBe(A.studioId);
  });
});

// --------------------------------------------------------------------------
// 18-20. Privileges.
// --------------------------------------------------------------------------

describe("0166 — effective EXECUTE privileges", () => {
  const COMMANDS = [
    "create_block_with_entry",
    "update_block_with_entry",
    "add_electrolysis_pass",
    "soft_delete_session_block",
  ];
  const HELPERS = ["assert_session_writable", "assert_block_in_session", "write_electrolysis_entry"];

  it("18. authenticated can execute every command", async () => {
    const r = await adminQuery(
      `select p.proname, has_function_privilege('authenticated', p.oid,'execute') x
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname = any($1)`, [COMMANDS]);
    expect(r.rowCount).toBe(4);
    for (const row of r.rows) expect(row.x, `${row.proname}`).toBe(true);
  });

  it("19. anon, PUBLIC and service_role cannot execute any command", async () => {
    const r = await adminQuery(
      `select p.proname,
              has_function_privilege('anon', p.oid,'execute') anon_x,
              has_function_privilege('service_role', p.oid,'execute') svc_x,
              (select count(*)::int from aclexplode(p.proacl) a where a.grantee=0) pub
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname = any($1)`, [COMMANDS]);
    for (const row of r.rows) {
      expect(row.anon_x, `${row.proname} anon`).toBe(false);
      expect(row.svc_x, `${row.proname} service_role`).toBe(false);
      expect(row.pub, `${row.proname} PUBLIC`).toBe(0);
    }
    let code: string | undefined;
    try {
      await asRole("anon", (q) => q(PASS_SQL, passArgs()));
    } catch (e) { code = (e as { code?: string }).code; }
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("19b. internal helpers are NOT callable by authenticated", async () => {
    const r = await adminQuery(
      `select p.proname, has_function_privilege('authenticated', p.oid,'execute') x
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname = any($1)`, [HELPERS]);
    expect(r.rowCount).toBe(3);
    for (const row of r.rows) {
      expect(row.x, `${row.proname} must not be directly callable`).toBe(false);
    }
  });

  it("20. create_laser_entry privileges are unchanged by this migration", async () => {
    const r = await adminQuery(
      `select has_function_privilege('authenticated', p.oid,'execute') auth_x,
              has_function_privilege('anon', p.oid,'execute') anon_x,
              has_function_privilege('service_role', p.oid,'execute') svc_x
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='create_laser_entry'`);
    expect(r.rows[0].auth_x).toBe(true);
    expect(r.rows[0].anon_x).toBe(false);
    expect(r.rows[0].svc_x).toBe(false);
  });

  it("all four commands are SECURITY DEFINER with an empty search_path", async () => {
    const r = await adminQuery(
      `select p.proname, p.prosecdef, array_to_string(p.proconfig,',') cfg
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname = any($1)`, [COMMANDS]);
    for (const row of r.rows) {
      expect(row.prosecdef, `${row.proname}`).toBe(true);
      expect(row.cfg, `${row.proname}`).toBe('search_path=""');
    }
  });

  it("direct table DML is revoked by 0169; 0166 itself revoked nothing", async () => {
    // This phase revoked nothing — correct for its own scope. Migration 0169 is
    // the cutover that removes the capability, so the assertion is INVERTED here
    // rather than deleted, and SELECT is asserted retained.
    const r = await adminQuery(
      `select has_table_privilege('authenticated','public.session_blocks','insert') b,
              has_table_privilege('authenticated','public.electrolysis_entries','insert') e,
              has_table_privilege('authenticated','public.session_blocks','select') bs,
              has_table_privilege('authenticated','public.electrolysis_entries','select') es`);
    expect(r.rows[0].b).toBe(false);
    expect(r.rows[0].e).toBe(false);
    expect(r.rows[0].bs).toBe(true);
    expect(r.rows[0].es).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Strict allow-list block patch (the 0129 field gap this migration closes).
// 0129's update explicitly excludes block_name/block_notes and never touched
// probe_type/probe_size/started_at/ended_at; its insert also omits
// block_notes/probe_type/probe_size. Delegating alone would have SILENTLY
// stopped persisting them.
// --------------------------------------------------------------------------

const UPDATE_SQL = `select * from public.update_block_with_entry(
  $1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16,$17,$18::jsonb,
  $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`;

const patchArgs = (blockId: string, extra: unknown) => [
  sessionA, A.clientId, blockId, JSON.stringify({}), JSON.stringify(extra),
  JSON.stringify([]), null, false, null, null, null, null, null, null, null,
  null, null, JSON.stringify([]), null, null, null, null, null, null,
  null, null, null, null, null,
];

async function freshBlock(extra: unknown = {}): Promise<string> {
  const r = await userQuery(A.userId, CREATE_SQL,
    createArgs({ extra: JSON.stringify(extra), withEntry: false }));
  return r.rows[0].block_id as string;
}
const readBlock = async (id: string) =>
  (await adminQuery(
    `select block_name, block_notes, probe_type, probe_size, started_at, ended_at
       from public.session_blocks where id=$1`, [id])).rows[0];

describe("0166 — the area set and the inventory link are never silently lost", () => {
  it("an ABSENT area set (p_areas null) leaves the recorded areas untouched", async () => {
    // The legacy single-area edit path submits no areas. 0129's update always
    // REPLACES the set, so coalescing null to '[]' would delete them.
    const c = await userQuery(A.userId, CREATE_SQL, createArgs({
      areas: JSON.stringify([
        { area: "chin", laterality: "midline", display_order: 0 },
        { area: "lip", laterality: "midline", display_order: 1 },
      ]),
    }));
    const id = c.rows[0].block_id as string;
    const before = await adminQuery(
      `select area, laterality, display_order from public.session_block_areas
        where session_block_id=$1 order by display_order`, [id]);
    expect(before.rows).toHaveLength(2);

    const args = patchArgs(id, {});
    args[5] = null; // p_areas ABSENT
    await userQuery(A.userId, UPDATE_SQL, args);

    const after = await adminQuery(
      `select area, laterality, display_order from public.session_block_areas
        where session_block_id=$1 order by display_order`, [id]);
    expect(after.rows).toEqual(before.rows);
  });

  it("an EXPLICIT empty set still clears the areas", async () => {
    const c = await userQuery(A.userId, CREATE_SQL, createArgs({
      areas: JSON.stringify([{ area: "chin", laterality: "midline", display_order: 0 }]),
    }));
    const id = c.rows[0].block_id as string;
    const args = patchArgs(id, {});
    args[5] = JSON.stringify([]); // deliberate removal
    await userQuery(A.userId, UPDATE_SQL, args);
    const after = await adminQuery(
      `select count(*)::int n from public.session_block_areas where session_block_id=$1`, [id]);
    expect(after.rows[0].n).toBe(0);
  });

  it("probe_inventory_item_id survives create AND update", async () => {
    // 0129 writes this column on neither path; without the allow-list entry the
    // 0155 inventory link would be dropped by every writer.
    const item = await adminQuery(
      `insert into public.record_keeping_sterile_items (studio_id, date_purchased, item_description)
       values ($1, current_date, 'Ballet F2 probes') returning id`, [A.studioId]);
    const itemId = item.rows[0].id as string;
    const c = await userQuery(A.userId, CREATE_SQL, createArgs({
      extra: JSON.stringify({ probe_inventory_item_id: itemId }),
      withEntry: false,
    }));
    const id = c.rows[0].block_id as string;
    const afterCreate = await adminQuery(
      `select probe_inventory_item_id from public.session_blocks where id=$1`, [id]);
    expect(afterCreate.rows[0].probe_inventory_item_id).toBe(itemId);

    await userQuery(A.userId, UPDATE_SQL, patchArgs(id, { probe_inventory_item_id: itemId }));
    const afterUpdate = await adminQuery(
      `select probe_inventory_item_id from public.session_blocks where id=$1`, [id]);
    expect(afterUpdate.rows[0].probe_inventory_item_id).toBe(itemId);
  });

  it("a cross-studio inventory id is refused by the composite FK, not accepted", async () => {
    // session_blocks FKs (studio_id, probe_inventory_item_id) into
    // record_keeping_sterile_items, so the allow-list writer cannot be used to
    // point a block at another studio's item.
    const other = await adminQuery(
      `insert into public.record_keeping_sterile_items (studio_id, date_purchased, item_description)
       values ($1, current_date, 'Other studio probes') returning id`, [B.studioId]);
    const id = await freshBlock({});
    let code: string | undefined;
    try {
      await userQuery(A.userId, UPDATE_SQL,
        patchArgs(id, { probe_inventory_item_id: other.rows[0].id }));
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("23503"); // foreign_key_violation
  });
});

describe("0166 — strict allow-list block patch", () => {
  it("1/2. CREATE persists block_notes and probe_size exactly", async () => {
    const id = await freshBlock({ block_notes: "left cheek tender", probe_size: "F2" });
    const b = await readBlock(id);
    expect(b.block_notes).toBe("left cheek tender");
    expect(b.probe_size).toBe("F2");
  });

  it("3-8. UPDATE persists every previously-dropped field exactly", async () => {
    const id = await freshBlock();
    const started = "2026-08-02T10:00:00.000Z";
    const ended = "2026-08-02T10:45:00.000Z";
    await userQuery(A.userId, UPDATE_SQL, patchArgs(id, {
      block_name: "Upper lip", block_notes: "second pass",
      probe_type: "IBL", probe_size: "F3",
      started_at: started, ended_at: ended,
    }));
    const b = await readBlock(id);
    expect(b.block_name).toBe("Upper lip");
    expect(b.block_notes).toBe("second pass");
    expect(b.probe_type).toBe("IBL");
    expect(b.probe_size).toBe("F3");
    expect(new Date(b.started_at as string).toISOString()).toBe(started);
    expect(new Date(b.ended_at as string).toISOString()).toBe(ended);
  });

  it("9. a nullable field can be explicitly CLEARED", async () => {
    const id = await freshBlock({ block_notes: "to be cleared", probe_size: "F1" });
    await userQuery(A.userId, UPDATE_SQL, patchArgs(id, { block_notes: null }));
    const b = await readBlock(id);
    expect(b.block_notes, "present-with-null must clear").toBeNull();
    expect(b.probe_size, "an omitted key must be left alone").toBe("F1");
  });

  it("10. an OMITTED field is left unchanged", async () => {
    const id = await freshBlock({ block_notes: "keep me", probe_type: "ITH" });
    await userQuery(A.userId, UPDATE_SQL, patchArgs(id, { block_name: "Renamed" }));
    const b = await readBlock(id);
    expect(b.block_name).toBe("Renamed");
    expect(b.block_notes).toBe("keep me");
    expect(b.probe_type).toBe("ITH");
  });

  it("11. an UNKNOWN patch key is REJECTED, not silently ignored", async () => {
    const id = await freshBlock();
    await expectDenied(A.userId, UPDATE_SQL, patchArgs(id, { not_a_column: "x" }));
  });

  it("12. protected columns cannot be supplied through the patch", async () => {
    const id = await freshBlock();
    for (const key of ["id", "studio_id", "session_id", "sort_order",
                       "deleted_at", "deleted_by", "created_at"]) {
      await expectDenied(A.userId, UPDATE_SQL, patchArgs(id, { [key]: null }));
    }
    // and nothing was mutated by the refused attempts
    const b = await adminQuery(
      `select studio_id, session_id, deleted_at from public.session_blocks where id=$1`, [id]);
    expect(b.rows[0].studio_id).toBe(A.studioId);
    expect(b.rows[0].session_id).toBe(sessionA);
    expect(b.rows[0].deleted_at).toBeNull();
  });

  it("13. a failure in the extra-field assignment rolls back block, areas AND entry", async () => {
    const b0 = await countBlocks(sessionA);
    const e0 = await countEntries(sessionA);
    const a0 = (await adminQuery(
      `select count(*)::int n from public.session_block_areas`)).rows[0].n as number;
    // Unknown key raises AFTER 0129 has created the block + areas.
    await expectDenied(A.userId, CREATE_SQL, createArgs({
      extra: JSON.stringify({ bogus_column: 1 }),
      areas: JSON.stringify([{ area: "chin", laterality: "left", display_order: 0 }]),
    }));
    expect(await countBlocks(sessionA), "block rolled back").toBe(b0);
    expect(await countEntries(sessionA), "entry rolled back").toBe(e0);
    expect(
      (await adminQuery(`select count(*)::int n from public.session_block_areas`)).rows[0].n,
      "areas rolled back",
    ).toBe(a0);
  });

  it("14. the extra UPDATE does not duplicate audit/lineage triggers", async () => {
    // The block is written twice inside one command (0129 + the extra patch).
    // Confirm the lineage guards still fire and the row is coherent — a second
    // UPDATE must not corrupt or re-tenant it.
    const id = await freshBlock({ block_notes: "audit check" });
    const b = await adminQuery(
      `select studio_id, session_id, deleted_at from public.session_blocks where id=$1`, [id]);
    expect(b.rows[0].studio_id).toBe(A.studioId);
    expect(b.rows[0].session_id).toBe(sessionA);
    expect(b.rows[0].deleted_at).toBeNull();
    // Re-pointing is still refused by 0160 — proven through service_role, since
    // after 0169 `authenticated` no longer reaches the trigger at all.
    let trigCode: string | undefined;
    try {
      await asRole("service_role", (q) =>
        q(`update public.session_blocks set session_id=$2 where id=$1`, [id, sessionB]));
    } catch (e) { trigCode = (e as { code?: string }).code; }
    expect(trigCode).toBe(CHECK_VIOLATION);
  });

  it("15. the privilege matrix is unchanged by the extension", async () => {
    const r = await adminQuery(
      `select p.proname,
              has_function_privilege('authenticated', p.oid,'execute') a,
              has_function_privilege('anon', p.oid,'execute') an,
              has_function_privilege('service_role', p.oid,'execute') s
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='apply_block_extra_fields'`);
    expect(r.rows[0].a, "the patch helper stays internal").toBe(false);
    expect(r.rows[0].an).toBe(false);
    expect(r.rows[0].s).toBe(false);
  });
});

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
// L18 Phase 1A — the two clean entry create commands (migration 0164)
// ===========================================================================
//
// `create_electrolysis_entry` and `create_laser_entry` replace the direct table
// INSERTs in addElectrolysisEntryAction and addLaserEntryAction.
//
// SCOPE. This phase is ADDITIVE: no grant is revoked and no policy is dropped,
// so direct DML still works and the deployed application keeps functioning
// before, during and after the apply. That is asserted below, deliberately, so
// this PR cannot be mistaken for having revoked production access.
//
// NOT COVERED HERE: createTreatmentAreaWithEntryAction and
// updateTreatmentAreaWithEntryAction, which write session_blocks AND
// electrolysis_entries as one intent and are deferred to the combined phase.
//
// Every row is synthetic and confined to the disposable local database.

const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

let A: SeededStudio;
let B: SeededStudio;
let sessionA: string;
let sessionB: string;
let blockA: string;

beforeAll(async () => {
  A = await seedStudio("entrycmd-a");
  B = await seedStudio("entrycmd-b");
  const a = await seedSession(A);
  sessionA = a.sessionId;
  blockA = a.blockId;
  const b = await seedSession(B);
  sessionB = b.sessionId;
});
afterAll(async () => {
  await closePool();
});

/** Call create_electrolysis_entry as an authenticated user, with defaults. */
function elecArgs(over: Record<string, unknown> = {}) {
  return {
    p_session_id: sessionA,
    p_client_id: A.clientId,
    p_block_id: blockA,
    p_area: "chin",
    p_areas: ["chin"],
    p_probe_size: null,
    p_probe_lot_id: null,
    p_mode: "thermo",
    p_intensity: null,
    p_duration_seconds: null,
    p_pulse_count: 1,
    p_pulse_delay_seconds: null,
    p_comments: null,
    p_observation_chips: JSON.stringify([]),
    p_apilus_modality: null,
    p_energy_level: null,
    p_minutes_performed: null,
    p_probe_type: null,
    p_machine_frequency: null,
    p_hairs_treated: null,
    p_galvanic_ma: null,
    p_galvanic_duration_seconds: null,
    p_thermolysis_intensity_percent: null,
    p_thermolysis_duration_seconds: null,
    p_units_of_lye: null,
    ...over,
  };
}

const ELEC_SQL = `select public.create_electrolysis_entry(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
) as id`;

function elecParams(a: Record<string, unknown>): unknown[] {
  return [
    a.p_session_id, a.p_client_id, a.p_block_id, a.p_area, a.p_areas,
    a.p_probe_size, a.p_probe_lot_id, a.p_mode, a.p_intensity,
    a.p_duration_seconds, a.p_pulse_count, a.p_pulse_delay_seconds,
    a.p_comments, a.p_observation_chips, a.p_apilus_modality, a.p_energy_level,
    a.p_minutes_performed, a.p_probe_type, a.p_machine_frequency,
    a.p_hairs_treated, a.p_galvanic_ma, a.p_galvanic_duration_seconds,
    a.p_thermolysis_intensity_percent, a.p_thermolysis_duration_seconds,
    a.p_units_of_lye,
  ];
}

const LASER_SQL = `select public.create_laser_entry($1,$2,$3,$4,$5::jsonb,$6) as id`;

async function callElec(userId: string, over: Record<string, unknown> = {}) {
  return userQuery(userId, ELEC_SQL, elecParams(elecArgs(over)));
}
async function expectElecDenied(
  userId: string,
  over: Record<string, unknown>,
  code = CHECK_VIOLATION,
): Promise<void> {
  let got: string | undefined;
  try {
    await callElec(userId, over);
  } catch (e) {
    got = (e as { code?: string }).code;
  }
  expect(got).toBe(code);
}

async function countElec(sessionId: string): Promise<number> {
  const r = await adminQuery(
    `select count(*)::int as n from public.electrolysis_entries where session_id = $1`,
    [sessionId],
  );
  return r.rows[0].n as number;
}

// ---------------------------------------------------------------------------
// 1-2. The authorized happy paths.
// ---------------------------------------------------------------------------

describe("0164 — authorized creates succeed through the commands", () => {
  it("1. authorized electrolysis create succeeds and stores the clinical values", async () => {
    const res = await callElec(A.userId, {
      p_mode: "blend",
      p_hairs_treated: 12,
      p_galvanic_ma: 0.5,
      p_thermolysis_duration_seconds: 0.733,
    });
    const id = res.rows[0].id as string;
    expect(id).toBeTruthy();

    const row = await adminQuery(
      `select session_id, block_id, area, mode, hairs_treated, galvanic_ma,
              thermolysis_duration_seconds, galvanic_intensity_percent, pulse_count
         from public.electrolysis_entries where id = $1`,
      [id],
    );
    expect(row.rows[0].session_id).toBe(sessionA);
    expect(row.rows[0].block_id).toBe(blockA);
    expect(row.rows[0].mode).toBe("blend");
    expect(row.rows[0].hairs_treated).toBe(12);
    expect(Number(row.rows[0].galvanic_ma)).toBe(0.5);
    // Fractional thermolysis duration must NOT truncate to 0.
    expect(Number(row.rows[0].thermolysis_duration_seconds)).toBe(0.733);
    // Retired reading is always NULL, server-authoritatively.
    expect(row.rows[0].galvanic_intensity_percent).toBeNull();
    expect(row.rows[0].pulse_count).toBe(1);
  });

  it("2. authorized laser create succeeds", async () => {
    const res = await userQuery(A.userId, LASER_SQL, [
      sessionA,
      A.clientId,
      "underarm",
      3,
      JSON.stringify({ fluence: "14" }),
      "no adverse response",
    ]);
    const id = res.rows[0].id as string;
    expect(id).toBeTruthy();
    const row = await adminQuery(
      `select session_id, zone, session_number, equipment_params, observation_notes
         from public.laser_entries where id = $1`,
      [id],
    );
    expect(row.rows[0].session_id).toBe(sessionA);
    expect(row.rows[0].zone).toBe("underarm");
    expect(row.rows[0].session_number).toBe(3);
    expect(row.rows[0].equipment_params).toEqual({ fluence: "14" });
  });
});

// ---------------------------------------------------------------------------
// 3-6. Authorization and lineage.
// ---------------------------------------------------------------------------

describe("0164 — authorization and lineage are database-derived", () => {
  it("3. a cross-studio caller is denied", async () => {
    const before = await countElec(sessionA);
    await expectElecDenied(B.userId, {}); // B's user, A's session
    expect(await countElec(sessionA)).toBe(before);

    let code: string | undefined;
    try {
      await userQuery(B.userId, LASER_SQL, [sessionA, A.clientId, "z", null, null, null]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("4a. same-studio caller with the WRONG client is denied", async () => {
    const other = await adminQuery(
      `insert into public.clients (studio_id, name)
       values ($1,'Other Client') returning id`,
      [A.studioId],
    );
    await expectElecDenied(A.userId, { p_client_id: other.rows[0].id });
  });

  it("4b. same-studio caller with a FOREIGN session is denied", async () => {
    await expectElecDenied(A.userId, {
      p_session_id: sessionB,
      p_client_id: B.clientId,
      p_block_id: null,
    });
  });

  it("4c. a block from another session is denied", async () => {
    const bBlock = await adminQuery(
      `select id from public.session_blocks where session_id = $1 limit 1`,
      [sessionB],
    );
    await expectElecDenied(A.userId, { p_block_id: bBlock.rows[0].id });
  });

  it("5. a caller cannot assert another practitioner", async () => {
    // The commands take NO practitioner parameter at all — identity is looked
    // up by auth.uid(). This is the structural proof of that property.
    const args = await adminQuery(
      `select p.proname, pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public'
          and p.proname in ('create_electrolysis_entry','create_laser_entry')`,
    );
    expect(args.rowCount).toBe(2);
    for (const r of args.rows) {
      expect(String(r.args)).not.toMatch(/practitioner|p_studio_id|created_by|actor/i);
    }
  });

  it("5b. an INACTIVE practitioner is denied", async () => {
    await adminQuery(`update public.practitioners set active = false where id = $1`, [
      A.practitionerId,
    ]);
    try {
      await expectElecDenied(A.userId, {});
    } finally {
      await adminQuery(`update public.practitioners set active = true where id = $1`, [
        A.practitionerId,
      ]);
    }
  });

  it("6. studio and client are derived from the session, not the caller", async () => {
    // There is no studio parameter, and the stored row's lineage resolves to
    // the session's own studio/client regardless of what the caller passed.
    const res = await callElec(A.userId);
    const id = res.rows[0].id as string;
    const row = await adminQuery(
      `select e.session_id, s.studio_id, s.client_id
         from public.electrolysis_entries e
         join public.sessions s on s.id = e.session_id
        where e.id = $1`,
      [id],
    );
    expect(row.rows[0].studio_id).toBe(A.studioId);
    expect(row.rows[0].client_id).toBe(A.clientId);
  });
});

// ---------------------------------------------------------------------------
// 7-8. Validation is unchanged — the existing CHECKs remain the authority.
// ---------------------------------------------------------------------------

describe("0164 — modality validation is preserved exactly", () => {
  it("7a. an invalid mode is rejected by the existing CHECK", async () => {
    await expectElecDenied(A.userId, { p_mode: "not_a_mode" }, CHECK_VIOLATION);
  });

  it("7b. an out-of-range pulse_count is rejected", async () => {
    await expectElecDenied(A.userId, { p_pulse_count: 99 }, CHECK_VIOLATION);
  });

  it("7c. an out-of-range thermolysis_intensity_percent is rejected", async () => {
    await expectElecDenied(
      A.userId,
      { p_thermolysis_intensity_percent: 150 },
      CHECK_VIOLATION,
    );
  });

  it("7d. a non-array observation_chips payload is rejected", async () => {
    await expectElecDenied(
      A.userId,
      { p_observation_chips: JSON.stringify({ not: "an array" }) },
      CHECK_VIOLATION,
    );
  });

  it("7e. an invalid apilus_modality is rejected", async () => {
    await expectElecDenied(A.userId, { p_apilus_modality: "Nope" }, CHECK_VIOLATION);
  });

  it("8. a laser entry with a NULL zone is rejected (NOT NULL preserved)", async () => {
    let code: string | undefined;
    try {
      await userQuery(A.userId, LASER_SQL, [sessionA, A.clientId, null, null, null, null]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    // 23502 = not_null_violation
    expect(code).toBe("23502");
  });
});

// ---------------------------------------------------------------------------
// 9-10. Atomicity — the command is one statement, so a refusal leaves nothing.
// ---------------------------------------------------------------------------

describe("0164 — a failed command leaves no residue", () => {
  it("9/10. a rejected create writes no entry row at all", async () => {
    const before = await countElec(sessionA);
    await expectElecDenied(A.userId, { p_mode: "bogus" });
    expect(
      await countElec(sessionA),
      "a refused command must leave no partial entry",
    ).toBe(before);

    // Neither entry table carries an audit side-effect on the create path, so
    // "no audit residue" is the absence of any new row anywhere in the pair.
    const laserBefore = await adminQuery(
      `select count(*)::int as n from public.laser_entries where session_id = $1`,
      [sessionA],
    );
    let code: string | undefined;
    try {
      await userQuery(A.userId, LASER_SQL, [sessionB, A.clientId, "z", null, null, null]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe(CHECK_VIOLATION);
    const laserAfter = await adminQuery(
      `select count(*)::int as n from public.laser_entries where session_id = $1`,
      [sessionA],
    );
    expect(laserAfter.rows[0].n).toBe(laserBefore.rows[0].n);
  });
});

// ---------------------------------------------------------------------------
// 11-12. EXECUTE privileges.
// ---------------------------------------------------------------------------

describe("0164 — EXECUTE is authenticated-only", () => {
  it("11. anon and PUBLIC cannot execute either command", async () => {
    const r = await adminQuery(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon_x
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public'
          and p.proname in ('create_electrolysis_entry','create_laser_entry')`,
    );
    expect(r.rowCount).toBe(2);
    for (const row of r.rows) expect(row.anon_x).toBe(false);

    // And behaviourally, as the anon role.
    let code: string | undefined;
    try {
      await asRole("anon", (q) => q(LASER_SQL, [sessionA, A.clientId, "z", null, null, null]));
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("12. authenticated can execute both commands", async () => {
    const r = await adminQuery(
      `select p.proname,
              has_function_privilege('authenticated', p.oid, 'execute') as auth_x
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public'
          and p.proname in ('create_electrolysis_entry','create_laser_entry')`,
    );
    expect(r.rowCount).toBe(2);
    for (const row of r.rows) expect(row.auth_x).toBe(true);
  });

  it("both commands are SECURITY DEFINER with a pinned empty search_path", async () => {
    const r = await adminQuery(
      `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public'
          and p.proname in ('create_electrolysis_entry','create_laser_entry')`,
    );
    expect(r.rowCount).toBe(2);
    for (const row of r.rows) {
      expect(row.prosecdef).toBe(true);
      expect(row.cfg).toBe('search_path=""');
    }
  });

  it("a service-role caller (no auth.uid()) is refused — no admin shortcut exists", async () => {
    let code: string | undefined;
    try {
      await adminQuery(LASER_SQL, [sessionA, A.clientId, "z", null, null, null]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe(CHECK_VIOLATION);
  });
});

// ---------------------------------------------------------------------------
// 14-15. Neighbouring boundaries, and the additive property of this phase.
// ---------------------------------------------------------------------------

describe("0164 — additive phase: existing boundaries and direct DML intact", () => {
  it("15. direct DML REMAINS available on both entry tables during this phase", async () => {
    const r = await adminQuery(
      `select has_table_privilege('authenticated','public.electrolysis_entries','insert') as e_ins,
              has_table_privilege('authenticated','public.laser_entries','insert')        as l_ins`,
    );
    expect(
      r.rows[0].e_ins,
      "this PR must NOT have revoked production access",
    ).toBe(true);
    expect(r.rows[0].l_ins).toBe(true);

    // And it genuinely still works for the deferred block-coupled writers.
    const direct = await userQuery(
      A.userId,
      `insert into public.electrolysis_entries (session_id, block_id, area, mode)
       values ($1,$2,'jaw','thermo') returning id`,
      [sessionA, blockA],
    );
    expect(direct.rowCount).toBe(1);
  });

  it("14a. the 0162 intake review boundary is untouched", async () => {
    const r = await adminQuery(
      `select md5(pg_get_functiondef(p.oid)) as md5
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='enforce_intake_terminal_immutability'`,
    );
    expect(r.rows[0].md5).toBe("9e50a57a0781d5caa045224f2dd05970");
  });

  it("14b. the 0163 intake INSERT boundary is untouched", async () => {
    const r = await adminQuery(
      `select has_table_privilege('authenticated','public.client_intake_forms','insert') as ins,
              has_table_privilege('anon','public.client_intake_forms','insert')          as anon_ins`,
    );
    expect(r.rows[0].ins).toBe(false);
    expect(r.rows[0].anon_ins).toBe(false);
  });

  it("14c. the 0159 retirement and 0160 lineage guards still fire on entries", async () => {
    const r = await adminQuery(
      `select t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
        where not t.tgisinternal and c.relname='electrolysis_entries'
        order by t.tgname`,
    );
    const names = r.rows.map((x) => x.tgname as string);
    expect(names).toContain("electrolysis_entries_guard_finalized");
    expect(names).toContain("electrolysis_entries_immutable_lineage");
  });

  it("14d. a command-created entry cannot be re-pointed to another session (0160)", async () => {
    const res = await callElec(A.userId);
    const id = res.rows[0].id as string;
    await expect(
      userQuery(
        A.userId,
        `update public.electrolysis_entries set session_id = $2 where id = $1`,
        [id, sessionB],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

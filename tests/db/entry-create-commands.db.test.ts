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
// L18 Phase 1A — the ONE clean entry create command (migration 0164)
// ===========================================================================
//
// `create_laser_entry` replaces the direct table INSERT in addLaserEntryAction.
// It is the ONLY writer this phase moves.
//
// SCOPE. This phase is ADDITIVE: no grant is revoked and no policy is dropped,
// so direct DML still works and the deployed application keeps functioning
// before, during and after the apply. That is asserted below, deliberately, so
// this PR cannot be mistaken for having revoked production access.
//
// electrolysis_entries is NOT command-bound by this phase. ALL THREE of its
// runtime writers can write session_blocks AND electrolysis_entries for a
// single user intent and therefore move together in the combined phase:
//   * addElectrolysisEntryAction — via ensureBlockForSession, when the
//     submitted form omits block_id (a legacy caller shape it still supports)
//   * createTreatmentAreaWithEntryAction — block then entry, compensating soft
//     delete on failure
//   * updateTreatmentAreaWithEntryAction — block then entry, no compensation
//
// Every row is synthetic and confined to the disposable local database.

const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

let A: SeededStudio;
let B: SeededStudio;
let sessionA: string;
let sessionB: string;
let blockA: string;

const LASER_SQL = `select public.create_laser_entry($1,$2,$3,$4,$5::jsonb,$6) as id`;

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

async function countLaser(sessionId: string): Promise<number> {
  const r = await adminQuery(
    `select count(*)::int as n from public.laser_entries where session_id = $1`,
    [sessionId],
  );
  return r.rows[0].n as number;
}

async function expectLaserDenied(
  userId: string,
  params: unknown[],
  code = CHECK_VIOLATION,
): Promise<void> {
  let got: string | undefined;
  try {
    await userQuery(userId, LASER_SQL, params);
  } catch (e) {
    got = (e as { code?: string }).code;
  }
  expect(got).toBe(code);
}

// ---------------------------------------------------------------------------
// The authorized happy path.
// ---------------------------------------------------------------------------

describe("0164 — authorized laser create succeeds through the command", () => {
  it("creates the entry and stores its values", async () => {
    const res = await userQuery(A.userId, LASER_SQL, [
      sessionA,
      A.clientId,
      "underarm",
      3,
      JSON.stringify({ fluence: "14", pulse_width: "30" }),
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
    expect(row.rows[0].equipment_params).toEqual({
      fluence: "14",
      pulse_width: "30",
    });
    expect(row.rows[0].observation_notes).toBe("no adverse response");
  });

  it("accepts the null-optional shape the action can send", async () => {
    const res = await userQuery(A.userId, LASER_SQL, [
      sessionA,
      A.clientId,
      "chin",
      null,
      null,
      null,
    ]);
    expect(res.rows[0].id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Authorization and lineage.
// ---------------------------------------------------------------------------

describe("0164 — authorization and lineage are database-derived", () => {
  it("a cross-studio caller is denied", async () => {
    const before = await countLaser(sessionA);
    await expectLaserDenied(B.userId, [sessionA, A.clientId, "z", null, null, null]);
    expect(await countLaser(sessionA)).toBe(before);
  });

  it("a same-studio caller asserting the WRONG client is denied", async () => {
    const other = await adminQuery(
      `insert into public.clients (studio_id, name)
       values ($1,'Other Client') returning id`,
      [A.studioId],
    );
    await expectLaserDenied(A.userId, [
      sessionA,
      other.rows[0].id,
      "z",
      null,
      null,
      null,
    ]);
  });

  it("a FOREIGN session is denied", async () => {
    await expectLaserDenied(A.userId, [sessionB, B.clientId, "z", null, null, null]);
  });

  it("a NULL asserted client is denied", async () => {
    await expectLaserDenied(A.userId, [sessionA, null, "z", null, null, null]);
  });

  it("an INACTIVE practitioner is denied", async () => {
    await adminQuery(`update public.practitioners set active = false where id = $1`, [
      A.practitionerId,
    ]);
    try {
      await expectLaserDenied(A.userId, [sessionA, A.clientId, "z", null, null, null]);
    } finally {
      await adminQuery(`update public.practitioners set active = true where id = $1`, [
        A.practitionerId,
      ]);
    }
  });

  it("a caller cannot assert another practitioner — there is no such parameter", async () => {
    const args = await adminQuery(
      `select pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='create_laser_entry'`,
    );
    expect(args.rowCount).toBe(1);
    expect(String(args.rows[0].args)).not.toMatch(
      /practitioner|p_studio_id|created_by|actor/i,
    );
  });

  it("studio and client resolve from the session, not the caller", async () => {
    const res = await userQuery(A.userId, LASER_SQL, [
      sessionA,
      A.clientId,
      "lip",
      null,
      null,
      null,
    ]);
    const row = await adminQuery(
      `select s.studio_id, s.client_id
         from public.laser_entries e join public.sessions s on s.id = e.session_id
        where e.id = $1`,
      [res.rows[0].id],
    );
    expect(row.rows[0].studio_id).toBe(A.studioId);
    expect(row.rows[0].client_id).toBe(A.clientId);
  });
});

// ---------------------------------------------------------------------------
// Validation and residue.
// ---------------------------------------------------------------------------

describe("0164 — validation preserved; a failed command leaves no residue", () => {
  it("a NULL zone is rejected (the NOT NULL column is still the authority)", async () => {
    // 23502 = not_null_violation
    await expectLaserDenied(
      A.userId,
      [sessionA, A.clientId, null, null, null, null],
      "23502",
    );
  });

  it("a refused command writes no laser row at all", async () => {
    const before = await countLaser(sessionA);
    await expectLaserDenied(A.userId, [sessionB, A.clientId, "z", null, null, null]);
    expect(
      await countLaser(sessionA),
      "a refused command must leave no partial entry",
    ).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// EXECUTE privileges.
// ---------------------------------------------------------------------------

describe("0164 — EXECUTE is authenticated-only", () => {
  it("anon and PUBLIC cannot execute the command", async () => {
    const r = await adminQuery(
      `select has_function_privilege('anon', p.oid, 'execute') as anon_x
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='create_laser_entry'`,
    );
    expect(r.rows[0].anon_x).toBe(false);

    let code: string | undefined;
    try {
      await asRole("anon", (q) =>
        q(LASER_SQL, [sessionA, A.clientId, "z", null, null, null]),
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("authenticated can execute it", async () => {
    const r = await adminQuery(
      `select has_function_privilege('authenticated', p.oid, 'execute') as auth_x
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='create_laser_entry'`,
    );
    expect(r.rows[0].auth_x).toBe(true);
  });

  it("0165: service_role EXECUTE is REVOKED, and the full ACL is exact", async () => {
    // 0164 left service_role holding EXECUTE (Supabase's ALTER DEFAULT
    // PRIVILEGES grants it at create time and 0164 revoked only public+anon).
    // 0165 repairs it. This asserts the whole ACL, not just one probe, so a
    // future grant to any role fails here.
    const r = await adminQuery(
      `select has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
              has_function_privilege('anon',          p.oid, 'execute') as anon_x,
              has_function_privilege('service_role',  p.oid, 'execute') as svc_x,
              (select count(*)::int from aclexplode(p.proacl) a where a.grantee = 0) as public_entries,
              (select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text)
                 from aclexplode(p.proacl) a) as grantees,
              pg_get_userbyid(p.proowner) as owner
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='create_laser_entry'`,
    );
    expect(r.rows[0].auth_x, "authenticated keeps EXECUTE").toBe(true);
    expect(r.rows[0].anon_x, "anon must not hold EXECUTE").toBe(false);
    expect(r.rows[0].svc_x, "0165 revokes service_role EXECUTE").toBe(false);
    expect(r.rows[0].public_entries, "PUBLIC must hold no EXECUTE").toBe(0);
    expect(r.rows[0].grantees, "exactly postgres + authenticated remain").toBe(
      "authenticated,postgres",
    );
    expect(r.rows[0].owner, "postgres ownership is preserved").toBe("postgres");
  });

  it("it is SECURITY DEFINER with a pinned empty search_path", async () => {
    const r = await adminQuery(
      `select p.prosecdef, array_to_string(p.proconfig, ',') as cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='create_laser_entry'`,
    );
    expect(r.rows[0].prosecdef).toBe(true);
    expect(r.rows[0].cfg).toBe('search_path=""');
  });

  it("a service-role caller (no auth.uid()) is refused — no admin shortcut", async () => {
    let code: string | undefined;
    try {
      await adminQuery(LASER_SQL, [sessionA, A.clientId, "z", null, null, null]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("NO electrolysis command was created by this phase", async () => {
    const r = await adminQuery(
      `select count(*)::int as n
         from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname='public' and p.proname = 'create_electrolysis_entry'`,
    );
    expect(
      r.rows[0].n,
      "0164 is laser-only; electrolysis moves with the block phase",
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Additive property and neighbouring boundaries.
// ---------------------------------------------------------------------------

describe("0164 — additive phase: direct DML and existing boundaries intact", () => {
  it("0164 itself revoked nothing — the capability was removed later, by 0169", async () => {
    // This case originally asserted that direct DML was STILL AVAILABLE, which
    // was the correct scope statement for 0164: that phase was additive and had
    // to leave the deployed application working. Migration 0169 is the cutover
    // that finally removes the capability, so the assertion is inverted here
    // rather than deleted — the history stays legible.
    const r = await adminQuery(
      `select has_table_privilege('authenticated','public.electrolysis_entries','insert') as e_ins,
              has_table_privilege('authenticated','public.laser_entries','insert')        as l_ins,
              has_table_privilege('authenticated','public.laser_entries','select')        as l_sel`,
    );
    expect(r.rows[0].e_ins, "0169 revokes direct INSERT").toBe(false);
    expect(r.rows[0].l_ins).toBe(false);
    // Reads are deliberately retained.
    expect(r.rows[0].l_sel).toBe(true);
    // 0164's own bytes still contain no revocation.
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      "supabase/migrations/0164_clean_entry_create_commands.sql",
      "utf8",
    ).replace(/\s+/g, " ");
    expect(sql).not.toMatch(/revoke[^;]*on table/i);
  });

  it("the electrolysis writers deferred by 0164 are now command-bound and privilege-denied", async () => {
    // 0164 deferred them; 0166 moved them onto commands; 0169 removed the
    // direct capability. A direct insert is now refused by the PRIVILEGE layer,
    // which is a stronger refusal than any application guard.
    let code: string | undefined;
    try {
      await userQuery(
        A.userId,
        `insert into public.electrolysis_entries (session_id, block_id, area, mode)
         values ($1,$2,'jaw','thermo') returning id`,
        [sessionA, blockA],
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
  });

  it("the 0162 intake review boundary is untouched", async () => {
    const r = await adminQuery(
      `select md5(pg_get_functiondef(p.oid)) as md5
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='enforce_intake_terminal_immutability'`,
    );
    expect(r.rows[0].md5).toBe("9e50a57a0781d5caa045224f2dd05970");
  });

  it("the 0163 intake INSERT boundary is untouched", async () => {
    const r = await adminQuery(
      `select has_table_privilege('authenticated','public.client_intake_forms','insert') as ins,
              has_table_privilege('anon','public.client_intake_forms','insert')          as anon_ins`,
    );
    expect(r.rows[0].ins).toBe(false);
    expect(r.rows[0].anon_ins).toBe(false);
  });

  it("the 0159 retirement and 0160 lineage guards still fire on both entry tables", async () => {
    const r = await adminQuery(
      `select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
        where not t.tgisinternal
          and c.relname in ('electrolysis_entries','laser_entries')
        order by c.relname, t.tgname`,
    );
    const names = r.rows.map((x) => `${x.relname}.${x.tgname}`);
    expect(names).toContain("electrolysis_entries.electrolysis_entries_guard_finalized");
    expect(names).toContain("electrolysis_entries.electrolysis_entries_immutable_lineage");
    expect(names).toContain("laser_entries.laser_entries_guard_finalized");
    expect(names).toContain("laser_entries.laser_entries_immutable_lineage");
  });

  it("a command-created laser entry cannot be re-pointed to another session (0160)", async () => {
    const res = await userQuery(A.userId, LASER_SQL, [
      sessionA,
      A.clientId,
      "neck",
      null,
      null,
      null,
    ]);
    // TWO layers now refuse this, and both are asserted.
    //
    // 1. PRIVILEGE — after 0169 `authenticated` has no UPDATE at all.
    let code: string | undefined;
    try {
      await userQuery(
        A.userId,
        `update public.laser_entries set session_id = $2 where id = $1`,
        [res.rows[0].id, sessionB],
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");

    // 2. TRIGGER — the 0160 lineage guard itself is UNCHANGED. Proven through
    // service_role, which still holds DML, so the revocation cannot be mistaken
    // for having replaced the protection it sits in front of.
    let trigCode: string | undefined;
    try {
      await asRole("service_role", (q) =>
        q(`update public.laser_entries set session_id = $2 where id = $1`, [
          res.rows[0].id,
          sessionB,
        ]),
      );
    } catch (e) {
      trigCode = (e as { code?: string }).code;
    }
    expect(trigCode).toBe(CHECK_VIOLATION);
  });
});

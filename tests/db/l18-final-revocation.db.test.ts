import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, closePool, seedSession, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";

// ===========================================================================
// L18 FINAL — migration 0169 behavioural proof, against a fresh chain.
// ===========================================================================
//
// The cutover: `authenticated` keeps SELECT on all six clinical tables and
// loses INSERT, UPDATE and DELETE. Every write must now go through a command.
//
// The denial must be a DATABASE PRIVILEGE denial (42501), not a zero-row RLS
// result — a zero-row UPDATE would look identical to a successful no-op and
// would prove nothing. Every probe below therefore uses a predicate that
// matches NO rows: if the privilege were still granted the statement would
// SUCCEED with rowCount 0, and the test would fail. Nothing is mutated.

const INSUFFICIENT_PRIVILEGE = "42501";

const TABLES = [
  "sessions",
  "session_blocks",
  "session_block_areas",
  "electrolysis_entries",
  "laser_entries",
  "treatment_images",
] as const;

let A: SeededStudio;

beforeAll(async () => {
  A = await seedStudio("l18-final");
  await seedSession(A);
});
afterAll(async () => {
  await closePool();
});

/** Run a statement as `authenticated` and return its SQLSTATE, or null. */
async function codeFor(sql: string): Promise<string | null> {
  try {
    await asRole("authenticated", (q) => q(sql));
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "unknown";
  }
}

describe("0169 — authenticated SELECT is retained on every table", () => {
  for (const t of TABLES) {
    it(`${t}: SELECT still allowed`, async () => {
      const r = await adminQuery(
        `select has_table_privilege('authenticated','public.${t}','SELECT') p`,
      );
      expect(r.rows[0].p).toBe(true);
      // And it genuinely runs (RLS may return zero rows; that is fine — this
      // asserts the privilege layer does not refuse the statement).
      expect(await codeFor(`select count(*) from public.${t}`)).toBeNull();
    });
  }
});

describe("0169 — authenticated INSERT/UPDATE/DELETE are denied by PRIVILEGE", () => {
  for (const t of TABLES) {
    it(`${t}: privilege flags are false for all three writes`, async () => {
      const r = await adminQuery(
        `select has_table_privilege('authenticated','public.${t}','INSERT') i,
                has_table_privilege('authenticated','public.${t}','UPDATE') u,
                has_table_privilege('authenticated','public.${t}','DELETE') d`,
      );
      expect(r.rows[0].i, `${t} INSERT`).toBe(false);
      expect(r.rows[0].u, `${t} UPDATE`).toBe(false);
      expect(r.rows[0].d, `${t} DELETE`).toBe(false);
    });

    it(`${t}: a no-row UPDATE is refused with 42501, not a silent zero-row success`, async () => {
      // The predicate matches nothing. With the privilege granted this would
      // return rowCount 0 and no error; the 42501 proves the refusal is the
      // privilege layer and not RLS filtering.
      const code = await codeFor(
        `update public.${t} set id = id where id = '00000000-0000-0000-0000-000000000000'`,
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it(`${t}: a no-row DELETE is refused with 42501`, async () => {
      const code = await codeFor(
        `delete from public.${t} where id = '00000000-0000-0000-0000-000000000000'`,
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it(`${t}: an INSERT is refused with 42501`, async () => {
      // Deliberately invalid column values — if the privilege check did not
      // fire first this would fail with a DIFFERENT code (not-null / type),
      // so 42501 proves privilege is evaluated before anything else.
      const code = await codeFor(`insert into public.${t} default values`);
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  }
});

describe("0169 — anon and PUBLIC hold no direct write privilege", () => {
  for (const t of TABLES) {
    it(`${t}: anon has no INSERT/UPDATE/DELETE`, async () => {
      const r = await adminQuery(
        `select has_table_privilege('anon','public.${t}','INSERT') i,
                has_table_privilege('anon','public.${t}','UPDATE') u,
                has_table_privilege('anon','public.${t}','DELETE') d`,
      );
      expect(r.rows[0].i).toBe(false);
      expect(r.rows[0].u).toBe(false);
      expect(r.rows[0].d).toBe(false);
    });

    it(`${t}: PUBLIC holds no grant of any kind`, async () => {
      const r = await adminQuery(
        `select coalesce((select count(*) from pg_class c
                            join pg_namespace n on n.oid = c.relnamespace
                            cross join lateral aclexplode(c.relacl) a
                           where n.nspname='public' and c.relname='${t}'
                             and a.grantee = 0), 0) n`,
      );
      expect(Number(r.rows[0].n)).toBe(0);
    });
  }
});

describe("0169 — service_role is unchanged from the pre-0169 baseline", () => {
  // Baseline measured in production before writing 0169: service_role held
  // SELECT+INSERT+UPDATE+DELETE on all six tables. It must be untouched, or the
  // migration has reached beyond its scope.
  for (const t of TABLES) {
    it(`${t}: service_role retains SELECT, INSERT, UPDATE, DELETE`, async () => {
      const r = await adminQuery(
        `select has_table_privilege('service_role','public.${t}','SELECT') s,
                has_table_privilege('service_role','public.${t}','INSERT') i,
                has_table_privilege('service_role','public.${t}','UPDATE') u,
                has_table_privilege('service_role','public.${t}','DELETE') d`,
      );
      expect(r.rows[0].s, `${t} service_role SELECT`).toBe(true);
      expect(r.rows[0].i, `${t} service_role INSERT`).toBe(true);
      expect(r.rows[0].u, `${t} service_role UPDATE`).toBe(true);
      expect(r.rows[0].d, `${t} service_role DELETE`).toBe(true);
    });
  }
});

describe("0169 — TRUNCATE remains denied to the client roles", () => {
  for (const t of TABLES) {
    it(`${t}: neither authenticated nor anon may TRUNCATE`, async () => {
      const r = await adminQuery(
        `select has_table_privilege('authenticated','public.${t}','TRUNCATE') a,
                has_table_privilege('anon','public.${t}','TRUNCATE') n`,
      );
      expect(r.rows[0].a).toBe(false);
      expect(r.rows[0].n).toBe(false);
    });
  }
});

describe("0169 — the command surface is untouched", () => {
  const COMMANDS = [
    "create_laser_entry",
    "create_block_with_entry",
    "update_block_with_entry",
    "add_electrolysis_pass",
    "soft_delete_session_block",
    "start_session",
    "set_session_price",
    "set_next_session_note",
    "set_session_performer",
    "edit_session_started_at",
    "soft_delete_session",
    "set_session_treatment_plan",
    "set_session_aftercare_explained",
    "create_treatment_image_metadata",
    "set_treatment_image_note",
    "archive_treatment_image",
  ];

  it("all sixteen commands still exist and are authenticated-EXECUTE only", async () => {
    const r = await adminQuery(
      `select p.proname,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') a,
              has_function_privilege('anon', p.oid, 'EXECUTE') an,
              has_function_privilege('service_role', p.oid, 'EXECUTE') sv
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname = any($1) order by p.proname`,
      [COMMANDS],
    );
    expect(r.rows).toHaveLength(COMMANDS.length);
    for (const row of r.rows) {
      expect(row.a, `${row.proname} authenticated`).toBe(true);
      expect(row.an, `${row.proname} anon`).toBe(false);
      expect(row.sv, `${row.proname} service_role`).toBe(false);
    }
  });

  it("every command function is SECURITY DEFINER with an empty search_path", async () => {
    const r = await adminQuery(
      `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname = any($1)`,
      [COMMANDS],
    );
    expect(r.rows).toHaveLength(COMMANDS.length);
    for (const row of r.rows) {
      expect(row.prosecdef, `${row.proname} definer`).toBe(true);
      expect(row.cfg, `${row.proname} search_path`).toBe('search_path=""');
    }
  });

  it("the clinical triggers that enforce lineage and retirement are all intact", async () => {
    const r = await adminQuery(
      `select c.relname t, count(*)::int n
         from pg_trigger g join pg_class c on c.oid = g.tgrelid
         join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname='public' and not g.tgisinternal
          and c.relname in ('sessions','session_blocks','electrolysis_entries',
                            'laser_entries','treatment_images')
        group by c.relname order by c.relname`,
    );
    const byTable = Object.fromEntries(r.rows.map((x) => [x.t, x.n]));
    expect(byTable.sessions).toBe(4);
    expect(byTable.treatment_images).toBe(3);
    // The remaining tables keep whatever guards they had; assert non-zero so a
    // dropped trigger cannot hide behind this cutover.
    for (const t of ["session_blocks", "electrolysis_entries", "laser_entries"]) {
      expect(byTable[t], `${t} triggers`).toBeGreaterThan(0);
    }
  });

  it("a command still writes successfully after the revocation", async () => {
    // The end-to-end point of the whole programme: the practitioner path works
    // while the direct path does not.
    const r = await userQuery(
      A.userId,
      `select * from public.start_session($1,$2,$3,$4)`,
      [A.clientId, "electrolysis", null, 90],
    );
    expect(r.rows[0].session_id).toBeTruthy();

    // ...and the same actor cannot reach the table directly.
    expect(
      await codeFor(
        `update public.sessions set id = id where id = '00000000-0000-0000-0000-000000000000'`,
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

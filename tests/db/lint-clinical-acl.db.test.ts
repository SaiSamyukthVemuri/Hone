import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";

// ===========================================================================
// LINT-CLINICAL: effective EXECUTE / SECURITY DEFINER / search_path matrix for
// the clinical commands the Supabase linter flags as
// authenticated_security_definer_function_executable (OPS 20261025T0029Z).
// ===========================================================================
//
// The catalog is the authority, not a replay of GRANT and REVOKE statements:
// a DROP FUNCTION followed by CREATE resets a function's ACL to Supabase's
// default privileges (anon, authenticated, service_role AND PUBLIC all hold
// EXECUTE), and no statement-level reading of the migrations can see a DO block
// or a default-privileges change. So this reads pg_proc after the full chain.
//
// It also pins the one known deviation: four older functions (0123, 0156 x2,
// 0157) still carry service_role EXECUTE, which the 0165 doctrine removed from
// the later commands. They are safe today because each body refuses a caller
// with no auth.uid() (proved in lint-clinical-cross-studio.db.test.ts), but the
// grant is inconsistent, so it is named here rather than left implicit. If a
// later migration revokes it, THIS TEST MUST BE UPDATED, which is the point.
// Tracked as LINT-CLIN-001 in privacy/LINT-CLINICAL-END.json.

afterAll(async () => {
  await closePool();
});

/** name -> number of overloads, and whether service_role is KNOWN to hold EXECUTE. */
const COMMANDS: Record<string, { overloads: number; serviceRole: boolean }> = {
  create_treatment_image_metadata: { overloads: 1, serviceRole: false },
  archive_treatment_image: { overloads: 1, serviceRole: false },
  set_treatment_image_note: { overloads: 1, serviceRole: false },
  create_laser_entry: { overloads: 1, serviceRole: false },
  add_electrolysis_pass: { overloads: 1, serviceRole: false },
  create_block_with_entry: { overloads: 1, serviceRole: false },
  update_block_with_entry: { overloads: 1, serviceRole: false },
  create_session_block_with_areas: { overloads: 1, serviceRole: true },
  update_session_block_with_areas: { overloads: 1, serviceRole: true },
  soft_delete_session: { overloads: 1, serviceRole: false },
  soft_delete_session_block: { overloads: 1, serviceRole: false },
  soft_delete_session_area: { overloads: 1, serviceRole: true },
  start_session: { overloads: 2, serviceRole: false },
  edit_session_started_at: { overloads: 1, serviceRole: false },
  set_session_performer: { overloads: 1, serviceRole: false },
  set_session_treatment_plan: { overloads: 1, serviceRole: false },
  set_session_aftercare_explained: { overloads: 1, serviceRole: false },
  set_next_session_note: { overloads: 1, serviceRole: false },
  whole_session_copy_source_descriptor: { overloads: 1, serviceRole: true },
};

/** Internal helpers: callable only from the DEFINER-owned commands above. */
const HELPERS = [
  "assert_session_writable",
  "session_actor_practitioner",
  "assert_session_studio_for_actor",
  "assert_block_in_session",
  "write_electrolysis_entry",
  "apply_block_extra_fields",
  "treatment_image_actor",
  "_whole_session_copy_source_id",
  "_whole_session_copy_fingerprint",
];

type Row = {
  proname: string;
  args: string;
  prosecdef: boolean;
  proconfig: string[] | null;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
  public_exec: boolean;
};

async function read(names: string[]): Promise<Row[]> {
  const r = await adminQuery(
    `select p.proname,
            pg_get_function_identity_arguments(p.oid) as args,
            p.prosecdef,
            p.proconfig,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
            exists (
              select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               where a.grantee = 0 and a.privilege_type = 'EXECUTE'
            ) as public_exec
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
      order by p.proname, args`,
    [names],
  );
  return r.rows as Row[];
}

describe("LINT-CLINICAL: the 20 flagged signatures, read from the catalog", () => {
  it("exist with exactly the expected overloads (a new or dropped-and-recreated overload is noticed)", async () => {
    const rows = await read(Object.keys(COMMANDS));
    const byName = new Map<string, Row[]>();
    for (const row of rows) byName.set(row.proname, [...(byName.get(row.proname) ?? []), row]);
    for (const [name, exp] of Object.entries(COMMANDS)) {
      expect(byName.get(name)?.length ?? 0, `${name}: overload count`).toBe(exp.overloads);
    }
    expect(rows.length).toBe(20);
  });

  it("every one is SECURITY DEFINER with a pinned search_path that does not include public", async () => {
    for (const row of await read(Object.keys(COMMANDS))) {
      const label = `${row.proname}(${row.args})`;
      expect(row.prosecdef, `${label}: SECURITY DEFINER`).toBe(true);
      const sp = (row.proconfig ?? []).find((c) => c.startsWith("search_path="));
      expect(sp, `${label}: search_path must be pinned`).toBeDefined();
      expect(sp, `${label}: a DEFINER function must not resolve names through public`).not.toMatch(/public/);
    }
  });

  it("authenticated holds EXECUTE; PUBLIC and anon hold none", async () => {
    for (const row of await read(Object.keys(COMMANDS))) {
      const label = `${row.proname}(${row.args})`;
      expect(row.authenticated, `${label}: authenticated`).toBe(true);
      expect(row.public_exec, `${label}: PUBLIC`).toBe(false);
      expect(row.anon, `${label}: anon`).toBe(false);
    }
  });

  it("service_role holds EXECUTE on exactly the four KNOWN older functions (LINT-CLIN-001), and on no other", async () => {
    const holding = (await read(Object.keys(COMMANDS)))
      .filter((r) => r.service_role)
      .map((r) => r.proname)
      .sort();
    const expected = Object.entries(COMMANDS)
      .filter(([, v]) => v.serviceRole)
      .map(([k]) => k)
      .sort();
    expect(holding).toEqual(expected);
    expect(expected).toEqual([
      "create_session_block_with_areas",
      "soft_delete_session_area",
      "update_session_block_with_areas",
      "whole_session_copy_source_descriptor",
    ]);
  });
});

describe("LINT-CLINICAL: the internal helpers are not callable by any client role", () => {
  it("authenticated, anon and PUBLIC cannot execute any helper, so no command can be driven half-way", async () => {
    const rows = await read(HELPERS);
    expect(new Set(rows.map((r) => r.proname)), "every helper exists").toEqual(new Set(HELPERS));
    for (const row of rows) {
      const label = `${row.proname}(${row.args})`;
      expect(row.authenticated, `${label}: authenticated`).toBe(false);
      expect(row.anon, `${label}: anon`).toBe(false);
      expect(row.public_exec, `${label}: PUBLIC`).toBe(false);
    }
  });
});

describe("LINT-CLINICAL: the schema the gates rely on", () => {
  it("anon and authenticated cannot CREATE in public (is_studio_member runs with search_path=public)", async () => {
    // Four of the commands authorize through public.is_studio_member, whose own
    // search_path is `public`. That is only safe while no client role can create
    // an object in public to shadow a name.
    const r = await adminQuery(
      `select has_schema_privilege('anon', 'public', 'CREATE') as anon,
              has_schema_privilege('authenticated', 'public', 'CREATE') as authenticated`,
    );
    expect(r.rows[0]).toEqual({ anon: false, authenticated: false });
  });
});

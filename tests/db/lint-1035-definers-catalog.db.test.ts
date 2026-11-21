// LINT-1035 — grant and search_path census of every SECURITY DEFINER function
// that migrations 0213-0246 create or redefine.
//
// Read from the live catalog, not from the migration text: the function list is
// parsed from the migration files (so a new definer in the range is covered
// without an edit), and the grants are read with aclexplode on the built schema.
//
// Checks, per function (every overload):
//   * the search_path is pinned (proconfig), so an object in a caller-writable
//     schema cannot shadow a catalog or table reference;
//   * PUBLIC and anon cannot execute it (CLAUDE.md section 5: Supabase's default
//     privileges grant EXECUTE to anon, authenticated AND service_role at create
//     time, so each must be revoked by name where it is not intended);
//   * the set of functions `authenticated` can execute equals AUTH_EXECUTABLE,
//     a reviewed list; a new authenticated definer fails here until it is
//     reviewed and added;
//   * every authenticated-executable one also refuses service_role, because its
//     gate derives the caller from auth.uid() and service_role has none.
//
// Synthetic, read-only, disposable CI stack.

import { afterAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { adminQuery, closePool } from "./helpers/harness";

const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");

// Reviewed 2026-10-25 at #1035 head bfd266d9; each has a gate traced in
// LINT-1035-NEW-DEFINERS-END.json and a behavioural test in
// lint-1035-definers-gates.db.test.ts.
const AUTH_EXECUTABLE = [
  "archive_treatment_image",
  "audit_actor_is_caller",
  "create_block_with_initial_setup",
  "owner_delivery_concerns",
  "owner_delivery_incidents",
  "receptionist_booking_options",
  "receptionist_calendar",
  "receptionist_calendar_closures",
  "receptionist_cancel_appointment",
  "receptionist_client_contacts",
  "receptionist_create_appointment",
  "receptionist_move_appointment",
  "record_clinical_records_audit",
  "record_treatment_setup_group",
  "record_treatment_setup_submission",
  "register_studio_machine",
  "report_delivery_concern",
  "retire_studio_machine",
  "set_client_portrait",
  "set_own_default_machine",
  "set_treatment_image_capture_stage",
  "start_session",
];

function definersInRange(): string[] {
  const names = new Set<string>();
  for (const f of readdirSync(MIGRATIONS).sort()) {
    const n = Number(f.slice(0, 4));
    if (!(n >= 213 && n <= 246)) continue;
    const sql = readFileSync(path.join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi)) names.add(m[1].toLowerCase());
  }
  return [...names].sort();
}

type Row = {
  name: string;
  args: string;
  secdef: boolean;
  pinned: boolean;
  public_x: boolean;
  anon_x: boolean;
  auth_x: boolean;
  service_x: boolean;
};
let rows: Row[];

async function load(): Promise<Row[]> {
  const names = definersInRange();
  const r = await adminQuery(
    `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
            p.prosecdef as secdef,
            coalesce(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'), false) as pinned,
            coalesce(exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                              where a.grantee = 0 and a.privilege_type = 'EXECUTE'), false) as public_x,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x,
            has_function_privilege('service_role', p.oid, 'EXECUTE') as service_x
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = any($1::text[])
      order by 1, 2`,
    [names],
  );
  return r.rows as Row[];
}

async function ensure() {
  rows ??= await load();
  return rows;
}

afterAll(async () => {
  await closePool();
});

describe("LINT-1035 definer census", () => {
  it("finds the functions the migrations create (guards the parser itself)", async () => {
    const names = definersInRange();
    expect(names.length).toBeGreaterThan(60);
    const live = new Set((await ensure()).map((r) => r.name));
    // A function created then dropped later in the range is the only legitimate absence.
    const missing = names.filter((n) => !live.has(n));
    expect(missing, `in migrations 0213-0246 but not in the catalog: ${missing.join(", ")}`).toEqual([]);
  });

  it("every SECURITY DEFINER function pins its search_path", async () => {
    const bad = (await ensure()).filter((r) => r.secdef && !r.pinned).map((r) => `${r.name}(${r.args})`);
    expect(bad).toEqual([]);
  });

  it("no definer is executable by PUBLIC or anon", async () => {
    const bad = (await ensure())
      .filter((r) => r.secdef && (r.public_x || r.anon_x))
      .map((r) => `${r.name}(${r.args}) public=${r.public_x} anon=${r.anon_x}`);
    expect(bad).toEqual([]);
  });

  it("the authenticated-executable definer set is exactly the reviewed list", async () => {
    const got = [...new Set((await ensure()).filter((r) => r.secdef && r.auth_x).map((r) => r.name))].sort();
    expect(got).toEqual([...AUTH_EXECUTABLE].sort());
  });

  it("every authenticated-executable definer refuses service_role (all three revoked by name)", async () => {
    const bad = (await ensure())
      .filter((r) => r.secdef && r.auth_x && r.service_x)
      .map((r) => `${r.name}(${r.args})`);
    expect(bad).toEqual([]);
  });
});

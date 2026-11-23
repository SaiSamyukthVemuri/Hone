import { afterAll, describe, expect, it } from "vitest";
import { RPC_NAMES, RPC_PRIVILEGES } from "../security/permission-coverage.registry";
import { rpcPrivilegeDrift } from "../security/rpc-privilege-drift";
import { adminQuery, closePool } from "./helpers/harness";

// The permission engine function may be absent on a database built from the repository migrations alone (local and CI
// stacks) and is then not counted as drift; only that row is exempt (tests/security/rpc-privilege-drift.ts). Every other
// command is always compared, including the two that exist only on the hosted database, which are recorded as ABSENT.
//
// Reads the REAL execute privileges of every database command the app calls by name, from a migrated database, and
// requires them to equal what permission-coverage.registry.ts records. A grant that widens (an `anon` or `authenticated`
// letter appearing) fails here and is reviewed. Local database only, read only.

afterAll(closePool);

// One letter per role (a anon, u authenticated, s service_role, "-" when it cannot run it), then D for security
// definer or I for invoker; a second group after a comma is a second overload. A name with NO function in the public
// schema is "ABSENT". The absence must be tested on the joined row (count of matching functions), not on the letters:
// has_function_privilege on a missing row is NULL, which reads as "-", so a missing function would otherwise look like
// an invoker function nobody can run ("---I").
export async function readRpcPrivileges(names: readonly string[]): Promise<Record<string, string>> {
  const { rows } = await adminQuery(
    `select n.name,
            case when count(p.oid) = 0 then 'ABSENT' else string_agg(
              (case when has_function_privilege('anon', p.oid, 'execute') then 'a' else '-' end) ||
              (case when has_function_privilege('authenticated', p.oid, 'execute') then 'u' else '-' end) ||
              (case when has_function_privilege('service_role', p.oid, 'execute') then 's' else '-' end) ||
              (case when p.prosecdef then 'D' else 'I' end), ',' order by p.oid::regprocedure::text) end as grants
       from unnest($1::text[]) as n(name)
       left join pg_proc p on p.proname = n.name and p.pronamespace = 'public'::regnamespace
      group by n.name`,
    [names],
  );
  return Object.fromEntries(rows.map((r: { name: string; grants: string }) => [r.name, r.grants]));
}

describe("database commands the app calls: who can run them", () => {
  it("records a privilege string for exactly the commands the app calls", () => {
    expect(Object.keys(RPC_PRIVILEGES).sort()).toEqual([...RPC_NAMES].sort());
  });

  it("matches the privileges the database really grants, and every command exists", async () => {
    const live = await readRpcPrivileges(RPC_NAMES);
    const drift = rpcPrivilegeDrift(RPC_NAMES, live, RPC_PRIVILEGES);
    expect(drift).toEqual([]);
  });

  it("reads a name that has no function as ABSENT, never as a function nobody can run", async () => {
    expect(await readRpcPrivileges(["zz_no_such_command_for_the_privileges_test"])).toEqual({ zz_no_such_command_for_the_privileges_test: "ABSENT" });
  });

  it("lets anonymous callers run none of them", () => {
    expect(Object.entries(RPC_PRIVILEGES).filter(([, g]) => g.split(",").some((x) => x[0] === "a")).map(([n]) => n)).toEqual([]);
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { RPC_NAMES, RPC_PRIVILEGES } from "../security/permission-coverage.registry";
import { adminQuery, closePool } from "./helpers/harness";

// Reads the REAL execute privileges of every database command the app calls by name, from a migrated database, and
// requires them to equal what permission-coverage.registry.ts records. A grant that widens (an `anon` or `authenticated`
// letter appearing) fails here and is reviewed. Local database only, read only.

afterAll(closePool);

describe("database commands the app calls: who can run them", () => {
  it("records a privilege string for exactly the commands the app calls", () => {
    expect(Object.keys(RPC_PRIVILEGES).sort()).toEqual([...RPC_NAMES].sort());
  });

  it("matches the privileges the database really grants, and every command exists", async () => {
    const { rows } = await adminQuery(
      `select n.name,
              coalesce(string_agg(
                (case when has_function_privilege('anon', p.oid, 'execute') then 'a' else '-' end) ||
                (case when has_function_privilege('authenticated', p.oid, 'execute') then 'u' else '-' end) ||
                (case when has_function_privilege('service_role', p.oid, 'execute') then 's' else '-' end) ||
                (case when p.prosecdef then 'D' else 'I' end), ',' order by p.oid::regprocedure::text), 'ABSENT') as grants
         from unnest($1::text[]) as n(name)
         left join pg_proc p on p.proname = n.name and p.pronamespace = 'public'::regnamespace
        group by n.name`,
      [RPC_NAMES],
    );
    const live = Object.fromEntries(rows.map((r: { name: string; grants: string }) => [r.name, r.grants]));
    const drift = RPC_NAMES.filter((n) => live[n] !== RPC_PRIVILEGES[n]).map((n) => `${n}: recorded ${RPC_PRIVILEGES[n]}, database ${live[n]}`);
    expect(drift).toEqual([]);
  });

  it("lets anonymous callers run none of them", () => {
    expect(Object.entries(RPC_PRIVILEGES).filter(([, g]) => g.split(",").some((x) => x[0] === "a")).map(([n]) => n)).toEqual([]);
  });
});

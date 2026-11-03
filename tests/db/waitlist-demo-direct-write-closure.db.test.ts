import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { adminQuery, adminTx, asRole, closePool } from "./helpers/harness";

// 0294 (HELD), Q-F: the anonymous DIRECT writes to public.waitlist and public.demo_requests are closed. Before, 0004 and 0006
// let anon and authenticated INSERT with `with check (true)`, so anyone holding the public key could post to PostgREST and walk
// around every limiter. Negative controls name the secure outcome (refused, nothing written); the positive control proves the
// service-role path the app now uses still writes. Synthetic addresses only.
afterAll(async () => {
  await closePool();
});

const email = () => `qf-${randomUUID().slice(0, 8)}@harness.local`;

describe("Q-F: no browser role can write the marketing tables", () => {
  it("POSITIVE CONTROL: the 0213 commands (the app's path, service_role) write both tables and raise the lead alert", async () => {
    const e = email();
    const w = await asRole("service_role", (q) => q(`select * from public.record_platform_early_access_signup($1)`, [e]));
    expect(w.rows[0].result).toBe("recorded");
    expect(w.rows[0].alert_id).not.toBeNull();
    const d = await asRole("service_role", (q) => q(`select * from public.record_platform_demo_request('Qf Test', $1, null, null, null, null, null, null)`, [e]));
    expect(d.rows[0].result).toBe("recorded");
    expect(d.rows[0].alert_id).not.toBeNull();
    expect((await adminQuery(`select 1 from public.waitlist where email = $1`, [e])).rowCount).toBe(1);
    expect((await adminQuery(`select 1 from public.demo_requests where email = $1`, [e])).rowCount).toBe(1);
    const dup = await asRole("service_role", (q) => q(`select * from public.record_platform_early_access_signup($1)`, [e]));
    expect(dup.rows[0].result).toBe("duplicate");
  });

  it("service_role has NO direct INSERT (it would bypass the lead alert) but keeps what /admin needs", async () => {
    for (const [t, priv, want] of [["waitlist", "insert", false], ["demo_requests", "insert", false], ["waitlist", "select", true], ["demo_requests", "select", true], ["demo_requests", "update", true], ["waitlist", "delete", false]] as const) {
      const r = await adminQuery(`select has_table_privilege('service_role', $1, $2) as ok`, [`public.${t}`, priv]);
      expect(r.rows[0].ok, `service_role ${priv} on ${t}`).toBe(want);
    }
  });

  it.each(["anon", "authenticated"] as const)("NEGATIVE: %s cannot INSERT into waitlist or demo_requests, and nothing is written", async (role) => {
    const e = email();
    await expect(asRole(role, (q) => q(`insert into public.waitlist (email, source) values ($1, 'landing')`, [e]))).rejects.toThrow(/permission denied|row-level security|42501/i);
    await expect(asRole(role, (q) => q(`insert into public.demo_requests (name, email) values ('Qf Test', $1)`, [e]))).rejects.toThrow(/permission denied|row-level security|42501/i);
    expect((await adminQuery(`select 1 from public.waitlist where email = $1`, [e])).rowCount).toBe(0);
    expect((await adminQuery(`select 1 from public.demo_requests where email = $1`, [e])).rowCount).toBe(0);
  });

  it.each(["anon", "authenticated"] as const)("NEGATIVE: %s cannot read, update or delete either table", async (role) => {
    for (const t of ["waitlist", "demo_requests"]) {
      await expect(asRole(role, (q) => q(`select count(*) from public.${t}`))).rejects.toThrow(/permission denied|42501/i);
      await expect(asRole(role, (q) => q(`update public.${t} set created_at = now()`))).rejects.toThrow(/permission denied|42501/i);
      await expect(asRole(role, (q) => q(`delete from public.${t}`))).rejects.toThrow(/permission denied|42501/i);
    }
  });

  it("no insert policy remains on either table, and no table privilege is held by anon, authenticated or public", async () => {
    const pol = await adminQuery(`select tablename, policyname from pg_policies where schemaname = 'public' and tablename in ('waitlist','demo_requests') and cmd in ('INSERT','ALL')`);
    expect(pol.rows).toEqual([]);
    for (const t of ["waitlist", "demo_requests"]) {
      for (const role of ["anon", "authenticated"]) {
        for (const priv of ["insert", "select", "update", "delete"]) {
          const r = await adminQuery(`select has_table_privilege($1, $2, $3) as ok`, [role, `public.${t}`, priv]);
          expect(r.rows[0].ok, `${role} must not hold ${priv} on ${t}`).toBe(false);
        }
      }
    }
  });

  // Q5 (Privacy): table-level has_table_privilege can miss a COLUMN-level grant; information_schema shows both.
  it("no column-level or table-level privilege is held by anon, authenticated or PUBLIC on either table", async () => {
    for (const t of ["waitlist", "demo_requests"]) {
      const tbl = await adminQuery(`select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 and grantee in ('anon','authenticated','PUBLIC')`, [t]);
      expect(tbl.rows, `table grants on ${t}`).toEqual([]);
      const col = await adminQuery(`select grantee, column_name, privilege_type from information_schema.column_privileges where table_schema = 'public' and table_name = $1 and grantee in ('anon','authenticated','PUBLIC')`, [t]);
      expect(col.rows, `column grants on ${t}`).toEqual([]);
    }
  });
});

describe("E-4 / Privacy Q2: the down step restores the old app's anonymous insert path", () => {
  it("applying the rollback SQL (inside a rolled-back transaction) lets anon insert again and removes the counter objects", async () => {
    const down = readFileSync("supabase/rollbacks/0294_rate_limit_fallback_counter.down.sql", "utf8")
      .replace(/^\s*begin;\s*$/im, "")
      .replace(/^\s*commit;\s*$/im, "");
    const e = email();
    class Undo extends Error {}
    await expect(
      adminTx(async (q) => {
        await q(down);
        await q("set local role anon");
        await q(`insert into public.waitlist (email, source) values ($1, 'landing')`, [e]);
        await q(`insert into public.demo_requests (name, email) values ('Qf Down', $1)`, [e]);
        await q("reset role");
        const gone = await q(`select to_regclass('public.rate_limit_fallback_counters') as t`);
        expect(gone.rows[0].t).toBeNull();
        throw new Undo();
      }),
    ).rejects.toBeInstanceOf(Undo);
    expect((await adminQuery(`select 1 from public.waitlist where email = $1`, [e])).rowCount).toBe(0);
    // and 0294 is still in force afterwards
    await expect(asRole("anon", (q) => q(`insert into public.waitlist (email, source) values ($1, 'landing')`, [e]))).rejects.toThrow(/permission denied|42501/i);
  });
});

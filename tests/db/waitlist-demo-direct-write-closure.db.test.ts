import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool } from "./helpers/harness";

// 0294 (HELD), Q-F: the anonymous DIRECT writes to public.waitlist and public.demo_requests are closed. Before, 0004 and 0006
// let anon and authenticated INSERT with `with check (true)`, so anyone holding the public key could post to PostgREST and walk
// around every limiter. Negative controls name the secure outcome (refused, nothing written); the positive control proves the
// service-role path the app now uses still writes. Synthetic addresses only.
afterAll(async () => {
  await closePool();
});

const email = () => `qf-${randomUUID().slice(0, 8)}@harness.local`;

describe("Q-F: no browser role can write the marketing tables", () => {
  it("POSITIVE CONTROL: service_role (the app's path) inserts into both tables", async () => {
    const e = email();
    await asRole("service_role", (q) => q(`insert into public.waitlist (email, source) values ($1, 'landing')`, [e]));
    await asRole("service_role", (q) => q(`insert into public.demo_requests (name, email) values ('Qf Test', $1)`, [e]));
    expect((await adminQuery(`select 1 from public.waitlist where email = $1`, [e])).rowCount).toBe(1);
    expect((await adminQuery(`select 1 from public.demo_requests where email = $1`, [e])).rowCount).toBe(1);
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
});

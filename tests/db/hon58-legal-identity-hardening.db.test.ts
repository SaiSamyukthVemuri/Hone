import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// HON-58 legal-identity hardening (migration 0272) and the hosted-shaped
// privilege proof for 0258 + 0266 (Privacy PEER-0258-0266-SQL, C1-C4). Runs
// against the real migrated database, so every assertion is a database fact.
//
//   C1  updated_by is the caller's own practitioner row whatever the statement
//       supplies (insert and update), and created_at / updated_at are set by
//       the database on INSERT as well.
//   C2  the three functions run with search_path = pg_catalog, pg_temp.
//   C3  no function anon can execute returns the preferred name, and none
//       returns a clients row.
//   C4  table and function privileges are asserted BY NAME for anon,
//       authenticated and service_role on the three tables and every new
//       function; policies are enumerated (no write policy on the switch or
//       the audit, no DELETE policy on the legal identity).

let a: SeededStudio;
let b: SeededStudio;
let aMember: { userId: string; practitionerId: string };
let bMember: { userId: string; practitionerId: string };

beforeAll(async () => {
  a = await seedStudio("hon58h-a");
  b = await seedStudio("hon58h-b");
  aMember = await seedMember(a, "hon58h-a-member");
  bMember = await seedMember(b, "hon58h-b-member");
});

afterAll(async () => {
  await closePool();
});

const INSERT = `insert into public.client_legal_identities
  (client_id, studio_id, legal_given_name, legal_family_name, updated_by, created_at, updated_at)
  values ($1, $2, 'Synthetic', 'Person', $3, $4, $4)
  returning updated_by, created_at, updated_at`;

describe("C1: provenance belongs to the database, not the caller", () => {
  it("INSERT: a supplied updated_by (another practitioner, or one from another studio) is replaced by the caller's own", async () => {
    const forged = await asUser(aMember.userId, (q) => q(INSERT, [a.clientId, a.studioId, a.practitionerId, "2001-01-01T00:00:00Z"]));
    expect(forged.rows[0].updated_by).toBe(aMember.practitionerId);
    await adminQuery("delete from public.client_legal_identities where client_id = $1", [a.clientId]);
    // A practitioner id of ANOTHER studio is neither accepted nor reported as existing/missing:
    // the statement succeeds and the value is the caller's own.
    const cross = await asUser(aMember.userId, (q) => q(INSERT, [a.clientId, a.studioId, bMember.practitionerId, "2001-01-01T00:00:00Z"]));
    expect(cross.rows[0].updated_by).toBe(aMember.practitionerId);
    await adminQuery("delete from public.client_legal_identities where client_id = $1", [a.clientId]);
    // A random uuid that exists nowhere does not raise a foreign-key error either.
    const ghost = await asUser(aMember.userId, (q) => q(INSERT, [a.clientId, a.studioId, randomUUID(), "2001-01-01T00:00:00Z"]));
    expect(ghost.rows[0].updated_by).toBe(aMember.practitionerId);
  });

  it("INSERT: created_at and updated_at are set by the database, not by the statement", async () => {
    const r = (await adminQuery("select created_at, updated_at from public.client_legal_identities where client_id = $1", [a.clientId])).rows[0];
    expect(new Date(r.created_at).getFullYear()).toBeGreaterThan(2020);
    expect(new Date(r.updated_at).getFullYear()).toBeGreaterThan(2020);
  });

  it("UPDATE: a supplied updated_by is replaced by the caller's, and created_at cannot move", async () => {
    const before = (await adminQuery("select created_at from public.client_legal_identities where client_id = $1", [a.clientId])).rows[0];
    const upd = await asUser(a.userId, (q) =>
      q(
        "update public.client_legal_identities set legal_middle_name = 'M', updated_by = $2, created_at = '2001-01-01T00:00:00Z' where client_id = $1 returning updated_by, created_at",
        [a.clientId, bMember.practitionerId],
      ),
    );
    expect(upd.rows[0].updated_by).toBe(a.practitionerId);
    expect(new Date(upd.rows[0].created_at).toISOString()).toBe(new Date(before.created_at).toISOString());
  });

  it("client and studio stay immutable", async () => {
    await expect(
      asUser(a.userId, (q) => q("update public.client_legal_identities set studio_id = $2 where client_id = $1", [a.clientId, b.studioId])),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("C2: the three functions run with an empty-of-public search path", () => {
  it.each([
    ["can_use_client_legal_identity"],
    ["client_legal_identities_guard"],
    ["can_read_client_legal_identity"],
  ])("%s has search_path = pg_catalog, pg_temp", async (fn) => {
    const r = await adminQuery(
      "select proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname = $1",
      [fn],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].proconfig).toEqual(["search_path=pg_catalog, pg_temp"]);
  });
});

const TABLES = ["client_legal_identities", "studio_legal_name_access", "client_legal_name_access_audit"] as const;
const ROLES = ["anon", "authenticated", "service_role"] as const;

describe("C4: privileges by name on the hosted shape", () => {
  // authenticated holds exactly these on each table; anon and service_role hold none.
  const EXPECTED: Record<(typeof TABLES)[number], string[]> = {
    client_legal_identities: ["INSERT", "SELECT", "UPDATE"],
    studio_legal_name_access: ["SELECT"],
    client_legal_name_access_audit: ["SELECT"],
  };
  const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

  it.each(TABLES)("%s: exactly the intended table privileges per role", async (table) => {
    for (const role of ROLES) {
      const held: string[] = [];
      for (const p of PRIVS) {
        const r = await adminQuery("select has_table_privilege($1, $2::regclass, $3) as h", [role, `public.${table}`, p]);
        if (r.rows[0].h) held.push(p);
      }
      expect(held.sort(), `${role} on ${table}`).toEqual(role === "authenticated" ? EXPECTED[table] : []);
    }
  });

  it("the audit's identity sequence is usable by no API role", async () => {
    const seq = await adminQuery("select pg_get_serial_sequence('public.client_legal_name_access_audit', 'id') as s");
    for (const role of ROLES) {
      for (const p of ["USAGE", "SELECT", "UPDATE"]) {
        const r = await adminQuery("select has_sequence_privilege($1, $2, $3) as h", [role, seq.rows[0].s, p]);
        expect(r.rows[0].h, `${role} ${p}`).toBe(false);
      }
    }
  });

  const FUNCTIONS: Array<[string, string[]]> = [
    ["can_use_client_legal_identity(uuid)", ["authenticated"]],
    ["client_legal_identities_guard()", []],
    ["can_read_client_legal_identity(uuid)", ["authenticated"]],
    ["set_receptionist_legal_name_access(uuid, boolean)", ["authenticated"]],
    ["client_legal_name_access_audit_immutable()", []],
    ["receptionist_client_contacts_v2(uuid, text, integer)", ["authenticated"]],
    ["receptionist_calendar(uuid, timestamptz, timestamptz)", []], // closed by 0274 (Privacy R1)
    ["receptionist_calendar_v2(uuid, timestamptz, timestamptz)", ["authenticated"]],
    ["receptionist_client_directory(uuid, text, text[], text, integer, integer)", ["authenticated"]],
    ["receptionist_client_contacts(uuid, text, integer)", []],
  ];
  it.each(FUNCTIONS)("%s: EXECUTE is held by exactly %j", async (sig, allowed) => {
    const held: string[] = [];
    for (const role of ROLES) {
      const r = await adminQuery("select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as h", [role, `public.${sig}`]);
      if (r.rows[0].h) held.push(role);
    }
    expect(held).toEqual(allowed);
    const pub = await adminQuery(
      "select count(*)::int n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where p.oid = $1::regprocedure and x.grantee = 0 and x.privilege_type = 'EXECUTE'",
      [`public.${sig}`],
    );
    expect(pub.rows[0].n, "PUBLIC holds EXECUTE").toBe(0);
  });

  it("the switch and the audit have no INSERT, UPDATE, DELETE or ALL policy; the legal identity has no DELETE policy", async () => {
    const rows = (
      await adminQuery(
        "select tablename, cmd from pg_policies where schemaname = 'public' and tablename = any($1::text[])",
        [[...TABLES]],
      )
    ).rows as Array<{ tablename: string; cmd: string }>;
    for (const t of ["studio_legal_name_access", "client_legal_name_access_audit"]) {
      expect(rows.filter((r) => r.tablename === t).map((r) => r.cmd), t).toEqual(["SELECT"]);
    }
    const legal = rows.filter((r) => r.tablename === "client_legal_identities").map((r) => r.cmd).sort();
    expect(legal).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(legal).not.toContain("DELETE");
    expect(legal).not.toContain("ALL");
  });
});

describe("C3: preferred_name is not returned by any anon-callable path", () => {
  it("no function anon can execute names preferred_name, and none returns a clients row", async () => {
    const r = await adminQuery(
      `select p.proname, pg_get_function_result(p.oid) as result, p.prosrc
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.prokind = 'f'
          and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    );
    const offenders = r.rows
      .filter(
        (f: { prosrc: string; result: string }) =>
          /preferred_name/i.test(f.prosrc) || /preferred_name/i.test(f.result) || /\bpublic\.clients\b|\bSETOF\s+clients\b|^clients$/i.test(f.result),
      )
      .map((f: { proname: string }) => f.proname);
    expect(offenders).toEqual([]);
  });

  it("anon reads no clients row, so no preferred_name, through the API (RLS, with a client that has one)", async () => {
    await adminQuery("update public.clients set preferred_name = 'Synthetic Pref' where id = $1", [a.clientId]);
    const direct = await asRole("anon", async (q) => {
      try {
        return (await q("select preferred_name from public.clients where id = $1", [a.clientId])).rowCount;
      } catch (e) {
        expect((e as { code?: string }).code).toBe("42501"); // a privilege refusal is as good as zero rows
        return 0;
      }
    });
    expect(direct).toBe(0);
    const all = await asRole("anon", async (q) => {
      try {
        return (await q("select count(*)::int n from public.clients")).rows[0].n;
      } catch (e) {
        expect((e as { code?: string }).code).toBe("42501");
        return 0;
      }
    });
    expect(all).toBe(0);
  });
});

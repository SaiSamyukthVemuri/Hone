import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// APPOINTMENT BOUNDARY B3 — migration 0172 behavioural proof, fresh chain.
// ===========================================================================
//
// The cutover: `anon` and `authenticated` keep SELECT on `public.appointments`
// and `public.appointment_audit` and lose every write and maintenance verb.
// Every appointment write must now go through a service_role command.
//
// THREE TRAPS THIS SUITE IS BUILT AROUND — none of them optional.
//
// 1. A ZERO-ROW WRITE LOOKS LIKE SUCCESS. If a privilege were still granted, an
//    UPDATE/DELETE whose predicate matches nothing returns rowCount 0 and NO
//    error — indistinguishable from a policy refusal, and a silent pass. Every
//    probe below therefore uses a predicate matching NO rows: with the privilege
//    retained the statement SUCCEEDS and the test fails. This exact vacuous pass
//    has bitten this codebase four times.
//
// 2. `42501` DOES NOT MEAN "PRIVILEGE". An RLS WITH CHECK violation raises
//    SQLSTATE 42501 too — measured on this stack:
//        privilege denial -> `permission denied for table appointments`
//        RLS denial       -> `new row violates row-level security policy for ...`
//    The SQLSTATE alone cannot tell them apart, so every INSERT refusal below
//    asserts the MESSAGE as well and explicitly rejects /row-level security/i.
//    Without that discriminator this suite would pass unchanged on a database
//    where 0172 had never been applied.
//
// 3. `asRole()` ALWAYS ROLLS BACK (helpers/harness.ts). Assert the SQLSTATE,
//    never a row count, and never treat absence of rows as proof of refusal.

const INSUFFICIENT_PRIVILEGE = "42501";
const NO_SUCH_ROW = "00000000-0000-0000-0000-000000000000";

const TABLES = ["appointments", "appointment_audit"] as const;
const CLIENT_ROLES = ["anon", "authenticated"] as const;

/** Every verb 0172 revokes. SELECT is deliberately absent. */
const REVOKED_VERBS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
] as const;

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

type Failure = { code: string | null; message: string };

/** Run a statement under an explicit role and report how it failed, or null. */
async function attempt(
  role: (typeof CLIENT_ROLES)[number] | "service_role",
  sql: string,
  params: unknown[] = [],
): Promise<Failure | null> {
  try {
    await asRole(role, (q) => q(sql, params));
    return null; // the statement SUCCEEDED — for a zero-row predicate that is the failure mode
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? null, message: err.message ?? "" };
  }
}

/** Same, but as a real logged-in studio member so RLS predicates evaluate TRUE. */
async function attemptAsUser(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<Failure | null> {
  try {
    await asUser(userId, (q) => q(sql, params));
    return null;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? null, message: err.message ?? "" };
  }
}

/**
 * The discriminator from trap 2. A privilege refusal, and provably NOT an RLS
 * refusal that happens to share the SQLSTATE.
 */
function expectPrivilegeDenial(f: Failure | null, what: string): void {
  expect(f, `${what}: the statement SUCCEEDED — the privilege is still granted`).not.toBeNull();
  expect(f!.code, `${what} SQLSTATE`).toBe(INSUFFICIENT_PRIVILEGE);
  expect(f!.message, `${what} must be a PRIVILEGE denial`).toMatch(/permission denied/i);
  expect(
    f!.message,
    `${what} must NOT be an RLS refusal wearing the same SQLSTATE`,
  ).not.toMatch(/row-level security/i);
}

let A: SeededStudio;
let apptId: string;
let auditId: string;

beforeAll(async () => {
  A = await seedStudio("appt-b3");
  await adminQuery(`update public.studios set buffer_minutes = 0 where id = $1`, [A.studioId]);

  // A real appointment + audit row, written through the admin path, so the
  // SELECT-retention proofs below have something to actually read. If the
  // replacement policy narrowed the predicate these would return zero rows.
  const appt = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, $2, $3, null,
             '2033-06-01T10:00:00Z'::timestamptz, '2033-06-01T11:00:00Z'::timestamptz,
             60, 'confirmed', $4)
     returning id`,
    [A.studioId, A.practitionerId, A.clientId, hash64()],
  );
  apptId = appt.rows[0].id as string;

  const audit = await adminQuery(
    `insert into public.appointment_audit (id, appointment_id, actor_type, action)
     values (gen_random_uuid(), $1, 'system', 'created')
     returning id`,
    [apptId],
  );
  auditId = audit.rows[0].id as string;
});

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
// T1.1 — the ACL itself
// ---------------------------------------------------------------------------

describe("0172 — the privilege matrix: every revoked verb is gone from both browser roles", () => {
  for (const table of TABLES) {
    for (const role of CLIENT_ROLES) {
      it(`${table}: ${role} holds none of INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN`, async () => {
        const r = await adminQuery(
          `select ${REVOKED_VERBS.map(
            (v, i) => `has_table_privilege($1, $2, '${v}') p${i}`,
          ).join(", ")}`,
          [role, `public.${table}`],
        );
        expect(r.rowCount, "the probe itself must return a row").toBe(1);
        REVOKED_VERBS.forEach((verb, i) => {
          expect(r.rows[0][`p${i}`], `${role} must NOT hold ${verb} on ${table}`).toBe(false);
        });
      });
    }
  }
});

describe("0172 — MAINTAIN is genuinely supported here, so its absence means something", () => {
  // If this server were pre-PostgreSQL 17, has_table_privilege(...,'MAINTAIN')
  // would ERROR rather than return false — and a suite that only asserted
  // `false` could never tell "revoked" from "unsupported". Production measured
  // MAINTAIN PRESENT, so it must be measurable here for the revoke to be proven.
  it("the server is PostgreSQL 17+ and MAINTAIN is a recognised table privilege", async () => {
    const v = await adminQuery(`select current_setting('server_version_num')::int n`);
    expect(v.rows[0].n, "MAINTAIN requires PostgreSQL 17+").toBeGreaterThanOrEqual(170000);

    // Positive control: a role that DOES hold MAINTAIN reads true, proving the
    // false readings above are a revocation and not a probe that always says no.
    const control = await adminQuery(
      `select has_table_privilege('service_role','public.appointments','MAINTAIN') p`,
    );
    expect(control.rows[0].p, "service_role must still hold MAINTAIN").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T1.2 — SELECT is retained
// ---------------------------------------------------------------------------

describe("0172 — SELECT is RETAINED on both tables for both browser roles", () => {
  for (const table of TABLES) {
    for (const role of CLIENT_ROLES) {
      it(`${table}: ${role} still holds the SELECT privilege`, async () => {
        const r = await adminQuery(`select has_table_privilege($1, $2, 'SELECT') p`, [
          role,
          `public.${table}`,
        ]);
        expect(r.rows[0].p).toBe(true);
      });

      it(`${table}: a ${role} SELECT statement is not refused at the privilege layer`, async () => {
        // RLS may legitimately return zero rows; this asserts only that the
        // statement RUNS. A `revoke all` slip would refuse it outright.
        expect(await attempt(role, `select count(*) from public.${table}`)).toBeNull();
      });
    }
  }

  it("a real studio member can still READ their own appointment", async () => {
    // The two-way self-test for GROUP 3: if appointments_member_select had
    // narrowed or dropped the is_studio_member predicate this returns 0 rows.
    const r = await asUser(A.userId, (q) =>
      q(`select id from public.appointments where id = $1`, [apptId]),
    );
    expect(r.rowCount, "the replacement SELECT policy must preserve member reads").toBe(1);
  });

  it("a real studio member can still READ the appointment's audit trail", async () => {
    // appointment_audit_member_read reaches the studio through a subquery ON
    // appointments, so it is filtered by the appointments SELECT policy too.
    // This proves the replacement policy kept that transitive path alive.
    const r = await asUser(A.userId, (q) =>
      q(`select id, action from public.appointment_audit where appointment_id = $1`, [apptId]),
    );
    expect(r.rowCount, "the audit read path is transitively coupled to GROUP 3").toBe(1);
    expect(r.rows[0].action).toBe("created");
  });
});

// ---------------------------------------------------------------------------
// T1.3 / T1.4 — zero-row UPDATE and DELETE probes
// ---------------------------------------------------------------------------

describe("0172 — UPDATE and DELETE are refused by PRIVILEGE, not by a zero-row result", () => {
  for (const table of TABLES) {
    for (const role of CLIENT_ROLES) {
      it(`${table}: a no-row UPDATE as ${role} raises 42501, not a silent rowCount 0`, async () => {
        // The predicate matches nothing. With the privilege granted this would
        // return rowCount 0 and NO error, and `attempt` would return null.
        expectPrivilegeDenial(
          await attempt(
            role,
            `update public.${table} set id = id where id = '${NO_SUCH_ROW}'`,
          ),
          `${role} UPDATE ${table}`,
        );
      });

      it(`${table}: a no-row DELETE as ${role} raises 42501`, async () => {
        expectPrivilegeDenial(
          await attempt(role, `delete from public.${table} where id = '${NO_SUCH_ROW}'`),
          `${role} DELETE ${table}`,
        );
      });
    }
  }
});

// ---------------------------------------------------------------------------
// T1.5 — the INSERT refusal, with the mandatory message discriminator
// ---------------------------------------------------------------------------

describe("0172 — INSERT is refused by PRIVILEGE, provably not merely by RLS", () => {
  for (const table of TABLES) {
    for (const role of CLIENT_ROLES) {
      it(`${table}: an INSERT as ${role} is a privilege denial, not an RLS denial`, async () => {
        expectPrivilegeDenial(
          await attempt(role, `insert into public.${table} default values`),
          `${role} INSERT ${table}`,
        );
      });
    }
  }

  it("T4.5 — a REAL studio member inserting into their OWN studio is refused at the privilege layer", async () => {
    // This is the case the old posture allowed. RLS WITH CHECK
    // is_studio_member(A) would have PASSED here: same studio, active owner.
    // Under 0172 the statement never reaches RLS at all.
    expectPrivilegeDenial(
      await attemptAsUser(
        A.userId,
        `insert into public.appointments
           (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
            duration_minutes, status, cancellation_token_hash)
         values (gen_random_uuid(), $1, null, $2, null,
                 '2033-07-01T10:00:00Z'::timestamptz, '2033-07-01T11:00:00Z'::timestamptz,
                 60, 'confirmed', $3)`,
        [A.studioId, A.clientId, hash64()],
      ),
      "own-studio member INSERT",
    );
  });

  it("a member can no longer FORGE an audit row for their own studio", async () => {
    // 0010's appointment_audit_member_insert actively PERMITTED this: the
    // member's own appointment satisfied the WITH CHECK subquery. Both the
    // privilege and the policy are gone.
    expectPrivilegeDenial(
      await attemptAsUser(
        A.userId,
        `insert into public.appointment_audit (id, appointment_id, actor_type, action)
         values (gen_random_uuid(), $1, 'practitioner', 'forged')`,
        [apptId],
      ),
      "own-studio audit forge",
    );
  });

  it("a member can no longer TAMPER WITH or ERASE an existing audit row", async () => {
    // Targets the REAL row, so RLS is not what stops it. Before 0172 these
    // returned rowCount 0 (RLS default-deny, no UPDATE/DELETE policy); now they
    // are refused outright.
    expectPrivilegeDenial(
      await attemptAsUser(
        A.userId,
        `update public.appointment_audit set action = 'tampered' where id = $1`,
        [auditId],
      ),
      "audit UPDATE",
    );
    expectPrivilegeDenial(
      await attemptAsUser(A.userId, `delete from public.appointment_audit where id = $1`, [
        auditId,
      ]),
      "audit DELETE",
    );

    // ...and the row is durably intact.
    const surviving = await adminQuery(
      `select action from public.appointment_audit where id = $1`,
      [auditId],
    );
    expect(surviving.rows[0].action).toBe("created");
  });

  it("the message discriminator is not vacuous — an RLS refusal really does read differently", async () => {
    // Negative control for trap 2. `clients` still carries a member FOR ALL
    // policy and an authenticated INSERT grant, so an out-of-studio insert is
    // refused by RLS with the SAME SQLSTATE and a DIFFERENT message. If this
    // ever stops holding, expectPrivilegeDenial() has lost its power to
    // distinguish and every proof above weakens to an ACL restatement.
    const rls = await attempt(
      "authenticated",
      `insert into public.clients (id, studio_id, name)
       values (gen_random_uuid(), $1, 'rls-control')`,
      [A.studioId],
    );
    expect(rls, "the control statement must fail").not.toBeNull();
    expect(rls!.code, "same SQLSTATE as a privilege denial").toBe(INSUFFICIENT_PRIVILEGE);
    expect(rls!.message, "but a DIFFERENT message").toMatch(/row-level security/i);
    expect(rls!.message).not.toMatch(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// T1.6 — TRUNCATE, REFERENCES, TRIGGER, MAINTAIN behaviourally
// ---------------------------------------------------------------------------

describe("0172 — the maintenance and definition verbs are behaviourally gone", () => {
  for (const table of TABLES) {
    for (const role of CLIENT_ROLES) {
      it(`${table}: ${role} cannot TRUNCATE`, async () => {
        // TRUNCATE is not filtered by RLS at all, so this can only ever be a
        // privilege refusal — and before 0172 it would have EMPTIED the table.
        expectPrivilegeDenial(
          await attempt(role, `truncate table public.${table}`),
          `${role} TRUNCATE ${table}`,
        );
      });
    }

    it(`${table}: authenticated cannot LOCK the table (the MAINTAIN capability)`, async () => {
      // LOCK TABLE is the reachable expression of MAINTAIN: pre-17 it needed
      // one of several verbs, and on 17+ MAINTAIN alone confers it. With
      // `arwdDxtm` this succeeded silently and could stall the command layer.
      expectPrivilegeDenial(
        await attempt("authenticated", `lock table public.${table} in access exclusive mode`),
        `authenticated LOCK ${table}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// T1.7 — service_role is untouched
// ---------------------------------------------------------------------------

describe("0172 — service_role is UNCHANGED, because the command layer runs as it", () => {
  for (const table of TABLES) {
    it(`${table}: service_role retains every verb it held before 0172`, async () => {
      const r = await adminQuery(
        `select ${["SELECT", ...REVOKED_VERBS]
          .map((v, i) => `has_table_privilege('service_role', $1, '${v}') p${i}`)
          .join(", ")}`,
        [`public.${table}`],
      );
      ["SELECT", ...REVOKED_VERBS].forEach((verb, i) => {
        expect(r.rows[0][`p${i}`], `service_role must RETAIN ${verb} on ${table}`).toBe(true);
      });
    });
  }

  it("service_role can still write an appointment and its audit row", async () => {
    // The end-to-end point of the whole programme: the governed path works
    // while the direct browser path does not.
    const r = await asRole("service_role", (q) =>
      q(
        `insert into public.appointments
           (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
            duration_minutes, status, cancellation_token_hash)
         values (gen_random_uuid(), $1, null, $2, null,
                 '2033-08-01T10:00:00Z'::timestamptz, '2033-08-01T11:00:00Z'::timestamptz,
                 60, 'confirmed', $3)
         returning id`,
        [A.studioId, A.clientId, hash64()],
      ),
    );
    expect(r.rows[0].id).toBeTruthy();
    // asRole rolls back, so nothing above persists — the proof is that the
    // statement was ACCEPTED, not that a row survives.
  });

  it("postgres (the migration channel and table owner) is unchanged", async () => {
    for (const table of TABLES) {
      const r = await adminQuery(
        `select has_table_privilege('postgres', $1, 'INSERT') i,
                has_table_privilege('postgres', $1, 'UPDATE') u,
                has_table_privilege('postgres', $1, 'DELETE') d,
                has_table_privilege('postgres', $1, 'TRUNCATE') t`,
        [`public.${table}`],
      );
      expect(r.rows[0].i, table).toBe(true);
      expect(r.rows[0].u, table).toBe(true);
      expect(r.rows[0].d, table).toBe(true);
      expect(r.rows[0].t, table).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// T1.8 — PUBLIC holds nothing, and the ACL shape is exactly as intended
// ---------------------------------------------------------------------------

describe("0172 — PUBLIC holds no grant, and the resulting ACL is exactly SELECT-only", () => {
  for (const table of TABLES) {
    it(`${table}: PUBLIC holds no grant of any kind`, async () => {
      // aclexplode(grantee = 0) is PUBLIC. Note it reads 0 rows both when PUBLIC
      // has no grant AND when relacl IS NULL, so the ACL shape test below is
      // what actually proves the ACL is populated.
      const r = await adminQuery(
        `select coalesce((select count(*) from pg_class c
                            join pg_namespace n on n.oid = c.relnamespace
                            cross join lateral aclexplode(c.relacl) a
                           where n.nspname='public' and c.relname=$1
                             and a.grantee = 0), 0) n`,
        [table],
      );
      expect(Number(r.rows[0].n)).toBe(0);
    });

    it(`${table}: the browser roles' ACL entries are exactly the SELECT bit`, async () => {
      // Reads the ACL directly rather than asking has_table_privilege seven
      // times, so an UNEXPECTED privilege — one nobody thought to name — also
      // fails this test.
      const r = await adminQuery(
        `select a.grantee::regrole::text role, string_agg(a.privilege_type, ',' order by a.privilege_type) privs
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           cross join lateral aclexplode(c.relacl) a
          where n.nspname='public' and c.relname=$1
            and a.grantee::regrole::text in ('anon','authenticated')
          group by a.grantee`,
        [table],
      );
      expect(r.rowCount, `${table}: both browser roles must still appear in the ACL`).toBe(2);
      for (const row of r.rows) {
        expect(row.privs, `${table} ${row.role} must hold SELECT and nothing else`).toBe("SELECT");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// T1.9 — the policy set has exactly the intended shape
// ---------------------------------------------------------------------------

describe("0172 — the policy set is exactly the intended shape", () => {
  it("appointments carries exactly one policy: appointments_member_select, SELECT-only", async () => {
    const r = await adminQuery(
      `select p.polname, p.polcmd,
              pg_get_expr(p.polqual, p.polrelid) qual,
              pg_get_expr(p.polwithcheck, p.polrelid) wc,
              (select array_agg(rolname::text order by rolname)
                 from pg_roles where oid = any(p.polroles)) roles
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname='appointments'
        order by p.polname`,
    );
    expect(r.rows.map((x) => x.polname)).toEqual(["appointments_member_select"]);
    expect(r.rows[0].polcmd, "'r' is SELECT").toBe("r");
    expect(r.rows[0].qual, "the membership predicate must be reused verbatim").toBe(
      "is_studio_member(studio_id)",
    );
    expect(r.rows[0].wc, "a SELECT policy has no WITH CHECK").toBeNull();
    expect(r.rows[0].roles).toEqual(["authenticated"]);
  });

  it("appointments_member_all is GONE", async () => {
    const r = await adminQuery(
      `select count(*)::int n from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and p.polname = 'appointments_member_all'`,
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("appointment_audit carries exactly one policy: the PRESERVED read policy", async () => {
    const r = await adminQuery(
      `select p.polname, p.polcmd, pg_get_expr(p.polqual, p.polrelid) qual
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname='appointment_audit'
        order by p.polname`,
    );
    expect(r.rows.map((x) => x.polname)).toEqual(["appointment_audit_member_read"]);
    expect(r.rows[0].polcmd).toBe("r");
    // B3 does NOT rewrite this predicate; its studio_id redesign is B5/0174.
    expect(r.rows[0].qual).toMatch(/is_studio_member/);
    expect(r.rows[0].qual).toMatch(/appointment_id/);
  });

  it("appointment_audit_member_insert is GONE", async () => {
    const r = await adminQuery(
      `select count(*)::int n from pg_policy p
         where p.polname = 'appointment_audit_member_insert'`,
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("RLS is still ENABLED on both tables", async () => {
    const r = await adminQuery(
      `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname = any($1) order by c.relname`,
      [[...TABLES]],
    );
    expect(r.rowCount).toBe(2);
    for (const row of r.rows) expect(row.relrowsecurity, row.relname).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T1.10 — nothing else drifted
// ---------------------------------------------------------------------------

describe("0172 — no trigger or function drift", () => {
  it("snapshot_appointment_buffer still exists and was NOT replaced by this migration", async () => {
    // The standing prohibition: production's copy carries out-of-band behaviour
    // that exists in no migration here. 0172 contains no function statement at
    // all, so the function's presence is asserted, never its body.
    const r = await adminQuery(
      `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname='public' and p.proname='snapshot_appointment_buffer'`,
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  it("both tables keep every non-internal trigger they had", async () => {
    const r = await adminQuery(
      `select c.relname t, count(*)::int n
         from pg_trigger g join pg_class c on c.oid = g.tgrelid
         join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname='public' and not g.tgisinternal and c.relname = any($1)
        group by c.relname order by c.relname`,
      [[...TABLES]],
    );
    const byTable = Object.fromEntries(r.rows.map((x) => [x.t, x.n]));
    expect(byTable.appointments, "appointments triggers").toBeGreaterThan(0);
  });

  it("is_studio_member was not rewritten and is still authenticated-executable", async () => {
    const r = await adminQuery(
      `select p.prosecdef, p.provolatile,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') a
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='is_studio_member'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].prosecdef, "security definer").toBe(true);
    expect(r.rows[0].provolatile, "stable").toBe("s");
    expect(r.rows[0].a, "the replacement policy depends on this EXECUTE grant").toBe(true);
  });
});

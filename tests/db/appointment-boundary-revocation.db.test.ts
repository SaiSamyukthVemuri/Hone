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
  // MANDATORY, not hygiene. `attemptAsUser` goes through asUser, which COMMITS
  // on success (harness.ts) — unlike asRole, which always rolls back. Every
  // attemptAsUser probe below EXPECTS to fail, so nothing normally commits; but
  // on a database where 0172 was NOT applied those probes SUCCEED and commit,
  // leaving forged appointments and forged audit rows permanently in the shared
  // local stack. That is precisely the run where an engineer is debugging, and
  // the pollution would outlive the red test. Clean up unconditionally.
  await adminQuery(
    `delete from public.appointment_audit
      where appointment_id in (select id from public.appointments where studio_id = $1)`,
    [A.studioId],
  );
  await adminQuery(`delete from public.appointments where studio_id = $1`, [A.studioId]);
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
    // Guarded: if both writes had succeeded and committed, rows[0] is undefined
    // and an unguarded property read would die with a TypeError instead of
    // reporting the actual defect.
    expect(surviving.rowCount, "the audit row must still exist").toBe(1);
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
        // privilege refusal. Note the blast radius differs per table: with the
        // grant restored, `appointment_audit` really would be EMPTIED, while
        // `appointments` raises 0A000 first (appointment_audit's FK references
        // it). 42501 here proves the privilege check fires before either.
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
    // Pinned to the EXACT normalised text: /is_studio_member/ + /appointment_id/
    // would both still match a predicate widened to `... OR true`.
    expect(r.rows[0].qual.replace(/\s+/g, " ").trim()).toBe(
      "(appointment_id IN ( SELECT appointments.id FROM appointments " +
        "WHERE is_studio_member(appointments.studio_id)))",
    );
  });

  it("appointment_audit_member_insert is GONE", async () => {
    const r = await adminQuery(
      `select count(*)::int n from pg_policy p
         where p.polname = 'appointment_audit_member_insert'`,
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("appointments carries NO policy granted to PUBLIC or to anon", async () => {
    // `anon` KEEPS the SELECT table grant (0172 never names SELECT) but after
    // GROUP 3 there is no policy it can satisfy, so it reads zero rows — the
    // same zero it read before, when appointments_member_all evaluated
    // is_studio_member() to false for a null auth.uid().
    //
    // That combination is a latent hazard worth pinning: if a future feature
    // ever adds a permissive `TO public` SELECT policy here, the retained anon
    // grant turns it straight into unauthenticated PostgREST access to every
    // studio's schedule, with no second gate. This test is that tripwire.
    const r = await adminQuery(
      `select p.polname,
              (select array_agg(rolname::text order by rolname)
                 from pg_roles where oid = any(p.polroles)) roles
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname='appointments'`,
    );
    for (const row of r.rows) {
      // polroles = {0} (PUBLIC) surfaces as a null array from pg_roles.
      expect(row.roles, `${row.polname} must name explicit roles, not PUBLIC`).not.toBeNull();
      expect(row.roles, `${row.polname} must not include anon`).not.toContain("anon");
    }
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
// T1.11 — THE RESIDUE 0172 DOES NOT CLOSE, measured rather than assumed
// ---------------------------------------------------------------------------

describe("0172 — the boundary's known edge: FK referential actions still reach appointments", () => {
  // A referential action runs as the CONSTRAINT's owner, not as the caller, and
  // consults neither the table ACL nor RLS (appointments is not FORCE RLS). So a
  // member who may DELETE a PARENT row can still cause a write to appointments
  // without ever holding a privilege on it.
  //
  // This is NOT closed by 0172 and is deliberately out of its scope: closing it
  // means changing grants or FK actions on OTHER tables (`services`,
  // `practitioners`), and 0172's whole value is being exactly two tables wide.
  // It is pinned HERE, measured, so the boundary's real shape is recorded and a
  // silent widening — a new CASCADE, or a delete policy appearing on `clients` —
  // fails a test instead of going unnoticed.

  it("the delete actions on appointments' FKs are exactly as measured", async () => {
    const r = await adminQuery(
      `select conname, confdeltype
         from pg_constraint
        where conrelid='public.appointments'::regclass and contype='f'
        order by conname`,
    );
    // c = CASCADE, n = SET NULL. A new 'c' on a parent a member can delete
    // would turn "a column is nulled" into "the appointment row disappears".
    expect(Object.fromEntries(r.rows.map((x) => [x.conname, x.confdeltype]))).toEqual({
      appointments_client_same_studio_fk: "c",
      appointments_practitioner_same_studio_fk: "n",
      appointments_rescheduled_from_appointment_id_fkey: "n",
      appointments_rescheduled_to_appointment_id_fkey: "n",
      appointments_service_same_studio_fk: "n",
      appointments_studio_id_fkey: "c",
    });
  });

  it("the two CASCADE parents are NOT member-deletable, so no member can delete an appointment row", async () => {
    // This is the load-bearing half. `clients` and `studios` cascade-delete
    // appointments, but neither carries a DELETE policy, so RLS default-denies
    // the parent delete and the cascade is unreachable. If a delete policy ever
    // appears on either, a member gains indirect row deletion on appointments.
    const r = await adminQuery(
      `select c.relname, count(*) filter (where p.polcmd in ('d','*'))::int del_policies
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_policy p on p.polrelid = c.oid
        where n.nspname='public' and c.relname in ('clients','studios')
        group by c.relname order by c.relname`,
    );
    expect(r.rowCount).toBe(2);
    for (const row of r.rows) {
      expect(row.del_policies, `${row.relname} must have no DELETE-capable policy`).toBe(0);
    }
  });

  // SUPERSEDED BY B4 / MIGRATION 0173 (GROUP 5).
  //
  // When B3 shipped, this assertion read "a member CAN still null
  // appointments.service_id by deleting the service — recorded, not fixed", and
  // that was the truth at 0172: L23 was documented, deliberately left open, and
  // pinned here so it could not be forgotten.
  //
  // 0173's GROUP 5 closed it — `revoke delete on public.services from anon, authenticated`
  // plus the 0087-style policy split. The reproduction below therefore now
  // stops at the member's DELETE, and this test asserts the CLOSURE instead of
  // the hazard. It is deliberately kept in this file rather than deleted: the
  // direct-vs-indirect contrast is what makes the boundary comprehensible, and
  // a future migration that re-granted parent DELETE would light this up right
  // next to the revocations it belongs with.
  //
  // 0172 itself is untouched by B4 — not one byte. The full L23 treatment,
  // including the two-way self-test that proves the hazard was real before
  // GROUP 5, lives in tests/db/appointment-parent-delete-boundary.db.test.ts.
  it("a member can NO LONGER null appointments.service_id by deleting the service (0173 GROUP 5)", async () => {
    // Reproduced end to end, then rolled back. asUser COMMITS on success, so
    // this runs through asRole (which always rolls back) with a member identity
    // supplied explicitly.
    const s = await adminQuery(
      `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
       values (gen_random_uuid(), $1, 'b3-fk-residue', 60, 0, true) returning id`,
      [A.studioId],
    );
    const serviceId = s.rows[0].id as string;
    const a = await adminQuery(
      `insert into public.appointments
         (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
          duration_minutes, status, cancellation_token_hash)
       values (gen_random_uuid(), $1, null, $2, $3,
               '2033-11-01T10:00:00Z'::timestamptz, '2033-11-01T11:00:00Z'::timestamptz,
               60, 'confirmed', $4)
       returning id`,
      [A.studioId, A.clientId, serviceId, hash64()],
    );
    const targetId = a.rows[0].id as string;

    const nulled = await asRole("authenticated", async (q) => {
      await q(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: A.userId, role: "authenticated" }),
      ]);
      // The direct route is refused...
      let direct: string | null = null;
      try {
        await q(`update public.appointments set service_id = null where id = $1`, [targetId]);
      } catch (e) {
        direct = (e as { code?: string }).code ?? null;
      }
      return direct;
    });
    expect(nulled, "the DIRECT update must still be refused by privilege").toBe(
      INSUFFICIENT_PRIVILEGE,
    );

    // ...and after 0173's GROUP 5 the INDIRECT route is refused too. Separate
    // transaction: the failed statement above aborts its own.
    const after = await asRole("authenticated", async (q) => {
      await q(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: A.userId, role: "authenticated" }),
      ]);
      let parent: string | null = null;
      try {
        await q(`delete from public.services where id = $1`, [serviceId]);
      } catch (e) {
        parent = (e as { code?: string }).code ?? null;
      }
      return parent;
    });
    expect(
      after,
      "0173 GROUP 5 revoked DELETE on services, so the parent delete is refused at the privilege layer",
    ).toBe(INSUFFICIENT_PRIVILEGE);

    // The lineage survived: the FK's ON DELETE SET NULL never fired, because
    // the delete that would have triggered it never happened.
    const lineage = await adminQuery(
      `select service_id from public.appointments where id = $1`,
      [targetId],
    );
    expect(lineage.rows[0].service_id, "appointment lineage intact").toBe(
      serviceId,
    );

    await adminQuery(`delete from public.appointments where id = $1`, [targetId]);
    await adminQuery(`delete from public.services where id = $1`, [serviceId]);
  });
});

// ---------------------------------------------------------------------------
// T1.10 — nothing else drifted
// ---------------------------------------------------------------------------

describe("0172 — no trigger or function drift", () => {
  it("snapshot_appointment_buffer still EXISTS (that it was not replaced is proven by the source test)", async () => {
    // The standing prohibition: production's copy carries out-of-band behaviour
    // that exists in no migration here. 0172 contains no function statement at
    // all, so the function's presence is asserted, never its body.
    const r = await adminQuery(
      `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname='public' and p.proname='snapshot_appointment_buffer'`,
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  it("both tables keep EXACTLY the non-internal triggers they had", async () => {
    // Pinned to the exact count, not `> 0`. A `toBeGreaterThan(0)` here would
    // still pass after six of the seven were dropped, while reporting "no
    // trigger drift" — and appointment_audit would not be covered at all,
    // because it has none and its key would simply be undefined.
    const r = await adminQuery(
      `select c.relname t, count(*)::int n
         from pg_trigger g join pg_class c on c.oid = g.tgrelid
         join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname='public' and not g.tgisinternal and c.relname = any($1)
        group by c.relname order by c.relname`,
      [[...TABLES]],
    );
    const byTable = Object.fromEntries(r.rows.map((x) => [x.t, x.n]));
    expect(byTable.appointments, "appointments non-internal triggers").toBe(7);
    expect(byTable.appointment_audit ?? 0, "appointment_audit non-internal triggers").toBe(0);
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

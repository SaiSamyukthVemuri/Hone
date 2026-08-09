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
// 0174 — PRACTITIONER IDENTITY BOUNDARY (audit finding A-P1-01).
// ===========================================================================
//
// `public.practitioners` is the identity spine: every auth.uid()-derived
// clinical guarantee resolves through a row here. Before 0174 it was an
// ordinary authenticated-writable table, and the 0001 policy
// `practitioners: owners update` pinned only `is_studio_owner(studio_id)` — it
// constrained WHICH ROWS, never WHICH COLUMNS. Measured on a local chain, a
// studio owner rewrote a COLLEAGUE's `user_id`, `role`, `active`,
// `display_name` and `color` in one statement (UPDATE 1).
//
// TWO TRAPS THIS SUITE IS BUILT AROUND.
//
// 1. `42501` IS AMBIGUOUS. An RLS refusal raises the same SQLSTATE as a
//    privilege refusal. Only the message separates them:
//       privilege -> `permission denied for table practitioners`
//       RLS       -> `new row violates row-level security policy ...`
//    Every direct-DML probe below asserts the MESSAGE, so this suite cannot
//    pass on a database where 0174 was never applied but a policy happened to
//    filter the row.
//
// 2. A ZERO-ROW UPDATE IS NOT A REFUSAL. Before 0174 a NON-OWNER's profile save
//    matched no rows and returned success — the bug this migration also fixes.
//    So "it didn't change anything" is never accepted as proof; the probes
//    assert a raised error, and the self-service tests assert the row actually
//    changed.

const INSUFFICIENT_PRIVILEGE = "42501";
const WRITE_VERBS = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const;
const hex64 = () => "a".repeat(64);

let A: SeededStudio; // studio A: owner + member
let B: SeededStudio; // studio B: unrelated owner
let memberUserId: string;
let memberPractId: string;

type Failure = { code: string | null; message: string };

async function attempt(
  role: "anon" | "authenticated",
  sql: string,
  params: unknown[] = [],
): Promise<Failure | null> {
  try {
    await asRole(role, (q) => q(sql, params));
    return null;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? null, message: err.message ?? "" };
  }
}

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

/** A PRIVILEGE refusal, provably not an RLS refusal wearing the same SQLSTATE. */
function expectPrivilegeDenial(f: Failure | null, what: string): void {
  expect(f, `${what}: the statement SUCCEEDED — the privilege is still granted`).not.toBeNull();
  expect(f!.code, `${what} SQLSTATE`).toBe(INSUFFICIENT_PRIVILEGE);
  expect(f!.message, `${what} must be a PRIVILEGE denial`).toMatch(
    /permission denied for table practitioners/i,
  );
  expect(f!.message, `${what} must not be an RLS refusal`).not.toMatch(/row-level security/i);
}

beforeAll(async () => {
  A = await seedStudio("pib-a");
  B = await seedStudio("pib-b");
  // A non-owner member of studio A — the actor the old owner-only UPDATE policy
  // silently failed.
  memberUserId = randomUUID();
  memberPractId = randomUUID();
  const email = `pib-member-${memberUserId.slice(0, 8)}@harness.local`;
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [memberUserId, email]);
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, 'Member', $4, 'practitioner', true)`,
    [memberPractId, A.studioId, memberUserId, email],
  );
});

afterAll(async () => {
  await adminQuery(`delete from public.practitioners where id = $1`, [memberPractId]);
  await adminQuery(`delete from auth.users where id = $1`, [memberUserId]);
  await closePool();
});

// ---------------------------------------------------------------------------

describe("0174 — the privilege matrix", () => {
  for (const role of ["authenticated", "anon"] as const) {
    it(`${role} holds no INSERT/UPDATE/DELETE/TRUNCATE on practitioners`, async () => {
      const r = await adminQuery(
        `select ${WRITE_VERBS.map((v, i) => `has_table_privilege($1,'public.practitioners','${v}') p${i}`).join(", ")}`,
        [role],
      );
      expect(r.rowCount).toBe(1);
      WRITE_VERBS.forEach((v, i) => {
        expect(r.rows[0][`p${i}`], `${role} must NOT hold ${v}`).toBe(false);
      });
    });
  }

  it("authenticated RETAINS SELECT — 31 read sites depend on it", async () => {
    const r = await adminQuery(
      `select has_table_privilege('authenticated','public.practitioners','SELECT') a,
              has_table_privilege('anon','public.practitioners','SELECT') n`,
    );
    expect(r.rows[0].a).toBe(true);
    expect(r.rows[0].n).toBe(true);
  });

  it("service_role is UNCHANGED — governed roster administration runs there", async () => {
    const r = await adminQuery(
      `select has_table_privilege('service_role','public.practitioners','INSERT') i,
              has_table_privilege('service_role','public.practitioners','UPDATE') u,
              has_table_privilege('service_role','public.practitioners','DELETE') d,
              has_table_privilege('service_role','public.practitioners','SELECT') s`,
    );
    for (const k of ["i", "u", "d", "s"]) {
      expect(r.rows[0][k], `service_role ${k}`).toBe(true);
    }
  });

  it("the browser roles' ACL is exactly the SELECT bit", async () => {
    const r = await adminQuery(
      `select a.grantee::regrole::text role,
              string_agg(a.privilege_type, ',' order by a.privilege_type) privs
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(c.relacl) a
        where n.nspname='public' and c.relname='practitioners'
          and a.grantee::regrole::text in ('anon','authenticated')
        group by a.grantee`,
    );
    expect(r.rowCount).toBe(2);
    for (const row of r.rows) expect(row.privs, row.role).toBe("SELECT");
  });
});

describe("0174 — direct DML is refused by PRIVILEGE, for every column and role", () => {
  // Zero-row predicates: with the privilege retained these would succeed with
  // rowCount 0 and no error, and `attempt` would return null.
  const NOROW = "00000000-0000-0000-0000-000000000000";

  it.each([
    ["user_id", `update public.practitioners set user_id = null where id = '${NOROW}'`],
    ["role", `update public.practitioners set role = 'owner' where id = '${NOROW}'`],
    ["active", `update public.practitioners set active = false where id = '${NOROW}'`],
    ["display_name", `update public.practitioners set display_name = 'x' where id = '${NOROW}'`],
    ["color", `update public.practitioners set color = 'rose' where id = '${NOROW}'`],
    [
      "calendar_feed_token_hash",
      `update public.practitioners set calendar_feed_token_hash = null where id = '${NOROW}'`,
    ],
  ])("authenticated cannot direct-UPDATE %s", async (_col, sql) => {
    expectPrivilegeDenial(await attempt("authenticated", sql), `UPDATE ${_col}`);
  });

  it("an OWNER cannot direct-UPDATE a colleague's identity — the exact pre-0174 exploit", async () => {
    // Reproduced before 0174 as UPDATE 1: user_id + role + active in ONE
    // statement against a COLLEAGUE's row, by a legitimate studio owner.
    expectPrivilegeDenial(
      await attemptAsUser(
        A.userId,
        `update public.practitioners
            set user_id = $1, role = 'owner', active = false, display_name = 'HIJACKED'
          where id = $2`,
        [B.userId, memberPractId],
      ),
      "owner hijacking a colleague",
    );
    const after = await adminQuery(
      `select display_name, role, active, user_id from public.practitioners where id = $1`,
      [memberPractId],
    );
    expect(after.rows[0].display_name).not.toBe("HIJACKED");
    expect(after.rows[0].role).toBe("practitioner");
    expect(after.rows[0].active).toBe(true);
    expect(after.rows[0].user_id).toBe(memberUserId);
  });

  it("an owner cannot direct-DELETE a practitioner", async () => {
    expectPrivilegeDenial(
      await attemptAsUser(A.userId, `delete from public.practitioners where id = $1`, [
        memberPractId,
      ]),
      "owner DELETE",
    );
    const still = await adminQuery(`select count(*)::int n from public.practitioners where id=$1`, [
      memberPractId,
    ]);
    expect(still.rows[0].n).toBe(1);
  });

  it("an owner cannot direct-INSERT a practitioner", async () => {
    expectPrivilegeDenial(
      await attemptAsUser(
        A.userId,
        `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
         values (gen_random_uuid(), $1, $2, 'Injected', 'inj@harness.local', 'owner', true)`,
        [A.studioId, B.userId],
      ),
      "owner INSERT",
    );
  });

  it("a NON-OWNER member cannot direct-write either", async () => {
    expectPrivilegeDenial(
      await attemptAsUser(
        memberUserId,
        `update public.practitioners set display_name = 'x' where id = $1`,
        [memberPractId],
      ),
      "member UPDATE",
    );
  });

  it("anon cannot mutate practitioners at all", async () => {
    for (const [label, sql] of [
      ["UPDATE", `update public.practitioners set role = 'owner' where id = '${NOROW}'`],
      ["DELETE", `delete from public.practitioners where id = '${NOROW}'`],
      ["INSERT", `insert into public.practitioners default values`],
      ["TRUNCATE", `truncate table public.practitioners`],
    ] as const) {
      expectPrivilegeDenial(await attempt("anon", sql), `anon ${label}`);
    }
  });

  it("authenticated retains the required SELECT behaviour through RLS", async () => {
    const own = await asUser(A.userId, (q) =>
      q(`select id from public.practitioners where studio_id = $1`, [A.studioId]),
    );
    expect(own.rowCount, "a member must still read their own studio's roster").toBeGreaterThan(0);
    const foreign = await asUser(A.userId, (q) =>
      q(`select id from public.practitioners where studio_id = $1`, [B.studioId]),
    );
    expect(foreign.rowCount, "and must not read another studio's").toBe(0);
  });
});

describe("0174 — self-service commands DO work, for owners and non-owners alike", () => {
  it("display name: the caller's own row is updated", async () => {
    await asUser(memberUserId, (q) =>
      q(`select public.set_own_practitioner_display_name($1, $2)`, [memberPractId, "Renamed Member"]),
    );
    const r = await adminQuery(`select display_name from public.practitioners where id=$1`, [
      memberPractId,
    ]);
    expect(r.rows[0].display_name).toBe("Renamed Member");
  });

  it("display name: a NON-OWNER succeeds — before 0174 this silently affected zero rows", async () => {
    // The old `practitioners: owners update` policy was the only UPDATE policy,
    // so this actor's save matched nothing and reported success.
    await asUser(memberUserId, (q) =>
      q(`select public.set_own_practitioner_display_name($1, $2)`, [memberPractId, "Non Owner Save"]),
    );
    const r = await adminQuery(`select display_name from public.practitioners where id=$1`, [
      memberPractId,
    ]);
    expect(r.rows[0].display_name).toBe("Non Owner Save");
  });

  it("display name: blank is refused — the product contract is preserved", async () => {
    const f = await attemptAsUser(memberUserId, `select public.set_own_practitioner_display_name($1, $2)`, [
      memberPractId,
      "   ",
    ]);
    expect(f).not.toBeNull();
    expect(f!.message).toMatch(/name is required/i);
  });

  it("color: the caller's own row is updated, and junk is refused", async () => {
    await asUser(memberUserId, (q) =>
      q(`select public.set_own_practitioner_color($1, $2)`, [memberPractId, "violet"]),
    );
    const r = await adminQuery(`select color from public.practitioners where id=$1`, [memberPractId]);
    expect(r.rows[0].color).toBe("violet");
    const f = await attemptAsUser(memberUserId, `select public.set_own_practitioner_color($1, $2)`, [
      memberPractId,
      "'; drop table x; --",
    ]);
    expect(f).not.toBeNull();
    expect(f!.message).toMatch(/palette/i);
  });

  it("calendar feed: rotate stores the HASH, clear nulls it", async () => {
    await asUser(memberUserId, (q) =>
      q(`select public.rotate_own_calendar_feed_token($1, $2)`, [memberPractId, hex64()]),
    );
    let r = await adminQuery(
      `select calendar_feed_token_hash h from public.practitioners where id=$1`,
      [memberPractId],
    );
    expect(r.rows[0].h).toBe(hex64());

    await asUser(memberUserId, (q) =>
      q(`select public.clear_own_calendar_feed_token($1)`, [memberPractId]),
    );
    r = await adminQuery(`select calendar_feed_token_hash h from public.practitioners where id=$1`, [
      memberPractId,
    ]);
    expect(r.rows[0].h).toBeNull();
  });

  it("calendar feed: a RAW token can never be stored — only 64-char hex is accepted", async () => {
    // A base64url token is ~43 chars and cannot satisfy the hex check, so the
    // hash-only-at-rest guarantee cannot be undone by a caller mistake.
    const f = await attemptAsUser(memberUserId, `select public.rotate_own_calendar_feed_token($1,$2)`, [
      memberPractId,
      "Zm9vYmFyLXJhdy10b2tlbi1ub3QtYS1oYXNo",
    ]);
    expect(f).not.toBeNull();
    expect(f!.message).toMatch(/invalid calendar feed token hash/i);
  });

  it("calendar feed: an INACTIVE practitioner is refused — the existing contract, now in SQL", async () => {
    await adminQuery(`update public.practitioners set active = false where id = $1`, [memberPractId]);
    try {
      for (const sql of [
        `select public.rotate_own_calendar_feed_token($1, '${hex64()}')`,
        `select public.clear_own_calendar_feed_token($1)`,
      ]) {
        const f = await attemptAsUser(memberUserId, sql, [memberPractId]);
        expect(f).not.toBeNull();
        expect(f!.message).toMatch(/Inactive practitioners cannot manage feeds/i);
      }
      // ...and the inactive practitioner may still rename themselves, which is
      // the pre-0174 behaviour: only the FEED actions were active-gated.
      await asUser(memberUserId, (q) =>
        q(`select public.set_own_practitioner_display_name($1,$2)`, [memberPractId, "Still Me"]),
      );
    } finally {
      await adminQuery(`update public.practitioners set active = true where id = $1`, [memberPractId]);
    }
  });
});

describe("0174 — the command cannot be turned into an attack", () => {
  it("an OWNER cannot target a colleague through ANY self-service command", async () => {
    // Ownership is never consulted: the owner is refused exactly as a stranger.
    for (const sql of [
      `select public.set_own_practitioner_display_name($1, 'HIJACK')`,
      `select public.set_own_practitioner_color($1, 'rose')`,
      `select public.rotate_own_calendar_feed_token($1, '${hex64()}')`,
      `select public.clear_own_calendar_feed_token($1)`,
    ]) {
      const f = await attemptAsUser(A.userId, sql, [memberPractId]);
      expect(f, sql).not.toBeNull();
      expect(f!.message, sql).toMatch(/not your practitioner record/i);
      expect(f!.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("CROSS-STUDIO targeting is refused", async () => {
    const other = await adminQuery(
      `select id from public.practitioners where studio_id = $1 limit 1`,
      [B.studioId],
    );
    const f = await attemptAsUser(
      A.userId,
      `select public.set_own_practitioner_display_name($1, 'HIJACK')`,
      [other.rows[0].id],
    );
    expect(f).not.toBeNull();
    expect(f!.message).toMatch(/not your practitioner record/i);
  });

  it("a NONEXISTENT practitioner id is refused, and not silently ignored", async () => {
    const f = await attemptAsUser(
      A.userId,
      `select public.set_own_practitioner_display_name($1, 'x')`,
      ["00000000-0000-0000-0000-000000000000"],
    );
    expect(f).not.toBeNull();
    expect(f!.message).toMatch(/practitioner not found/i);
  });

  it("there is NO command that can write user_id, role, active or studio_id", async () => {
    // Structural, not a TypeScript omission: no function in the schema writes
    // these columns on practitioners except the governed roster path.
    const r = await adminQuery(
      `select p.proname, pg_get_functiondef(p.oid) def
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public'
          -- prokind 'f' = plain function. pg_get_functiondef() raises on
          -- aggregates/window functions, which the schema also contains.
          and p.prokind = 'f'
          and has_function_privilege('authenticated', p.oid, 'EXECUTE')
          and pg_get_functiondef(p.oid) ilike '%update public.practitioners%'`,
    );
    for (const row of r.rows) {
      const body = String(row.def);
      const setClause = body.slice(body.toLowerCase().indexOf("update public.practitioners"));
      for (const col of ["user_id", "role", "active", "studio_id", "id ="]) {
        expect(
          setClause.toLowerCase().includes(`set ${col}`),
          `${row.proname} must not set ${col}`,
        ).toBe(false);
      }
    }
    // The four self-service commands are the only authenticated-executable
    // functions that write this table at all.
    expect(r.rows.map((x) => x.proname).sort()).toEqual([
      "clear_own_calendar_feed_token",
      "rotate_own_calendar_feed_token",
      "set_own_practitioner_color",
      "set_own_practitioner_display_name",
    ]);
  });

  it("anon cannot EXECUTE any self-service command", async () => {
    for (const fn of [
      "set_own_practitioner_display_name",
      "set_own_practitioner_color",
      "rotate_own_calendar_feed_token",
      "clear_own_calendar_feed_token",
    ]) {
      const r = await adminQuery(
        `select has_function_privilege('anon', p.oid, 'EXECUTE') a,
                has_function_privilege('service_role', p.oid, 'EXECUTE') s,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') u
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname = $1`,
        [fn],
      );
      expect(r.rows[0].a, `${fn} anon`).toBe(false);
      expect(r.rows[0].s, `${fn} service_role`).toBe(false);
      expect(r.rows[0].u, `${fn} authenticated`).toBe(true);
    }
  });

  it("every self-service command is SECURITY DEFINER with a pinned empty search_path", async () => {
    const r = await adminQuery(
      `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname like '%own_practitioner%'
           or (n.nspname='public' and p.proname like '%own_calendar_feed%')`,
    );
    expect(r.rowCount).toBe(4);
    for (const row of r.rows) {
      expect(row.prosecdef, `${row.proname} definer`).toBe(true);
      expect(row.cfg, `${row.proname} search_path`).toBe('search_path=""');
    }
  });
});

describe("0174 — the policy set truthfully reflects the boundary", () => {
  it("practitioners carries exactly ONE policy: members read (SELECT)", async () => {
    const r = await adminQuery(
      `select p.polname, p.polcmd::text cmd, pg_get_expr(p.polqual, p.polrelid) qual
         from pg_policy p join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname='practitioners' order by p.polname`,
    );
    expect(r.rows.map((x) => x.polname)).toEqual(["practitioners: members read"]);
    expect(r.rows[0].cmd, "'r' is SELECT").toBe("r");
    expect(r.rows[0].qual).toBe("is_studio_member(studio_id)");
  });

  it("the dead write policies are GONE, not merely unreachable", async () => {
    const r = await adminQuery(
      `select count(*)::int n from pg_policy
        where polname in ('practitioners: owners insert','practitioners: owners update','practitioners: owners delete')`,
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("RLS is still enabled on practitioners", async () => {
    const r = await adminQuery(
      `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname='practitioners'`,
    );
    expect(r.rows[0].relrowsecurity).toBe(true);
  });
});

describe("0174 — governed roster administration is untouched", () => {
  it("set_practitioner_active_locked still exists and keeps its posture", async () => {
    const r = await adminQuery(
      `select p.prosecdef,
              has_function_privilege('service_role', p.oid, 'EXECUTE') s,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') a
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname = 'set_practitioner_active_locked'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].prosecdef).toBe(true);
    expect(r.rows[0].s, "the admin client calls this").toBe(true);
  });

  it("service_role can still administer the roster directly", async () => {
    // The governed path runs as service_role; revoking a BROWSER privilege must
    // not have touched it.
    const r = await asRole("service_role", (q) =>
      q(`update public.practitioners set display_name = 'admin-write' where id = $1 returning id`, [
        memberPractId,
      ]),
    );
    expect(r.rowCount).toBe(1);
    // asRole rolls back; the proof is that the statement was ACCEPTED.
  });

  it("clinical-note authorship survives because browser DELETE is closed", async () => {
    // The FK cascade flagged by the audit is unreachable from a browser: the
    // DELETE privilege is gone (asserted above). The FK itself is deliberately
    // NOT changed in this ticket — recorded as a follow-up.
    const r = await adminQuery(
      `select confdeltype from pg_constraint
        where conrelid = 'public.client_clinical_notes'::regclass and contype='f'
          and pg_get_constraintdef(oid) ilike '%practitioners%'`,
    );
    // Whatever the action is, it is documented rather than silently assumed.
    expect(r.rowCount).toBeGreaterThan(0);
  });
});

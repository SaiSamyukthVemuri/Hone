import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
  closePool,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// client_intake_forms — the INSERT boundary, closed by migration 0163
// ===========================================================================
//
// 0162 closed the review TRANSITION, but its guard is a BEFORE **UPDATE**
// trigger, so it never fires on INSERT. Until 0163 an authenticated studio
// member could skip the transition entirely and INSERT a row that was ALREADY
// `status = 'reviewed'`, with a NULL `submitted_at` and a forged historical
// `reviewed_at` — a clinical "reviewed" record for a form the client never
// submitted, created without ever performing the guarded update.
//
// 0163 removes the capability outright rather than constraining it, because a
// caller audit found ZERO legitimate authenticated INSERT paths: both runtime
// writers (ensureIntakeForClient, createIntakeRequestForClient) use the
// service-role admin client.
//
// SCOPE: this file proves ONE finding. It is not a treatment of L18 —
// `authenticated` retains direct row DML on the other clinical tables.
//
// Everything runs against the real migrated local database. Every row is
// synthetic and confined to the disposable local database; responses are
// non-clinical placeholders and no intake answer is ever printed.

let A: SeededStudio;
let B: SeededStudio;

beforeAll(async () => {
  A = await seedStudio("intake0163-a");
  B = await seedStudio("intake0163-b");
});
afterAll(async () => {
  await closePool();
});

// PostgreSQL raises 42501 (insufficient_privilege) when the table privilege is
// gone, and 42501 as well for an RLS row-security violation on INSERT.
const INSUFFICIENT_PRIVILEGE = "42501";

async function expectInsertDenied(
  userId: string,
  studioId: string,
  clientId: string,
  extraCols: string,
  extraVals: string,
  params: unknown[],
): Promise<void> {
  let code: string | undefined;
  try {
    await userQuery(
      userId,
      `insert into public.client_intake_forms (studio_id, client_id${extraCols})
       values ($1, $2${extraVals})`,
      [studioId, clientId, ...params],
    );
  } catch (error) {
    code = (error as { code?: string }).code;
  }
  expect(code, "the INSERT must be refused, not silently accepted").toBe(
    INSUFFICIENT_PRIVILEGE,
  );
}

async function countFor(studioId: string): Promise<number> {
  const res = await adminQuery(
    `select count(*)::int as n from public.client_intake_forms where studio_id = $1`,
    [studioId],
  );
  return res.rows[0].n as number;
}

// ---------------------------------------------------------------------------
// 1-4. Every browser-role INSERT is denied.
// ---------------------------------------------------------------------------

describe("0163 — authenticated INSERT on client_intake_forms is denied", () => {
  it("1. same-studio INSERT of a normal in_progress row is DENIED", async () => {
    const before = await countFor(A.studioId);
    await expectInsertDenied(A.userId, A.studioId, A.clientId, "", "", []);
    expect(
      await countFor(A.studioId),
      "no row may be created even for the caller's own studio",
    ).toBe(before);
  });

  it("2. same-studio INSERT of an ALREADY-reviewed row is DENIED (the residual)", async () => {
    const before = await countFor(A.studioId);
    // This is the exact forgery 0162 could not reach: reviewed on arrival,
    // submitted_at NULL, reviewed_at backdated, attributed to a real
    // practitioner of the caller's own studio.
    await expectInsertDenied(
      A.userId,
      A.studioId,
      A.clientId,
      ", status, submitted_at, reviewed_at, reviewed_by",
      ", $3, null, $4, $5",
      ["reviewed", "2020-01-01T00:00:00Z", A.practitionerId],
    );
    expect(
      await countFor(A.studioId),
      "a forged already-reviewed intake must not exist",
    ).toBe(before);
  });

  it("3. cross-studio INSERT is DENIED", async () => {
    const before = await countFor(B.studioId);
    await expectInsertDenied(A.userId, B.studioId, B.clientId, "", "", []);
    expect(await countFor(B.studioId), "no cross-tenant row may appear").toBe(before);
  });

  it("4. anonymous INSERT is DENIED", async () => {
    const before = await countFor(A.studioId);
    let code: string | undefined;
    try {
      await asRole("anon", (query) =>
        query(
          `insert into public.client_intake_forms (studio_id, client_id) values ($1, $2)`,
          [A.studioId, A.clientId],
        ),
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code, "anon must be refused").toBe(INSUFFICIENT_PRIVILEGE);
    expect(await countFor(A.studioId)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 5-7. The legitimate service-role paths still work.
// ---------------------------------------------------------------------------

describe("0163 — the service-role writers are preserved", () => {
  it("5. service-role INSERT of a normal in_progress row SUCCEEDS", async () => {
    const res = await adminQuery(
      `insert into public.client_intake_forms (studio_id, client_id)
       values ($1, $2) returning id, status, submitted_at`,
      [A.studioId, A.clientId],
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].status).toBe("in_progress");
    expect(res.rows[0].submitted_at).toBeNull();
    await adminQuery(`delete from public.client_intake_forms where id = $1`, [
      res.rows[0].id,
    ]);
  });

  it("6. the ensureIntakeForClient shape still creates a row", async () => {
    // ensureIntakeForClient inserts exactly (studio_id, client_id) and lets the
    // column defaults supply status/current_step/responses.
    const res = await adminQuery(
      `insert into public.client_intake_forms (studio_id, client_id)
       values ($1, $2) returning id, status, current_step`,
      [A.studioId, A.clientId],
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].status).toBe("in_progress");
    await adminQuery(`delete from public.client_intake_forms where id = $1`, [
      res.rows[0].id,
    ]);
  });

  it("7. the createIntakeRequestForClient reissue shape still creates a row", async () => {
    // The reissue writer additionally stamps requested_at / requested_by and
    // ALWAYS inserts a new row, leaving existing rows untouched.
    const existing = await countFor(A.studioId);
    const res = await adminQuery(
      `insert into public.client_intake_forms
         (studio_id, client_id, requested_at, requested_by)
       values ($1, $2, now(), $3)
       returning id, status, requested_by`,
      [A.studioId, A.clientId, A.practitionerId],
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].status).toBe("in_progress");
    expect(res.rows[0].requested_by).toBe(A.practitionerId);
    expect(await countFor(A.studioId)).toBe(existing + 1);
    await adminQuery(`delete from public.client_intake_forms where id = $1`, [
      res.rows[0].id,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 8-9. Nothing else regressed.
// ---------------------------------------------------------------------------

describe("0163 — SELECT, UPDATE and the 0162 guard are unchanged", () => {
  it("8a. authenticated SELECT of an own-studio intake still works", async () => {
    const seeded = await adminQuery(
      `insert into public.client_intake_forms (studio_id, client_id)
       values ($1, $2) returning id`,
      [A.studioId, A.clientId],
    );
    const id = seeded.rows[0].id as string;
    const res = await userQuery(
      A.userId,
      `select id, status from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(res.rowCount, "a member must still read their own studio's intake").toBe(1);

    // ...and cross-studio SELECT is still refused by the member_select policy.
    const cross = await userQuery(
      B.userId,
      `select id from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(cross.rowCount, "cross-studio read must still return zero rows").toBe(0);

    await adminQuery(`delete from public.client_intake_forms where id = $1`, [id]);
  });

  it("8b. authenticated UPDATE permitted by 0118/0162 still works", async () => {
    const seeded = await adminQuery(
      `insert into public.client_intake_forms (studio_id, client_id)
       values ($1, $2) returning id`,
      [A.studioId, A.clientId],
    );
    const id = seeded.rows[0].id as string;
    // An ordinary in-progress edit: still allowed for a studio member.
    const res = await userQuery(
      A.userId,
      `update public.client_intake_forms set current_step = 2 where id = $1 returning id`,
      [id],
    );
    expect(res.rowCount, "a permitted member UPDATE must still affect its row").toBe(1);
    await adminQuery(`delete from public.client_intake_forms where id = $1`, [id]);
  });

  it("9. the 0162 review-transition protection is still enforced", async () => {
    const seeded = await adminQuery(
      `insert into public.client_intake_forms (studio_id, client_id)
       values ($1, $2) returning id`,
      [A.studioId, A.clientId],
    );
    const id = seeded.rows[0].id as string;
    // in_progress -> reviewed must STILL be refused by 0162's trigger (23514),
    // not accidentally masked or replaced by 0163's privilege change.
    let code: string | undefined;
    try {
      await userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_by = $2, reviewed_at = now()
          where id = $1`,
        [id, A.practitionerId],
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code, "0162's check_violation must still fire").toBe("23514");

    const after = await adminQuery(
      `select status, reviewed_at, reviewed_by from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe("in_progress");
    expect(after.rows[0].reviewed_at).toBeNull();
    expect(after.rows[0].reviewed_by).toBeNull();

    await adminQuery(`delete from public.client_intake_forms where id = $1`, [id]);
  });
});

// ---------------------------------------------------------------------------
// 10. The boundary itself, asserted structurally.
// ---------------------------------------------------------------------------

describe("0163 — no INSERT privilege or INSERT policy remains", () => {
  it("10a. neither browser role holds the INSERT table privilege", async () => {
    const res = await adminQuery(
      `select grantee, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = 'client_intake_forms'
          and grantee in ('anon','authenticated')
          and privilege_type = 'INSERT'`,
    );
    expect(res.rows, "no INSERT grant may survive for anon/authenticated").toEqual([]);
  });

  it("10b. no INSERT-capable policy remains, and SELECT/UPDATE survive", async () => {
    const res = await adminQuery(
      `select policyname, cmd
         from pg_policies
        where schemaname = 'public' and tablename = 'client_intake_forms'
        order by cmd, policyname`,
    );
    const cmds = res.rows.map((r) => r.cmd as string);
    expect(cmds, "no INSERT policy may remain").not.toContain("INSERT");
    expect(cmds, "no FOR ALL policy may remain — it would re-grant INSERT").not.toContain(
      "ALL",
    );
    expect(cmds, "member SELECT must survive").toContain("SELECT");
    expect(cmds, "member UPDATE must survive").toContain("UPDATE");
  });

  it("10c. service_role INSERT capability is preserved", async () => {
    const res = await adminQuery(
      `select has_table_privilege('service_role','public.client_intake_forms','insert') as ok`,
    );
    expect(res.rows[0].ok, "the legitimate writers must keep working").toBe(true);
  });

  it("10d. RLS is still enabled on the table", async () => {
    const res = await adminQuery(
      `select relrowsecurity from pg_class
        where oid = 'public.client_intake_forms'::regclass`,
    );
    expect(res.rows[0].relrowsecurity).toBe(true);
  });
});

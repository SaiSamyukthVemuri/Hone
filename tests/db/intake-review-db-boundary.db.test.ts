import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import {
  adminQuery,
  closePool,
  resolveLocalDbUrl,
  seedMember,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// F-CLIN-004 — DATABASE BOUNDARY, CLOSED BY MIGRATION 0162
// ===========================================================================
//
// STATUS: APPLICATION DEPLOYED — DATABASE FIX IMPLEMENTED, NOT APPLIED.
//
// THIS FILE HAS BEEN INVERTED. Before 0162 it deliberately pinned a LIVE
// defect: an authenticated direct PostgREST/SQL update could drive
//
//     status: in_progress -> reviewed,  submitted_at still NULL   => UPDATE 1
//
// because every review guard added by 0118 sits inside
// `if old.status in ('submitted','reviewed')`, which an in_progress OLD row
// never enters. Those "KNOWN OPEN" cases now REQUIRE REJECTION.
//
// Everything here runs against the real migrated local database as the
// `authenticated` role with a real studio-member JWT, so it exercises the same
// path a crafted PostgREST request would. Every row is synthetic and confined
// to the disposable local database; responses are non-clinical placeholders and
// no intake answer or practitioner note is ever printed.

let A: SeededStudio;
let B: SeededStudio;

beforeAll(async () => {
  A = await seedStudio("intake0162-a");
  B = await seedStudio("intake0162-b");
});
afterAll(async () => {
  await closePool();
});

// The single SQLSTATE the trigger raises for every clinical-integrity refusal.
const CHECK_VIOLATION = "23514";

type IntakeSnapshot = {
  status: string;
  submitted_at: Date | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  practitioner_notes: string | null;
  responses: Record<string, unknown>;
};

async function readRow(id: string): Promise<IntakeSnapshot> {
  const res = await adminQuery(
    `select status, submitted_at, reviewed_at, reviewed_by, practitioner_notes, responses
       from public.client_intake_forms where id = $1`,
    [id],
  );
  return res.rows[0] as IntakeSnapshot;
}

// Seed an intake directly. INSERT is unaffected by the BEFORE UPDATE trigger,
// so any lifecycle state can be created as a fixture.
async function seedIntake(
  studio: SeededStudio,
  over: {
    status?: string;
    submitted_at?: string | null;
    reviewed_at?: string | null;
    reviewed_by?: string | null;
    deleted_at?: string | null;
    clientId?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.client_intake_forms
       (id, studio_id, client_id, status, responses,
        submitted_at, reviewed_at, reviewed_by, deleted_at)
     values ($1, $2, $3, $4, '{"q":"placeholder"}'::jsonb, $5, $6, $7, $8)`,
    [
      id,
      studio.studioId,
      over.clientId ?? studio.clientId,
      over.status ?? "submitted",
      over.submitted_at === undefined ? new Date().toISOString() : over.submitted_at,
      over.reviewed_at ?? null,
      over.reviewed_by ?? null,
      over.deleted_at ?? null,
    ],
  );
  return id;
}

// Review a submitted row the legitimate way, for fixtures.
async function reviewIt(studio: SeededStudio, id: string): Promise<void> {
  await userQuery(
    studio.userId,
    `update public.client_intake_forms
        set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
      where id = $1`,
    [id, studio.practitionerId],
  );
}

// The exact statement shape the DEPLOYED application issues (PR #497).
const APP_REVIEW_SQL = `
  update public.client_intake_forms
     set status = 'reviewed',
         reviewed_at = $2,
         reviewed_by = $3,
         practitioner_notes = $4
   where id = $1
     and studio_id = $5
     and client_id = $6
     and deleted_at is null
     and status = 'submitted'
     and submitted_at is not null
  returning id, client_id`;

// ===========================================================================
// 1-3. THE INVERTED CASES — these used to succeed. They must now be refused.
// ===========================================================================

describe("F-CLIN-004 / INVERTED: the incoming review transition is now guarded", () => {
  it("1. in_progress -> reviewed is REJECTED; submitted_at and review metadata stay NULL", async () => {
    const id = await seedIntake(A, { status: "in_progress", submitted_at: null });

    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, A.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const row = await readRow(id);
    expect(row.status).toBe("in_progress");
    expect(row.submitted_at).toBeNull();
    expect(row.reviewed_at).toBeNull();
    expect(row.reviewed_by).toBeNull();
  });

  it("2. in_progress carrying a FORGED submitted_at -> reviewed is REJECTED", async () => {
    // A forged submission timestamp must not buy a review: the guard keys on
    // OLD.status, which is still in_progress.
    const id = await seedIntake(A, {
      status: "in_progress",
      submitted_at: new Date().toISOString(),
    });

    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, A.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const row = await readRow(id);
    expect(row.status).toBe("in_progress");
    expect(row.reviewed_by).toBeNull();
  });

  it("3. submitted with a NULL submitted_at -> reviewed is REJECTED", async () => {
    const id = await seedIntake(A, { status: "submitted", submitted_at: null });

    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, A.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const row = await readRow(id);
    expect(row.status).toBe("submitted");
    expect(row.reviewed_at).toBeNull();
    expect(row.reviewed_by).toBeNull();
  });
});

// ===========================================================================
// 4-5. The legitimate path still works.
// ===========================================================================

describe("F-CLIN-004 / the legitimate review still succeeds", () => {
  it("4. a valid submitted -> reviewed succeeds exactly once", async () => {
    const id = await seedIntake(A);

    const first = await userQuery(
      A.userId,
      `update public.client_intake_forms
          set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
        where id = $1 and status = 'submitted'
        returning id`,
      [id, A.practitionerId],
    );
    expect(first.rowCount).toBe(1);
    expect((await readRow(id)).status).toBe("reviewed");

    // A second identical statement matches zero rows on the status predicate —
    // it does not raise, and it rewrites nothing.
    const stamped = await readRow(id);
    const second = await userQuery(
      A.userId,
      `update public.client_intake_forms
          set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
        where id = $1 and status = 'submitted'
        returning id`,
      [id, A.practitionerId],
    );
    expect(second.rowCount).toBe(0);
    const after = await readRow(id);
    expect(after.reviewed_at).toEqual(stamped.reviewed_at);
    expect(after.reviewed_by).toBe(stamped.reviewed_by);
  });

  it("5. a NON-OWNER active practitioner in the same studio may review", async () => {
    const member = await seedMember(A, "reviewer");
    const id = await seedIntake(A);

    const res = await userQuery(
      member.userId,
      `update public.client_intake_forms
          set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
        where id = $1
        returning id`,
      [id, member.practitionerId],
    );
    expect(res.rowCount).toBe(1);
    expect((await readRow(id)).reviewed_by).toBe(member.practitionerId);
  });
});

// ===========================================================================
// 6-9. Actor and studio validation.
// ===========================================================================

describe("F-CLIN-004 / reviewer must be the caller's own active same-studio practitioner", () => {
  it("6. reviewed_by from ANOTHER studio is REJECTED", async () => {
    const id = await seedIntake(A);
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, B.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await readRow(id)).status).toBe("submitted");
  });

  it("6b. one user holding practitioner rows in TWO studios cannot review studio A's intake with studio B's row", async () => {
    // Exactly what 0118's `user_id = auth.uid() and active` check permitted:
    // same user, wrong studio's practitioner row. public.practitioners is
    // unique on (studio_id, user_id), so this shape is legal data.
    const crossId = randomUUID();
    await adminQuery(
      `insert into public.practitioners
         (id, studio_id, user_id, display_name, email, role, active)
       values ($1, $2, $3, 'Cross Studio', $4, 'practitioner', true)`,
      [crossId, B.studioId, A.userId, `cross-${crossId.slice(0, 8)}@harness.local`],
    );

    const id = await seedIntake(A);
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, crossId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await readRow(id)).reviewed_by).toBeNull();
  });

  it("7. reviewed_by from the SAME studio but a DIFFERENT user is REJECTED", async () => {
    const other = await seedMember(A, "otheruser");
    const id = await seedIntake(A);
    // Caller is A.userId; reviewed_by names another user's practitioner row.
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, other.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await readRow(id)).reviewed_by).toBeNull();
  });

  it("8. an INACTIVE practitioner cannot review — RLS removes the row before the trigger is reached", async () => {
    // public.is_studio_member() itself requires `active = true`, so a
    // deactivated member cannot even SEE the intake: the UPDATE matches zero
    // rows and the trigger never fires. That is a STRONGER outcome than a
    // trigger refusal, and it is the mechanism this case must assert.
    const inactive = await seedMember(A, "inactive");
    await adminQuery(
      `update public.practitioners set active = false where id = $1`,
      [inactive.practitionerId],
    );
    const id = await seedIntake(A);

    const res = await userQuery(
      inactive.userId,
      `update public.client_intake_forms
          set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
        where id = $1
        returning id`,
      [id, inactive.practitionerId],
    );
    expect(res.rowCount).toBe(0);

    const row = await readRow(id);
    expect(row.status).toBe("submitted");
    expect(row.reviewed_at).toBeNull();
    expect(row.reviewed_by).toBeNull();
  });

  // HONEST SCOPE NOTE (found by negative control 5). This case is REJECTED, but
  // by the `p.user_id = auth.uid()` predicate, NOT by `p.active = true`: the
  // retired practitioner belongs to a different user than the caller.
  //
  // The `p.active = true` predicate inside the reviewer lookup is genuine
  // defence-in-depth that CANNOT be isolated by any test, and this is
  // structural, not an oversight:
  //   * public.practitioners is UNIQUE (studio_id, user_id), so a caller owns at
  //     most ONE practitioner row per studio; and
  //   * public.is_studio_member() itself requires `active = true`.
  // So a caller's own row in the intake's studio is either ACTIVE (the predicate
  // is trivially satisfied) or INACTIVE (RLS removes the row before the trigger
  // runs — proven by case 8 above). There is no reachable state in between.
  // The predicate is retained so the guard does not silently weaken if
  // is_studio_member() is ever changed to stop requiring `active`.
  it("8b. an ACTIVE caller naming ANOTHER user's deactivated practitioner is REJECTED", async () => {
    const retired = await seedMember(A, "retired");
    await adminQuery(
      `update public.practitioners set active = false where id = $1`,
      [retired.practitionerId],
    );
    const id = await seedIntake(A);

    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, retired.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const row = await readRow(id);
    expect(row.status).toBe("submitted");
    expect(row.reviewed_by).toBeNull();
  });

  it("9. a NULL reviewed_by is REJECTED", async () => {
    const id = await seedIntake(A);
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = null
          where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await readRow(id)).status).toBe("submitted");
  });

  it("9b. an ARBITRARY UUID reviewed_by is REJECTED", async () => {
    const id = await seedIntake(A);
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await readRow(id)).reviewed_by).toBeNull();
  });

  it("the refusal message leaks no intake, client, practitioner or studio identity", async () => {
    const id = await seedIntake(A);
    let message = "";
    try {
      await userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, B.practitionerId],
      );
    } catch (e) {
      message = String((e as { message?: string }).message ?? e);
    }
    expect(message).toMatch(/reviewed_by must be the reviewing practitioner/);
    for (const secret of [
      id,
      A.studioId,
      A.clientId,
      A.practitionerId,
      A.userId,
      B.practitionerId,
      B.studioId,
    ]) {
      expect(message).not.toContain(secret);
    }
  });
});

// ===========================================================================
// 10-12. reviewed_at is database-authoritative.
// ===========================================================================

describe("F-CLIN-004 / the database is authoritative for reviewed_at", () => {
  it("10. a NULL reviewed_at is STAMPED by the database, not rejected", async () => {
    const id = await seedIntake(A);
    const before = new Date();
    const res = await userQuery(
      A.userId,
      `update public.client_intake_forms
          set status = 'reviewed', reviewed_by = $2
        where id = $1
        returning id`,
      [id, A.practitionerId],
    );
    const after = new Date();
    expect(res.rowCount).toBe(1);

    const row = await readRow(id);
    expect(row.reviewed_at).not.toBeNull();
    const stamped = (row.reviewed_at as Date).getTime();
    // Margin for transaction_timestamp() vs the JS clock.
    expect(stamped).toBeGreaterThanOrEqual(before.getTime() - 5_000);
    expect(stamped).toBeLessThanOrEqual(after.getTime() + 5_000);
  });

  it("11. a FORGED HISTORICAL reviewed_at is overwritten with server time", async () => {
    const id = await seedIntake(A);
    const forged = "2001-01-01T00:00:00.000Z";
    await userQuery(
      A.userId,
      `update public.client_intake_forms
          set status = 'reviewed', reviewed_at = $3, reviewed_by = $2
        where id = $1`,
      [id, A.practitionerId, forged],
    );

    const row = await readRow(id);
    expect(row.reviewed_at).not.toBeNull();
    const stamped = (row.reviewed_at as Date).getTime();
    expect(stamped).not.toBe(new Date(forged).getTime());
    expect(stamped).toBeGreaterThan(new Date("2020-01-01T00:00:00Z").getTime());
  });

  it("12. a FORGED FUTURE reviewed_at is overwritten with server time", async () => {
    const id = await seedIntake(A);
    const forged = "2099-12-31T23:59:59.000Z";
    await userQuery(
      A.userId,
      `update public.client_intake_forms
          set status = 'reviewed', reviewed_at = $3, reviewed_by = $2
        where id = $1`,
      [id, A.practitionerId, forged],
    );

    const row = await readRow(id);
    const stamped = (row.reviewed_at as Date).getTime();
    expect(stamped).not.toBe(new Date(forged).getTime());
    expect(stamped).toBeLessThan(new Date("2090-01-01T00:00:00Z").getTime());
  });

  it("12b. the stamped reviewed_at is never earlier than the submission it reviews", async () => {
    const submittedAt = new Date(Date.now() - 60_000).toISOString();
    const id = await seedIntake(A, { submitted_at: submittedAt });
    await userQuery(
      A.userId,
      `update public.client_intake_forms
          set status = 'reviewed', reviewed_at = '2001-01-01', reviewed_by = $2
        where id = $1`,
      [id, A.practitionerId],
    );
    const row = await readRow(id);
    expect((row.reviewed_at as Date).getTime()).toBeGreaterThanOrEqual(
      new Date(submittedAt).getTime(),
    );
  });
});

// ===========================================================================
// 13-18. Terminal immutability, including the two 0162 hardenings.
// ===========================================================================

describe("F-CLIN-004 / terminal immutability preserved and hardened", () => {
  it("13. a second review may not rewrite attribution", async () => {
    const id = await seedIntake(A);
    await reviewIt(A, id);
    const stamped = await readRow(id);
    const other = await seedMember(A, "rewriter");

    await expect(
      userQuery(
        other.userId,
        `update public.client_intake_forms
            set reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, other.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const after = await readRow(id);
    expect(after.reviewed_at).toEqual(stamped.reviewed_at);
    expect(after.reviewed_by).toBe(stamped.reviewed_by);
  });

  it("14. reviewed -> in_progress is REJECTED", async () => {
    const id = await seedIntake(A);
    await reviewIt(A, id);
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set status = 'in_progress' where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await readRow(id)).status).toBe("reviewed");
  });

  it("14b. 0162 HARDENING — reviewed -> submitted is REJECTED (closes two-step attribution laundering)", async () => {
    const id = await seedIntake(A);
    await reviewIt(A, id);
    const stamped = await readRow(id);

    // Step one of the laundering attack: drop back to 'submitted' while keeping
    // the original attribution — which 0118 alone permitted, because its
    // attribution check only fires when the VALUES change.
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set status = 'submitted' where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const after = await readRow(id);
    expect(after.status).toBe("reviewed");
    expect(after.reviewed_by).toBe(stamped.reviewed_by);
    expect(after.reviewed_at).toEqual(stamped.reviewed_at);
  });

  // FOUND BY ADVERSARIAL REVIEW, then reproduced end-to-end as `authenticated`
  // on a CI-parity database. Without hardening (9) the entire section-1 contract
  // was bypassable in TWO statements: forge the submission, then perform a
  // "legitimate" review against the evidence you just manufactured.
  it("14c. 0162 HARDENING — an authenticated member cannot forge the CLIENT'S SUBMISSION", async () => {
    const id = await seedIntake(A, { status: "in_progress", submitted_at: null });

    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'submitted', submitted_at = now()
          where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const row = await readRow(id);
    expect(row.status).toBe("in_progress");
    expect(row.submitted_at).toBeNull();
  });

  it("14d. the two-step in_progress -> submitted -> reviewed bypass is CLOSED end to end", async () => {
    const id = await seedIntake(A, { status: "in_progress", submitted_at: null });

    // Step 1 must fail...
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'submitted', submitted_at = now()
          where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    // ...so step 2 has nothing to stand on, and is refused on its own terms too.
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_by = $2
          where id = $1`,
        [id, A.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const row = await readRow(id);
    expect(row.status).toBe("in_progress");
    expect(row.submitted_at).toBeNull();
    expect(row.reviewed_at).toBeNull();
    expect(row.reviewed_by).toBeNull();
  });

  it("15. submitted -> in_progress is REJECTED", async () => {
    const id = await seedIntake(A);
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set status = 'in_progress' where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await readRow(id)).status).toBe("submitted");
  });

  it("15b. 0162 HARDENING — review metadata cannot be attached to a non-reviewed row", async () => {
    const draft = await seedIntake(A, { status: "in_progress", submitted_at: null });
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [draft, A.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    const row = await readRow(draft);
    expect(row.reviewed_at).toBeNull();
    expect(row.reviewed_by).toBeNull();

    const submitted = await seedIntake(A);
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set reviewed_by = $2 where id = $1`,
        [submitted, A.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await readRow(submitted)).reviewed_by).toBeNull();
  });

  it("16. mutating a SUBMITTED row's answers is REJECTED", async () => {
    const id = await seedIntake(A);
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set responses = '{"q":"tampered"}'::jsonb where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await readRow(id)).responses).toEqual({ q: "placeholder" });
  });

  it("17. mutating a REVIEWED row's answers is REJECTED", async () => {
    const id = await seedIntake(A);
    await reviewIt(A, id);
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set responses = '{"q":"tampered"}'::jsonb where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await readRow(id)).responses).toEqual({ q: "placeholder" });
  });

  it("18. mutating submitted_at after submission is REJECTED", async () => {
    const id = await seedIntake(A);
    const original = (await readRow(id)).submitted_at;
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set submitted_at = now() - interval '5 days' where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await readRow(id)).submitted_at).toEqual(original);
  });

  it("18b. the reviewing statement may not also rewrite submitted_at", async () => {
    const id = await seedIntake(A);
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = $2,
                submitted_at = now() - interval '30 days'
          where id = $1`,
        [id, A.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await readRow(id)).status).toBe("submitted");
  });
});

// ===========================================================================
// 19-21. Legitimate editing still works.
// ===========================================================================

describe("F-CLIN-004 / legitimate edits are unaffected", () => {
  it("19. practitioner_notes may be edited on a SUBMITTED row", async () => {
    const id = await seedIntake(A);
    const res = await userQuery(
      A.userId,
      `update public.client_intake_forms set practitioner_notes = 'note-s' where id = $1 returning id`,
      [id],
    );
    expect(res.rowCount).toBe(1);
    expect((await readRow(id)).practitioner_notes).toBe("note-s");
  });

  it("20. practitioner_notes may be edited on a REVIEWED row, without disturbing attribution", async () => {
    const id = await seedIntake(A);
    await reviewIt(A, id);
    const stamped = await readRow(id);
    const res = await userQuery(
      A.userId,
      `update public.client_intake_forms set practitioner_notes = 'note-r' where id = $1 returning id`,
      [id],
    );
    expect(res.rowCount).toBe(1);
    const after = await readRow(id);
    expect(after.practitioner_notes).toBe("note-r");
    expect(after.reviewed_at).toEqual(stamped.reviewed_at);
    expect(after.reviewed_by).toBe(stamped.reviewed_by);
  });

  it("21. an IN_PROGRESS row's responses may still be saved", async () => {
    const id = await seedIntake(A, { status: "in_progress", submitted_at: null });
    const res = await userQuery(
      A.userId,
      `update public.client_intake_forms
          set responses = '{"q":"draft-progress"}'::jsonb, current_step = 2
        where id = $1 returning id`,
      [id],
    );
    expect(res.rowCount).toBe(1);
    expect((await readRow(id)).responses).toEqual({ q: "draft-progress" });
  });

  it("21b. the SERVICE-ROLE client submission path (in_progress -> submitted) still works", async () => {
    // This is what app/intake/[token]/actions.ts does with createAdminClient().
    const id = await seedIntake(A, { status: "in_progress", submitted_at: null });
    const res = await adminQuery(
      `update public.client_intake_forms
          set responses = '{"q":"final"}'::jsonb, status = 'submitted', submitted_at = now()
        where id = $1 and status = 'in_progress' returning id`,
      [id],
    );
    expect(res.rowCount).toBe(1);
    const row = await readRow(id);
    expect(row.status).toBe("submitted");
    expect(row.submitted_at).not.toBeNull();
  });
});

// ===========================================================================
// 22-24. Cross-tenant, anonymous, and the explicit service-role decision.
// ===========================================================================

describe("F-CLIN-004 / tenancy and caller class", () => {
  it("22. a wrong-studio authenticated member cannot review another studio's intake", async () => {
    const id = await seedIntake(A);
    // B's owner tries to review A's intake, naming their own practitioner.
    const res = await userQuery(
      B.userId,
      `update public.client_intake_forms
          set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
        where id = $1 returning id`,
      [id, B.practitionerId],
    ).catch((e: { code?: string }) => e);

    // Assert the ACTUAL mechanism, not an either/or. With the shipped policies
    // `is_studio_member(studio_id)` is false for B's owner against A's intake,
    // so RLS removes the row and the statement matches ZERO rows without the
    // trigger ever firing. An either/or accept here would have been blind to
    // exactly the cross-tenant RLS regression this case exists to catch.
    expect(
      typeof (res as { rowCount?: number }).rowCount,
      "cross-studio update must return a result (RLS filters), not raise",
    ).toBe("number");
    expect((res as { rowCount: number }).rowCount).toBe(0);
    const row = await readRow(id);
    expect(row.status).toBe("submitted");
    expect(row.reviewed_by).toBeNull();
  });

  it("23. an ANONYMOUS direct update is refused", async () => {
    const id = await seedIntake(A);
    // Record the OUTCOME precisely instead of collapsing every possible failure
    // — including the fixture itself breaking — into one `refused = true`.
    const client = new PgClient({ connectionString: resolveLocalDbUrl() });
    await client.connect();
    let outcome: { kind: "rows"; n: number } | { kind: "error"; code?: string };
    try {
      await client.query("begin");
      await client.query("set local role anon");
      try {
        const upd = await client.query(
          `update public.client_intake_forms
              set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
            where id = $1`,
          [id, A.practitionerId],
        );
        outcome = { kind: "rows", n: upd.rowCount ?? 0 };
      } catch (e) {
        outcome = { kind: "error", code: (e as { code?: string }).code };
      }
      await client.query("rollback").catch(() => undefined);
    } finally {
      await client.end();
    }

    // anon holds no UPDATE grant / no policy, so it is refused outright
    // (42501 insufficient_privilege) or matches zero rows. Either is a genuine
    // refusal, but the test now says WHICH — a fixture failure (e.g. a bad
    // connection string) would surface as a different code and fail here.
    if (outcome.kind === "error") {
      expect(outcome.code, "anon must be refused by privilege/RLS, not a harness error")
        .toMatch(/^(42501|23514)$/);
    } else {
      expect(outcome.n).toBe(0);
    }

    const row = await readRow(id);
    expect(row.status).toBe("submitted");
    expect(row.reviewed_by).toBeNull();
  });

  it("24. SERVICE-ROLE review transitions are REJECTED (explicit 0162 decision)", async () => {
    // 0118 exempted every auth.uid() IS NULL write. 0162 deliberately does NOT
    // preserve that exemption for the incoming review transition: no runtime
    // service-role path marks an intake reviewed — `status: "reviewed"` appears
    // in exactly one place in the repository, on the authenticated path — so
    // this fails closed.
    const id = await seedIntake(A);
    await expect(
      adminQuery(
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, A.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const row = await readRow(id);
    expect(row.status).toBe("submitted");
    expect(row.reviewed_at).toBeNull();
    expect(row.reviewed_by).toBeNull();
  });

  it("24b. service role retains its other trusted intake writes", async () => {
    // Link metadata + notes on a submitted row, which 0118 intentionally left
    // open to trusted admin paths, must still work.
    const id = await seedIntake(A);
    const res = await adminQuery(
      `update public.client_intake_forms
          set intake_link_send_count = intake_link_send_count + 1,
              intake_link_last_sent_at = now(),
              practitioner_notes = 'admin note'
        where id = $1 returning id`,
      [id],
    );
    expect(res.rowCount).toBe(1);
    expect((await readRow(id)).practitioner_notes).toBe("admin note");
  });
});

// ===========================================================================
// 25. The DEPLOYED application statement still succeeds against 0162.
// ===========================================================================

describe("F-CLIN-004 / deployed PR #497 application compatibility", () => {
  it("25. the exact statement markIntakeReviewedAction issues succeeds", async () => {
    const id = await seedIntake(A);
    const appSentReviewedAt = new Date(Date.now() - 3_600_000).toISOString();

    const res = await userQuery(A.userId, APP_REVIEW_SQL, [
      id,
      appSentReviewedAt,
      A.practitionerId,
      "clinical note",
      A.studioId,
      A.clientId,
    ]);

    // The application proves exactly one row transitioned.
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].client_id).toBe(A.clientId);

    const row = await readRow(id);
    expect(row.status).toBe("reviewed");
    expect(row.reviewed_by).toBe(A.practitionerId);
    expect(row.practitioner_notes).toBe("clinical note");
    // The DB overrode the application's own timestamp — the documented
    // behaviour change: the database is now authoritative for reviewed_at.
    expect((row.reviewed_at as Date).getTime()).not.toBe(
      new Date(appSentReviewedAt).getTime(),
    );
    expect((row.reviewed_at as Date).getTime()).toBeGreaterThan(
      new Date(appSentReviewedAt).getTime(),
    );
  });

  it("25b. the application statement is still refused for an in_progress intake", async () => {
    const id = await seedIntake(A, { status: "in_progress", submitted_at: null });
    // The app's own predicates match zero rows; the trigger never even fires.
    const res = await userQuery(A.userId, APP_REVIEW_SQL, [
      id,
      new Date().toISOString(),
      A.practitionerId,
      null,
      A.studioId,
      A.clientId,
    ]);
    expect(res.rowCount).toBe(0);
    const row = await readRow(id);
    expect(row.status).toBe("in_progress");
    expect(row.reviewed_by).toBeNull();
  });

  it("25c. the application's notes-only statement still succeeds in every status", async () => {
    for (const status of ["in_progress", "submitted"] as const) {
      const id = await seedIntake(A, {
        status,
        submitted_at: status === "in_progress" ? null : new Date().toISOString(),
      });
      const res = await userQuery(
        A.userId,
        `update public.client_intake_forms
            set practitioner_notes = $2
          where id = $1 and studio_id = $3 and client_id = $4 and deleted_at is null
          returning id, client_id`,
        [id, `note-${status}`, A.studioId, A.clientId],
      );
      expect(res.rowCount, status).toBe(1);
    }

    const reviewed = await seedIntake(A);
    await reviewIt(A, reviewed);
    const res = await userQuery(
      A.userId,
      `update public.client_intake_forms
          set practitioner_notes = $2
        where id = $1 and studio_id = $3 and client_id = $4 and deleted_at is null
        returning id, client_id`,
      [reviewed, "note-reviewed", A.studioId, A.clientId],
    );
    expect(res.rowCount).toBe(1);
  });
});

// ===========================================================================
// RESIDUAL, STILL OPEN AFTER 0162 — the INSERT path.
// ===========================================================================
//
// 0162's guard is a BEFORE **UPDATE** trigger, so it never fires on INSERT. An
// authenticated studio member can therefore create a brand-new intake row that
// is ALREADY `reviewed`, with a NULL submitted_at and a forged historical
// reviewed_at, because `authenticated` holds INSERT on the table and the INSERT
// policy's WITH CHECK is only `is_studio_member(studio_id)`.
//
// This is NOT closed by 0162 and is deliberately out of its scope: it is the
// broader "authenticated holds direct row DML on clinical tables" limitation
// already tracked as **L18** in docs/production/known-limitations.md, and
// closing it means revoking INSERT (or adding an INSERT guard), which is a
// different blast radius needing its own authorization.
//
// This case PINS the residual so it cannot be forgotten and so the PR cannot
// claim more than it delivers. When it is closed, invert this test.
describe("F-CLIN-004 / RESIDUAL: the INSERT path is NOT closed by 0162", () => {
  it("KNOWN OPEN — an authenticated member can INSERT a row already 'reviewed' with a forged reviewed_at", async () => {
    const forgedId = randomUUID();
    const forgedAt = "2001-01-01T00:00:00.000Z";

    const res = await userQuery(
      A.userId,
      `insert into public.client_intake_forms
         (id, studio_id, client_id, status, responses, submitted_at, reviewed_at, reviewed_by)
       values ($1, $2, $3, 'reviewed', '{"q":"placeholder"}'::jsonb, null, $4, $5)
       returning id`,
      [forgedId, A.studioId, A.clientId, forgedAt, A.practitionerId],
    );

    // THIS IS THE RESIDUAL. The insert succeeds.
    expect(res.rowCount).toBe(1);
    const row = await readRow(forgedId);
    expect(row.status).toBe("reviewed");
    expect(row.submitted_at).toBeNull();
    expect((row.reviewed_at as Date).getTime()).toBe(new Date(forgedAt).getTime());

    // Clean up so no other case sees this synthetic row.
    await adminQuery(`delete from public.client_intake_forms where id = $1`, [forgedId]);
  });

  it("0162 still binds the row once it exists: the forged row cannot then be UPDATED into a new review", async () => {
    // Even though the row was born 'reviewed', the UPDATE guard applies from
    // then on — attribution cannot be rewritten and it cannot regress.
    const forgedId = randomUUID();
    await userQuery(
      A.userId,
      `insert into public.client_intake_forms
         (id, studio_id, client_id, status, responses, submitted_at, reviewed_at, reviewed_by)
       values ($1, $2, $3, 'reviewed', '{"q":"placeholder"}'::jsonb, null, now(), $4)`,
      [forgedId, A.studioId, A.clientId, A.practitionerId],
    );

    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set status = 'submitted' where id = $1`,
        [forgedId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const other = await seedMember(A, "forgedrewriter");
    await expect(
      userQuery(
        other.userId,
        `update public.client_intake_forms set reviewed_by = $2, reviewed_at = now() where id = $1`,
        [forgedId, other.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    await adminQuery(`delete from public.client_intake_forms where id = $1`, [forgedId]);
  });
});

// ===========================================================================
// CONCURRENCY — a real two-connection race, not mocked action calls.
// ===========================================================================

describe("F-CLIN-004 / concurrency: exactly one transition", () => {
  it("two genuinely concurrent submitted -> reviewed updates yield ONE transition", async () => {
    const id = await seedIntake(A);
    const racer = await seedMember(A, "racer");

    const url = resolveLocalDbUrl();
    const c1 = new PgClient({ connectionString: url });
    const c2 = new PgClient({ connectionString: url });
    await c1.connect();
    await c2.connect();

    async function begin(c: PgClient, userId: string) {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
    }

    const reviewSql = `
      update public.client_intake_forms
         set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
       where id = $1 and status = 'submitted'
      returning id`;

    let rows1 = -1;
    let outcome2: { rows: number; err?: string };
    try {
      await begin(c1, A.userId);
      await begin(c2, racer.userId);

      // c1 takes the row lock first and holds it in its open transaction.
      const r1 = await c1.query(reviewSql, [id, A.practitionerId]);
      rows1 = r1.rowCount ?? 0;

      // c2's identical statement now BLOCKS on c1's uncommitted row lock.
      const p2 = c2
        .query(reviewSql, [id, racer.practitionerId])
        .then((r) => ({ rows: r.rowCount ?? 0 }))
        .catch((e: { message?: string }) => ({
          rows: 0,
          err: String(e.message ?? e),
        }));

      // Commit c1; c2 then re-evaluates its WHERE against the committed row
      // (EvalPlanQual), sees status is no longer 'submitted', and matches none.
      await c1.query("commit");
      outcome2 = await p2;
      await c2.query("commit").catch(() => undefined);
    } finally {
      await c1.end().catch(() => undefined);
      await c2.end().catch(() => undefined);
    }

    // Exactly one transition; the loser wrote nothing.
    expect(rows1).toBe(1);
    expect(outcome2.rows).toBe(0);

    const row = await readRow(id);
    expect(row.status).toBe("reviewed");
    expect(row.reviewed_by).toBe(A.practitionerId);
    expect(row.reviewed_by).not.toBe(racer.practitionerId);
    expect(row.reviewed_at).not.toBeNull();
  });

  it("the loser cannot rewrite attribution afterwards", async () => {
    const id = await seedIntake(A);
    const loser = await seedMember(A, "loser");
    await reviewIt(A, id);
    const stamped = await readRow(id);

    await expect(
      userQuery(
        loser.userId,
        `update public.client_intake_forms
            set reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, loser.practitionerId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const after = await readRow(id);
    expect(after.reviewed_at).toEqual(stamped.reviewed_at);
    expect(after.reviewed_by).toBe(stamped.reviewed_by);
  });
});

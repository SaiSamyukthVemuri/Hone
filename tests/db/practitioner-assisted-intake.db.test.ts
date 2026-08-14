import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// Practitioner-assisted intake: the DATABASE half, on the REAL migrated
// local database.
//
// The application design rests on four claims about what the database allows
// an authenticated studio member to do. Source review is not proof of any of
// them, so each is exercised here as the `authenticated` role with a real JWT
// claim:
//
//   1. a member CAN write `responses` (including the reserved provenance key)
//      on an in_progress intake        -> the assisted editor is possible at all
//   2. a member CANNOT transition in_progress -> submitted
//                                      -> the client-owned submission boundary
//                                         is enforced by the DB, not by our UI
//   3. a member CANNOT rewrite `responses` once the intake is terminal
//                                      -> assisted answers and provenance are
//                                         frozen with the rest of the record
//   4. a member of ANOTHER studio can do none of it
//
// Claim 2 is the one that makes createClient() (not createAdminClient())
// load-bearing in app/(app)/clients/[id]/intake/actions.ts: the service role
// is exempt from this trigger, so an assisted action written with the admin
// client would silently regain the ability to submit for the client.
//
// Only non-clinical placeholder answers are used.

let A: SeededStudio;
let B: SeededStudio;

const PROV_KEY = "practitioner_assisted_entry";

function provenance(practitionerId: string, name: string) {
  return {
    mode: "practitioner_assisted",
    version: "v1",
    started_at: "2026-08-07T10:00:00.000Z",
    started_by: { practitioner_id: practitionerId, display_name: name },
    last_updated_at: "2026-08-07T10:05:00.000Z",
    last_updated_by: { practitioner_id: practitionerId, display_name: name },
  };
}

async function seedIntake(
  studio: SeededStudio,
  state: "in_progress" | "submitted" | "reviewed",
  responses: Record<string, unknown> = { q: "draft" },
): Promise<string> {
  const id = randomUUID();
  if (state === "in_progress") {
    await adminQuery(
      `insert into public.client_intake_forms (id, studio_id, client_id, status, responses)
       values ($1, $2, $3, 'in_progress', $4::jsonb)`,
      [id, studio.studioId, studio.clientId, JSON.stringify(responses)],
    );
  } else if (state === "submitted") {
    await adminQuery(
      `insert into public.client_intake_forms (id, studio_id, client_id, status, responses, submitted_at)
       values ($1, $2, $3, 'submitted', $4::jsonb, now())`,
      [id, studio.studioId, studio.clientId, JSON.stringify(responses)],
    );
  } else {
    await adminQuery(
      `insert into public.client_intake_forms (id, studio_id, client_id, status, responses, submitted_at, reviewed_at, reviewed_by)
       values ($1, $2, $3, 'reviewed', $4::jsonb, now(), now(), $5)`,
      [
        id,
        studio.studioId,
        studio.clientId,
        JSON.stringify(responses),
        studio.practitionerId,
      ],
    );
  }
  return id;
}

async function storedResponses(id: string): Promise<Record<string, unknown>> {
  const r = await adminQuery(
    `select responses from public.client_intake_forms where id = $1`,
    [id],
  );
  return r.rows[0].responses as Record<string, unknown>;
}

beforeAll(async () => {
  A = await seedStudio("assisted-a");
  B = await seedStudio("assisted-b");
});
afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
describe("1. assisted entry is possible: a member may write a draft's responses", () => {
  it("writes questionnaire answers AND the reserved provenance key", async () => {
    const id = await seedIntake(A, "in_progress");
    const merged = {
      q: "draft",
      legal_name: "Dana Reyes",
      [PROV_KEY]: provenance(A.practitionerId, "Chloe Baca"),
    };
    const res = await userQuery(
      A.userId,
      `update public.client_intake_forms
          set responses = $2::jsonb, current_step = 2
        where id = $1 and status = 'in_progress' and deleted_at is null
        returning id`,
      [id, JSON.stringify(merged)],
    );
    expect(res.rowCount).toBe(1);

    const stored = await storedResponses(id);
    expect(stored.legal_name).toBe("Dana Reyes");
    expect(stored[PROV_KEY]).toMatchObject({
      mode: "practitioner_assisted",
      started_by: { practitioner_id: A.practitionerId },
    });
  });

  it("the updated_at concurrency token really moves on every write", async () => {
    // The assisted action's optimistic-concurrency predicate is only
    // meaningful if the 0015 trigger actually bumps updated_at.
    const id = await seedIntake(A, "in_progress");
    const before = await adminQuery(
      `select updated_at from public.client_intake_forms where id = $1`,
      [id],
    );
    await userQuery(
      A.userId,
      `update public.client_intake_forms set responses = '{"x":1}'::jsonb where id = $1`,
      [id],
    );
    const after = await adminQuery(
      `select updated_at from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(
      new Date(after.rows[0].updated_at).getTime(),
    ).toBeGreaterThan(new Date(before.rows[0].updated_at).getTime());
  });

  it("a stale updated_at predicate matches zero rows", async () => {
    const id = await seedIntake(A, "in_progress");
    const first = await adminQuery(
      `select updated_at from public.client_intake_forms where id = $1`,
      [id],
    );
    const staleToken = first.rows[0].updated_at;
    // Someone else writes.
    await userQuery(
      A.userId,
      `update public.client_intake_forms set responses = '{"other":"write"}'::jsonb where id = $1`,
      [id],
    );
    // Our write, carrying the token we last saw, must now match nothing.
    const res = await userQuery(
      A.userId,
      `update public.client_intake_forms
          set responses = '{"ours":"clobber"}'::jsonb
        where id = $1 and updated_at = $2
        returning id`,
      [id, staleToken],
    );
    expect(res.rowCount).toBe(0);
    const stored = await storedResponses(id);
    expect(stored.other).toBe("write");
    expect(stored).not.toHaveProperty("ours");
  });
});

// ---------------------------------------------------------------------------
describe("2. the client-owned submission boundary is enforced by the DATABASE", () => {
  it("an authenticated member CANNOT move an intake to submitted", async () => {
    const id = await seedIntake(A, "in_progress");
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'submitted', submitted_at = now()
          where id = $1 returning id`,
        [id],
      ),
    ).rejects.toThrow(/Only the client can submit their own intake/i);

    const row = await adminQuery(
      `select status, submitted_at from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("in_progress");
    expect(row.rows[0].submitted_at).toBeNull();
  });

  it("...not even while writing legitimate assisted answers in the same statement", async () => {
    const id = await seedIntake(A, "in_progress");
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set responses = $2::jsonb, status = 'submitted', submitted_at = now()
          where id = $1 returning id`,
        [id, JSON.stringify({ legal_name: "Dana" })],
      ),
    ).rejects.toThrow(/Only the client can submit their own intake/i);
    const row = await adminQuery(
      `select status from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("in_progress");
  });

  it("a member cannot attach review metadata to a draft either", async () => {
    const id = await seedIntake(A, "in_progress");
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set reviewed_by = $2, reviewed_at = now()
          where id = $1 returning id`,
        [id, A.practitionerId],
      ),
    ).rejects.toThrow(/Review metadata can only be recorded/i);
  });
});

// ---------------------------------------------------------------------------
describe("3. assisted answers and provenance freeze with the record", () => {
  for (const state of ["submitted", "reviewed"] as const) {
    it(`a ${state} intake's responses cannot be rewritten by a member`, async () => {
      const original = {
        legal_name: "Dana Reyes",
        [PROV_KEY]: provenance(A.practitionerId, "Chloe Baca"),
      };
      const id = await seedIntake(A, state, original);
      await expect(
        userQuery(
          A.userId,
          `update public.client_intake_forms
              set responses = $2::jsonb
            where id = $1 returning id`,
          [id, JSON.stringify({ legal_name: "Rewritten" })],
        ),
      ).rejects.toThrow(/Submitted intake answers are immutable/i);

      const stored = await storedResponses(id);
      expect(stored.legal_name).toBe("Dana Reyes");
      expect(stored[PROV_KEY]).toMatchObject({
        started_by: { practitioner_id: A.practitionerId },
      });
    });

    it(`a ${state} intake's provenance cannot be quietly re-attributed`, async () => {
      const original = {
        [PROV_KEY]: provenance(A.practitionerId, "Chloe Baca"),
      };
      const id = await seedIntake(A, state, original);
      const forged = { [PROV_KEY]: provenance(B.practitionerId, "Someone Else") };
      await expect(
        userQuery(
          A.userId,
          `update public.client_intake_forms set responses = $2::jsonb where id = $1 returning id`,
          [id, JSON.stringify(forged)],
        ),
      ).rejects.toThrow(/Submitted intake answers are immutable/i);
      const stored = await storedResponses(id);
      expect(
        (stored[PROV_KEY] as Record<string, unknown>).started_by,
      ).toMatchObject({ display_name: "Chloe Baca" });
    });
  }
});

// ---------------------------------------------------------------------------
describe("4. cross-studio isolation", () => {
  it("a member of another studio cannot write a draft's responses", async () => {
    const id = await seedIntake(A, "in_progress");
    const res = await userQuery(
      B.userId,
      `update public.client_intake_forms
          set responses = '{"legal_name":"Injected"}'::jsonb
        where id = $1 returning id`,
      [id],
    );
    expect(res.rowCount).toBe(0);
    const stored = await storedResponses(id);
    expect(stored).not.toHaveProperty("legal_name");
  });

  it("a member of another studio cannot even read it", async () => {
    const id = await seedIntake(A, "in_progress");
    const res = await userQuery(
      B.userId,
      `select id from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(res.rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("5. the documented limitation is real, and stated honestly", () => {
  it("a member CAN still write provenance naming a colleague by direct SQL", async () => {
    // This is NOT a bug introduced by this feature, it is the pre-existing
    // shape of client_intake_forms_member_update, whose WITH CHECK is
    // `is_studio_member(studio_id)` with no column and no actor predicate.
    // The application derives provenance from the session, but the DATABASE
    // does not enforce that. The PR states this rather than implying the
    // record is unforgeable. Closing it needs a future command/RLS boundary.
    const id = await seedIntake(A, "in_progress");
    const colleague = await adminQuery(
      `select id, display_name from public.practitioners
        where studio_id = $1 limit 1`,
      [A.studioId],
    );
    const forged = {
      [PROV_KEY]: provenance(colleague.rows[0].id, "Not Actually Them"),
    };
    const res = await userQuery(
      A.userId,
      `update public.client_intake_forms set responses = $2::jsonb where id = $1 returning id`,
      [id, JSON.stringify(forged)],
    );
    // It succeeds. That is the limitation, proven rather than assumed.
    expect(res.rowCount).toBe(1);
  });
});

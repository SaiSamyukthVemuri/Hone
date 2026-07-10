import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// Migration 0118: once an intake is submitted/reviewed, an authenticated member
// cannot directly rewrite its answers / submitted_at / status / review
// attribution — while draft editing, legitimate review, and reissue-based
// corrections still work. Proven on the REAL migrated local DB. Uses only
// non-clinical placeholder responses.

let A: SeededStudio;
let B: SeededStudio;

// Seed an intake row in a given lifecycle state (INSERT — the BEFORE UPDATE
// trigger does not fire on insert), returns its id.
async function seedIntake(
  studio: SeededStudio,
  state: "in_progress" | "submitted" | "reviewed",
): Promise<string> {
  const id = randomUUID();
  if (state === "in_progress") {
    await adminQuery(
      `insert into public.client_intake_forms (id, studio_id, client_id, status, responses)
       values ($1, $2, $3, 'in_progress', '{"q":"draft"}'::jsonb)`,
      [id, studio.studioId, studio.clientId],
    );
  } else if (state === "submitted") {
    await adminQuery(
      `insert into public.client_intake_forms (id, studio_id, client_id, status, responses, submitted_at)
       values ($1, $2, $3, 'submitted', '{"q":"orig"}'::jsonb, now())`,
      [id, studio.studioId, studio.clientId],
    );
  } else {
    await adminQuery(
      `insert into public.client_intake_forms (id, studio_id, client_id, status, responses, submitted_at, reviewed_at, reviewed_by)
       values ($1, $2, $3, 'reviewed', '{"q":"orig"}'::jsonb, now(), now(), $4)`,
      [id, studio.studioId, studio.clientId, studio.practitionerId],
    );
  }
  return id;
}

beforeAll(async () => {
  A = await seedStudio("intake-a");
  B = await seedStudio("intake-b");
});
afterAll(async () => {
  await closePool();
});

describe("0118: draft edits + approved review/amendment paths still work", () => {
  it("1. a draft (in_progress) intake's answers CAN be updated by a member", async () => {
    const id = await seedIntake(A, "in_progress");
    const r = await userQuery(
      A.userId,
      `update public.client_intake_forms set responses = '{"q":"draft2"}'::jsonb, current_step = 2 where id = $1`,
      [id],
    );
    expect(r.rowCount).toBe(1);
  });

  it("9. the approved review action (submitted -> reviewed by the caller) works", async () => {
    const id = await seedIntake(A, "submitted");
    const r = await userQuery(
      A.userId,
      `update public.client_intake_forms
         set status = 'reviewed', reviewed_at = now(), reviewed_by = $2, practitioner_notes = 'ok'
       where id = $1`,
      [id, A.practitionerId],
    );
    expect(r.rowCount).toBe(1);
  });

  it("practitioner_notes remain editable on a reviewed row (review metadata)", async () => {
    const id = await seedIntake(A, "reviewed");
    const r = await userQuery(
      A.userId,
      `update public.client_intake_forms set practitioner_notes = 'later note' where id = $1`,
      [id],
    );
    expect(r.rowCount).toBe(1);
  });

  it("10/11. amendment via a NEW row preserves the original submitted/reviewed row", async () => {
    const original = await seedIntake(A, "reviewed");
    // Reissue = insert a fresh in_progress intake for the same client.
    const amendment = randomUUID();
    await adminQuery(
      `insert into public.client_intake_forms (id, studio_id, client_id, status, responses)
       values ($1, $2, $3, 'in_progress', '{"q":"redo"}'::jsonb)`,
      [amendment, A.studioId, A.clientId],
    );
    // Original answers are still the original, still queryable by a member.
    const read = await userQuery(
      A.userId,
      `select responses->>'q' as q, status from public.client_intake_forms where id = $1`,
      [original],
    );
    expect(read.rows[0].q).toBe("orig");
    expect(read.rows[0].status).toBe("reviewed");
  });
});

describe("0118: submitted/reviewed answers are immutable to a member", () => {
  it("2. submitted answers cannot be directly updated", async () => {
    const id = await seedIntake(A, "submitted");
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set responses = '{"q":"tampered"}'::jsonb where id = $1`,
        [id],
      ),
    ).rejects.toThrow();
  });

  it("3. reviewed answers cannot be directly updated", async () => {
    const id = await seedIntake(A, "reviewed");
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set responses = '{"q":"tampered"}'::jsonb where id = $1`,
        [id],
      ),
    ).rejects.toThrow();
    // and the stored answer is unchanged.
    const check = await adminQuery(
      `select responses->>'q' as q from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(check.rows[0].q).toBe("orig");
  });

  it("4. a submitted/reviewed intake cannot be reverted to draft", async () => {
    const id = await seedIntake(A, "submitted");
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set status = 'in_progress' where id = $1`,
        [id],
      ),
    ).rejects.toThrow();
  });

  it("submitted_at cannot be rewritten on a terminal row", async () => {
    const id = await seedIntake(A, "reviewed");
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set submitted_at = '2020-01-01' where id = $1`,
        [id],
      ),
    ).rejects.toThrow();
  });

  it("5. reviewed_by cannot be forged to a foreign practitioner", async () => {
    const id = await seedIntake(A, "submitted");
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set status = 'reviewed', reviewed_at = now(), reviewed_by = $2 where id = $1`,
        [id, B.practitionerId], // a different studio's practitioner
      ),
    ).rejects.toThrow();
  });

  it("6. reviewed_at cannot be forged/backdated once reviewed", async () => {
    const id = await seedIntake(A, "reviewed");
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set reviewed_at = '2020-01-01' where id = $1`,
        [id],
      ),
    ).rejects.toThrow();
  });
});

describe("0118: cross-tenant + delete posture", () => {
  it("7. Studio A cannot update a Studio B intake (RLS studio scope)", async () => {
    const id = await seedIntake(B, "submitted");
    const r = await userQuery(
      A.userId,
      `update public.client_intake_forms set practitioner_notes = 'x' where id = $1`,
      [id],
    );
    expect(r.rowCount).toBe(0); // RLS: not a member of B's studio
    // (8. Client-level isolation for the CLIENT-facing edit path is enforced by
    // the tokenized server action, not member RLS — members are studio-scoped.)
  });

  it("12/13. DELETE stays blocked (no policy); historical rows remain readable", async () => {
    const id = await seedIntake(A, "reviewed");
    const del = await userQuery(
      A.userId,
      `delete from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(del.rowCount).toBe(0); // no delete policy -> RLS default-deny
    const read = await userQuery(
      A.userId,
      `select id from public.client_intake_forms where id = $1`,
      [id],
    );
    expect(read.rowCount).toBe(1); // still readable
  });
});

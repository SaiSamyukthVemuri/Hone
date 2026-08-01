import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// F-CLIN-004 — DATABASE BOUNDARY CANARY
// ===========================================================================
//
// STATUS: APPLICATION PATH IMPLEMENTED — DATABASE BOUNDARY STILL OPEN.
//
// This suite deliberately PINS A DEFECT THAT IS STILL PRESENT. It is not a
// regression test for a fix; it is a machine-checked record of the gap the
// application-layer PR could not close, so the limitation cannot quietly rot
// in a markdown file.
//
// The proved fact (re-verified here on the real migrated local database):
// an AUTHENTICATED direct PostgREST/SQL update can still drive
//
//     status: in_progress -> reviewed,  submitted_at still NULL
//
// because migration 0118's review guards are all nested under
//
//     if old.status in ('submitted', 'reviewed')
//
// so when the OLD row is still in_progress the entire guard block is skipped.
//
// WHEN MIGRATION 0162 LANDS, THIS FILE MUST BE INVERTED IN THE SAME PR:
// the two "still reachable" cases below must flip to expect a rejection. A
// failing test here is the intended signal that the boundary finally closed —
// not a broken test.
//
// Every row seeded here is synthetic and confined to the disposable local
// database. Responses are non-clinical placeholders.

let A: SeededStudio;

beforeAll(async () => {
  A = await seedStudio("intake-boundary-a");
});
afterAll(async () => {
  await closePool();
});

async function seedInProgress(studio: SeededStudio): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.client_intake_forms (id, studio_id, client_id, status, responses)
     values ($1, $2, $3, 'in_progress', '{"q":"draft"}'::jsonb)`,
    [id, studio.studioId, studio.clientId],
  );
  return id;
}

type IntakeRowSnapshot = {
  status: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

async function readRow(id: string): Promise<IntakeRowSnapshot> {
  const res = await adminQuery(
    `select status, submitted_at, reviewed_at, reviewed_by
       from public.client_intake_forms where id = $1`,
    [id],
  );
  return res.rows[0] as IntakeRowSnapshot;
}

describe("F-CLIN-004: the 0118 trigger STILL does not guard the incoming transition", () => {
  it("KNOWN OPEN — authenticated in_progress -> reviewed succeeds with submitted_at NULL", async () => {
    const id = await seedInProgress(A);

    const res = await userQuery(
      A.userId,
      `update public.client_intake_forms
          set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
        where id = $1
        returning id`,
      [id, A.practitionerId],
    );

    // THIS IS THE DEFECT. One row transitioned.
    expect(res.rowCount).toBe(1);

    const row = await readRow(id);
    expect(row.status).toBe("reviewed");
    // submitted_at was never set — a "reviewed" clinical record for an intake
    // the client never submitted.
    expect(row.submitted_at).toBeNull();
    expect(row.reviewed_at).not.toBeNull();
    expect(row.reviewed_by).toBe(A.practitionerId);
  });

  it("KNOWN OPEN — the reason is structural: the guard block is skipped for an in_progress OLD row", async () => {
    const src = await adminQuery(
      `select pg_get_functiondef(oid) as def
         from pg_proc
        where proname = 'enforce_intake_terminal_immutability'`,
    );
    const def = (src.rows[0] as { def: string }).def;

    // The review checks exist...
    expect(def).toMatch(/reviewed_by must be the reviewing practitioner/);
    expect(def).toMatch(/Review attribution is immutable once reviewed/);
    // ...but they sit INSIDE the old-status gate, so an in_progress OLD row
    // never reaches them.
    const gate = def.indexOf("old.status in ('submitted', 'reviewed')");
    expect(gate).toBeGreaterThan(-1);
    expect(def.indexOf("reviewed_by must be the reviewing practitioner")).toBeGreaterThan(gate);
    // There is no predicate anywhere requiring the NEW status 'reviewed' to
    // come from an OLD status of 'submitted'.
    expect(def).not.toMatch(/new\.status\s*=\s*'reviewed'[\s\S]{0,200}old\.status\s*<>\s*'submitted'/);
  });
});

// ---------------------------------------------------------------------------
// FIDELITY: the action's predicate set, run against the REAL database.
//
// The unit suite (tests/app/clients/intake-review-integrity.test.ts) drives the
// real server action through a hand-written fake that models PostgREST filter
// semantics. That fake is only worth as much as its fidelity, so these cases
// run the SAME predicate set as genuine SQL, as the `authenticated` role, and
// assert the affected-row counts the fake claims. If PostgREST/Postgres ever
// disagrees with the fake, this fails.
// ---------------------------------------------------------------------------
describe("F-CLIN-004: the action's predicate set behaves identically on the real DB", () => {
  const REVIEW_UPDATE = `
    update public.client_intake_forms
       set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
     where id = $1
       and studio_id = $3
       and client_id = $4
       and deleted_at is null
       and status = 'submitted'
       and submitted_at is not null
    returning id, client_id`;

  async function seedIn(
    studio: SeededStudio,
    over: {
      status?: string;
      submitted_at?: string | null;
      deleted_at?: string | null;
      clientId?: string;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await adminQuery(
      `insert into public.client_intake_forms
         (id, studio_id, client_id, status, responses, submitted_at, deleted_at)
       values ($1, $2, $3, $4, '{"q":"x"}'::jsonb, $5, $6)`,
      [
        id,
        studio.studioId,
        over.clientId ?? studio.clientId,
        over.status ?? "submitted",
        over.submitted_at === undefined ? new Date().toISOString() : over.submitted_at,
        over.deleted_at ?? null,
      ],
    );
    return id;
  }

  it("a genuine submitted row transitions and RETURNING yields exactly one row", async () => {
    const id = await seedIn(A);
    const res = await userQuery(A.userId, REVIEW_UPDATE, [
      id,
      A.practitionerId,
      A.studioId,
      A.clientId,
    ]);
    // RETURNING is not filtered away: the SELECT policy on this table is the
    // same is_studio_member(studio_id) predicate as the UPDATE policy, and
    // studio_id is never written, so an updatable row is always returnable.
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].client_id).toBe(A.clientId);
    expect((await readRow(id)).status).toBe("reviewed");
  });

  it("in_progress WITH a submitted_at affects zero rows (status predicate alone)", async () => {
    const id = await seedIn(A, { status: "in_progress" });
    const res = await userQuery(A.userId, REVIEW_UPDATE, [
      id,
      A.practitionerId,
      A.studioId,
      A.clientId,
    ]);
    expect(res.rowCount).toBe(0);
    const row = await readRow(id);
    expect(row.status).toBe("in_progress");
    expect(row.reviewed_by).toBeNull();
  });

  it("submitted WITHOUT a submitted_at affects zero rows", async () => {
    const id = await seedIn(A, { submitted_at: null });
    const res = await userQuery(A.userId, REVIEW_UPDATE, [
      id,
      A.practitionerId,
      A.studioId,
      A.clientId,
    ]);
    expect(res.rowCount).toBe(0);
    expect((await readRow(id)).reviewed_by).toBeNull();
  });

  it("a same-studio DIFFERENT client affects zero rows", async () => {
    // A second client in the same studio, so RLS permits the row but the
    // client_id predicate must refuse it.
    const otherClient = randomUUID();
    await adminQuery(
      `insert into public.clients (id, studio_id, name, email)
       values ($1, $2, 'Boundary Other', $3)`,
      [otherClient, A.studioId, `boundary-${otherClient.slice(0, 8)}@harness.local`],
    );
    const id = await seedIn(A, { clientId: otherClient });

    // Route says A.clientId; the row belongs to otherClient.
    const res = await userQuery(A.userId, REVIEW_UPDATE, [
      id,
      A.practitionerId,
      A.studioId,
      A.clientId,
    ]);
    expect(res.rowCount).toBe(0);
    const row = await readRow(id);
    expect(row.status).toBe("submitted");
    expect(row.reviewed_by).toBeNull();
  });

  it("a soft-deleted row affects zero rows", async () => {
    const id = await seedIn(A, { deleted_at: new Date().toISOString() });
    const res = await userQuery(A.userId, REVIEW_UPDATE, [
      id,
      A.practitionerId,
      A.studioId,
      A.clientId,
    ]);
    expect(res.rowCount).toBe(0);
    expect((await readRow(id)).reviewed_by).toBeNull();
  });

  it("a second review of an already-reviewed row affects zero rows and preserves attribution", async () => {
    const id = await seedIn(A);
    const first = await userQuery(A.userId, REVIEW_UPDATE, [
      id,
      A.practitionerId,
      A.studioId,
      A.clientId,
    ]);
    expect(first.rowCount).toBe(1);
    const stamped = await readRow(id);

    const second = await userQuery(A.userId, REVIEW_UPDATE, [
      id,
      A.practitionerId,
      A.studioId,
      A.clientId,
    ]);
    // The status predicate is the race boundary — the second statement matches
    // nothing and the original attribution survives untouched.
    expect(second.rowCount).toBe(0);
    const after = await readRow(id);
    expect(after.reviewed_at).toEqual(stamped.reviewed_at);
    expect(after.reviewed_by).toBe(stamped.reviewed_by);
  });
});

describe("F-CLIN-004: what migration 0162 must additionally enforce", () => {
  // These document the required end state. They are written as assertions
  // about TODAY's behaviour so the file stays green until 0162 lands, and each
  // carries the requirement it will become.
  it("REQUIREMENT — 0162 must reject in_progress -> reviewed (today it does not)", async () => {
    const id = await seedInProgress(A);
    const res = await userQuery(
      A.userId,
      `update public.client_intake_forms set status = 'reviewed' where id = $1 returning id`,
      [id],
    );
    // Today: accepted. After 0162: this must raise, and this expectation flips.
    expect(res.rowCount).toBe(1);
    expect((await readRow(id)).submitted_at).toBeNull();
  });

  it("ALREADY ENFORCED — a submitted row keeps its 0118 protections (0162 must preserve these)", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.client_intake_forms
         (id, studio_id, client_id, status, responses, submitted_at)
       values ($1, $2, $3, 'submitted', '{"q":"orig"}'::jsonb, now())`,
      [id, A.studioId, A.clientId],
    );

    // Answers immutable.
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set responses = '{"q":"tampered"}'::jsonb where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/immutable/i);

    // submitted_at immutable.
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set submitted_at = now() - interval '5 days' where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/immutable/i);

    // No foreign reviewer attribution.
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms
            set status = 'reviewed', reviewed_at = now(), reviewed_by = $2
          where id = $1`,
        [id, randomUUID()],
      ),
    ).rejects.toThrow(/reviewed_by must be the reviewing practitioner/i);

    // No regression to draft.
    await expect(
      userQuery(
        A.userId,
        `update public.client_intake_forms set status = 'in_progress' where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/cannot be reverted to draft/i);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #220 suites B + C: the record-keeping audit trail, exercised on
// the REAL migrated local database.
//
// B (immutability): the audit table has a SELECT-only policy for
// studio members. INSERT must throw an RLS violation; UPDATE and
// DELETE must affect zero rows (table grants exist, so RLS is the
// thing doing the blocking; that is exactly what these tests prove).
//
// C (triggers): inserting/updating a sterile item as an
// AUTHENTICATED member must produce trigger-written audit events
// with correct action, changed_fields, and actor resolution
// (auth.uid() -> practitioner row), and a no-op update must NOT
// produce a noisy event.

let s: SeededStudio;
let itemId: string;

beforeAll(async () => {
  s = await seedStudio("audit");
  itemId = randomUUID();
});

afterAll(async () => {
  await closePool();
});

describe("B: audit events are append-only for authenticated members", () => {
  it("INSERT into record_keeping_audit_events throws an RLS violation", async () => {
    await expect(
      userQuery(
        s.userId,
        `insert into public.record_keeping_audit_events
           (studio_id, record_type, record_id, action)
         values ($1, 'sterile_item', $2, 'created')`,
        [s.studioId, randomUUID()],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("UPDATE affects zero rows", async () => {
    // Ground truth: the studio has at least one audit event by the
    // end of suite C; for this test seed one via a trigger first.
    await adminQuery(
      `insert into public.record_keeping_exposure_incidents
         (id, studio_id, incident_date, exposed_person_full_name)
       values ($1, $2, current_date, 'Immutability Probe')`,
      [randomUUID(), s.studioId],
    );
    const result = await userQuery(
      s.userId,
      `update public.record_keeping_audit_events
          set action = 'updated'
        where studio_id = $1`,
      [s.studioId],
    );
    expect(result.rowCount).toBe(0);
  });

  it("DELETE affects zero rows and the rows survive", async () => {
    const before = await adminQuery(
      `select count(*)::int as n from public.record_keeping_audit_events where studio_id = $1`,
      [s.studioId],
    );
    expect(before.rows[0].n).toBeGreaterThanOrEqual(1);
    const result = await userQuery(
      s.userId,
      `delete from public.record_keeping_audit_events where studio_id = $1`,
      [s.studioId],
    );
    expect(result.rowCount).toBe(0);
    const after = await adminQuery(
      `select count(*)::int as n from public.record_keeping_audit_events where studio_id = $1`,
      [s.studioId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("members can SELECT their own studio's audit rows only", async () => {
    const other = await seedStudio("audit-other");
    await adminQuery(
      `insert into public.record_keeping_exposure_incidents
         (id, studio_id, incident_date, exposed_person_full_name)
       values ($1, $2, current_date, 'Other Studio Probe')`,
      [randomUUID(), other.studioId],
    );
    await asUser(s.userId, async (q) => {
      const own = await q(
        `select id from public.record_keeping_audit_events where studio_id = $1`,
        [s.studioId],
      );
      expect(Number(own.rowCount)).toBeGreaterThanOrEqual(1);
      const theirs = await q(
        `select id from public.record_keeping_audit_events where studio_id = $1`,
        [other.studioId],
      );
      expect(theirs.rowCount).toBe(0);
    });
  });
});

describe("C: sterile item audit triggers fire for authenticated writes", () => {
  it("INSERT by a member creates a 'created' event with resolved actor", async () => {
    await userQuery(
      s.userId,
      `insert into public.record_keeping_sterile_items
         (id, studio_id, date_purchased, item_description, created_by_practitioner_id)
       values ($1, $2, current_date, 'Harness probes box', $3)`,
      [itemId, s.studioId, s.practitionerId],
    );
    const events = await adminQuery(
      `select action, changed_fields, actor_practitioner_id, actor_user_id
         from public.record_keeping_audit_events
        where record_type = 'sterile_item' and record_id = $1
        order by created_at`,
      [itemId],
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].action).toBe("created");
    expect(events.rows[0].actor_practitioner_id).toBe(s.practitionerId);
    expect(events.rows[0].actor_user_id).toBe(s.userId);
  });

  it("UPDATE by a member creates an 'updated' event listing the changed field", async () => {
    await userQuery(
      s.userId,
      `update public.record_keeping_sterile_items
          set item_description = 'Harness probes box (relabeled)'
        where id = $1`,
      [itemId],
    );
    const events = await adminQuery(
      `select action, changed_fields, changes
         from public.record_keeping_audit_events
        where record_type = 'sterile_item' and record_id = $1
        order by created_at`,
      [itemId],
    );
    expect(events.rowCount).toBe(2);
    const updated = events.rows[1];
    expect(updated.action).toBe("updated");
    expect(updated.changed_fields).toContain("item_description");
    expect(updated.changes.item_description.new).toBe(
      "Harness probes box (relabeled)",
    );
  });

  it("an unchanged UPDATE does not create a noisy event", async () => {
    await userQuery(
      s.userId,
      `update public.record_keeping_sterile_items
          set item_description = item_description
        where id = $1`,
      [itemId],
    );
    const events = await adminQuery(
      `select count(*)::int as n
         from public.record_keeping_audit_events
        where record_type = 'sterile_item' and record_id = $1`,
      [itemId],
    );
    // Still exactly the two events from the tests above; the
    // set_updated_at touch is in the trigger's skip list.
    expect(events.rows[0].n).toBe(2);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #222 (migration 0088): exposure incident owner access tier,
// proven on the REAL migrated local database. The seeded studio
// owner (role 'owner') and an additional non-owner practitioner
// (role 'practitioner') exercise both sides of the tier:
//
//   SELECT  owner-only      UPDATE  owner-only
//   INSERT  any member      DELETE  nobody (no policy)
//
// plus the audit carve-out: exposure-incident audit rows (which
// carry old/new field values) are owner-only to read, while other
// record types stay member-readable.

let s: SeededStudio;
let member: { userId: string; practitionerId: string };
let ownerIncidentId: string;

beforeAll(async () => {
  s = await seedStudio("exposure");
  member = await seedMember(s, "exposure-member");
  ownerIncidentId = randomUUID();
  await adminQuery(
    `insert into public.record_keeping_exposure_incidents
       (id, studio_id, incident_date, exposed_person_full_name,
        exposure_details, created_by_practitioner_id)
     values ($1, $2, current_date, 'Owner Seeded Person', 'needle stick during probe change', $3)`,
    [ownerIncidentId, s.studioId, s.practitionerId],
  );
});

afterAll(async () => {
  await closePool();
});

describe("owner tier: owner keeps full access in their studio", () => {
  it("owner can SELECT exposure incidents", async () => {
    const rows = await userQuery(
      s.userId,
      `select id, exposed_person_full_name
         from public.record_keeping_exposure_incidents
        where studio_id = $1`,
      [s.studioId],
    );
    expect(Number(rows.rowCount)).toBeGreaterThanOrEqual(1);
  });

  it("owner can UPDATE an exposure incident, and the audit trigger writes 'updated'", async () => {
    const result = await userQuery(
      s.userId,
      `update public.record_keeping_exposure_incidents
          set action_taken = 'washed, reported, physician follow-up booked'
        where id = $1`,
      [ownerIncidentId],
    );
    expect(result.rowCount).toBe(1);
    const audit = await adminQuery(
      `select action, changed_fields
         from public.record_keeping_audit_events
        where record_type = 'exposure_incident' and record_id = $1 and action = 'updated'`,
      [ownerIncidentId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].changed_fields).toContain("action_taken");
  });
});

describe("owner tier: non-owner member can report but not browse", () => {
  it("member can INSERT a new incident, and the audit trigger writes 'created' with the member as actor", async () => {
    const incidentId = randomUUID();
    const insert = await userQuery(
      member.userId,
      `insert into public.record_keeping_exposure_incidents
         (id, studio_id, incident_date, exposed_person_full_name,
          exposure_details, created_by_practitioner_id)
       values ($1, $2, current_date, 'Member Reported Person', 'splash exposure', $3)`,
      [incidentId, s.studioId, member.practitionerId],
    );
    expect(insert.rowCount).toBe(1);
    const audit = await adminQuery(
      `select action, actor_practitioner_id, actor_user_id
         from public.record_keeping_audit_events
        where record_type = 'exposure_incident' and record_id = $1`,
      [incidentId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].action).toBe("created");
    expect(audit.rows[0].actor_practitioner_id).toBe(member.practitionerId);
    expect(audit.rows[0].actor_user_id).toBe(member.userId);
  });

  it("member cannot SELECT exposure incidents (even ones they reported)", async () => {
    const rows = await userQuery(
      member.userId,
      `select id from public.record_keeping_exposure_incidents where studio_id = $1`,
      [s.studioId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("member cannot UPDATE exposure incidents", async () => {
    const result = await userQuery(
      member.userId,
      `update public.record_keeping_exposure_incidents
          set notes = 'member tampering attempt'
        where studio_id = $1`,
      [s.studioId],
    );
    expect(result.rowCount).toBe(0);
  });

  it("member cannot DELETE exposure incidents and rows survive", async () => {
    const result = await userQuery(
      member.userId,
      `delete from public.record_keeping_exposure_incidents where studio_id = $1`,
      [s.studioId],
    );
    expect(result.rowCount).toBe(0);
    const survives = await adminQuery(
      `select id from public.record_keeping_exposure_incidents where id = $1`,
      [ownerIncidentId],
    );
    expect(survives.rowCount).toBe(1);
  });

  it("owner cannot DELETE either (no DELETE policy for anyone)", async () => {
    const result = await userQuery(
      s.userId,
      `delete from public.record_keeping_exposure_incidents where id = $1`,
      [ownerIncidentId],
    );
    expect(result.rowCount).toBe(0);
  });
});

describe("owner tier: cross-studio and audit carve-out", () => {
  it("an owner of ANOTHER studio cannot SELECT these incidents", async () => {
    const foreign = await seedStudio("exposure-foreign");
    const rows = await userQuery(
      foreign.userId,
      `select id from public.record_keeping_exposure_incidents
        where studio_id = $1 or id = $2`,
      [s.studioId, ownerIncidentId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("member cannot read exposure-incident audit rows, owner can", async () => {
    await asUser(member.userId, async (q) => {
      const exposureAudit = await q(
        `select id from public.record_keeping_audit_events
          where studio_id = $1 and record_type = 'exposure_incident'`,
        [s.studioId],
      );
      expect(exposureAudit.rowCount).toBe(0);
    });
    const ownerView = await userQuery(
      s.userId,
      `select id from public.record_keeping_audit_events
        where studio_id = $1 and record_type = 'exposure_incident'`,
      [s.studioId],
    );
    expect(Number(ownerView.rowCount)).toBeGreaterThanOrEqual(2);
  });

  it("member still reads NON-exposure audit rows (carve-out is narrow)", async () => {
    const itemId = randomUUID();
    await userQuery(
      member.userId,
      `insert into public.record_keeping_sterile_items
         (id, studio_id, date_purchased, item_description, created_by_practitioner_id)
       values ($1, $2, current_date, 'Member visible probes', $3)`,
      [itemId, s.studioId, member.practitionerId],
    );
    const rows = await userQuery(
      member.userId,
      `select id from public.record_keeping_audit_events
        where record_type = 'sterile_item' and record_id = $1`,
      [itemId],
    );
    expect(rows.rowCount).toBe(1);
  });
});

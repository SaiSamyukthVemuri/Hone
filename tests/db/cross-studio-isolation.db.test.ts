import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #220 suite A: cross-studio isolation against the REAL migrated
// local database. Two studios are seeded with clinical + record
// keeping data; practitioner A (authenticated, RLS enforced) must
// see their own studio's rows and ZERO of studio B's rows, table by
// table. Positive controls prove the queries themselves work, so an
// empty result means RLS filtered it, not a broken query.

let a: SeededStudio;
let b: SeededStudio;
let bSessionId: string;
let bIncidentId: string;

beforeAll(async () => {
  a = await seedStudio("iso-a");
  b = await seedStudio("iso-b");
  await seedSession(a);
  const seeded = await seedSession(b);
  bSessionId = seeded.sessionId;
  bIncidentId = randomUUID();
  for (const s of [a, b]) {
    await adminQuery(
      `insert into public.record_keeping_exposure_incidents
         (id, studio_id, incident_date, exposed_person_full_name, created_by_practitioner_id)
       values ($1, $2, current_date, $3, $4)`,
      [
        s === b ? bIncidentId : randomUUID(),
        s.studioId,
        `Harness Person ${s.studioId.slice(0, 8)}`,
        s.practitionerId,
      ],
    );
  }
});

afterAll(async () => {
  await closePool();
});

describe("practitioner A sees their own studio (positive controls)", () => {
  it("reads own clients, sessions, session_blocks, incidents, audit events", async () => {
    await asUser(a.userId, async (q) => {
      const clients = await q(
        `select id from public.clients where studio_id = $1`,
        [a.studioId],
      );
      expect(clients.rowCount).toBe(1);
      const sessions = await q(
        `select id from public.sessions where studio_id = $1`,
        [a.studioId],
      );
      expect(sessions.rowCount).toBe(1);
      const blocks = await q(
        `select id from public.session_blocks where studio_id = $1`,
        [a.studioId],
      );
      expect(blocks.rowCount).toBe(1);
      const incidents = await q(
        `select id from public.record_keeping_exposure_incidents where studio_id = $1`,
        [a.studioId],
      );
      expect(incidents.rowCount).toBe(1);
      // The exposure-incident INSERT trigger wrote an audit event;
      // the member can read it for their own studio.
      const audit = await q(
        `select id from public.record_keeping_audit_events where studio_id = $1`,
        [a.studioId],
      );
      expect(Number(audit.rowCount)).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("practitioner A cannot read studio B rows", () => {
  it("clients: zero rows even when filtering for B's studio directly", async () => {
    await asUser(a.userId, async (q) => {
      const direct = await q(
        `select id from public.clients where studio_id = $1`,
        [b.studioId],
      );
      expect(direct.rowCount).toBe(0);
      const byId = await q(`select id from public.clients where id = $1`, [
        b.clientId,
      ]);
      expect(byId.rowCount).toBe(0);
    });
  });

  it("sessions: zero rows", async () => {
    await asUser(a.userId, async (q) => {
      const rows = await q(
        `select id from public.sessions where studio_id = $1 or id = $2`,
        [b.studioId, bSessionId],
      );
      expect(rows.rowCount).toBe(0);
    });
  });

  it("session_blocks: zero rows", async () => {
    await asUser(a.userId, async (q) => {
      const rows = await q(
        `select id from public.session_blocks where studio_id = $1`,
        [b.studioId],
      );
      expect(rows.rowCount).toBe(0);
    });
  });

  it("record_keeping_exposure_incidents: zero rows", async () => {
    await asUser(a.userId, async (q) => {
      const rows = await q(
        `select id from public.record_keeping_exposure_incidents
          where studio_id = $1 or id = $2`,
        [b.studioId, bIncidentId],
      );
      expect(rows.rowCount).toBe(0);
    });
  });

  it("record_keeping_audit_events: zero rows", async () => {
    // Studio B has at least one audit event (the incident INSERT
    // trigger); confirm it exists as admin, then confirm A sees none.
    const groundTruth = await adminQuery(
      `select id from public.record_keeping_audit_events where studio_id = $1`,
      [b.studioId],
    );
    expect(Number(groundTruth.rowCount)).toBeGreaterThanOrEqual(1);
    await asUser(a.userId, async (q) => {
      const rows = await q(
        `select id from public.record_keeping_audit_events where studio_id = $1`,
        [b.studioId],
      );
      expect(rows.rowCount).toBe(0);
    });
  });
});

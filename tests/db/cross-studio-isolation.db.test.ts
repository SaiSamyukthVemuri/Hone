import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
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

// ===========================================================================
// Appointment boundary B2 — T4.1..T4.4
// ===========================================================================
//
// Until this block the suite covered clients, sessions, session_blocks and two
// record-keeping tables, all SELECT-only. `appointments` was absent entirely,
// in both directions: no tenant-consistency write case and no read-isolation
// case.
//
// T4.5 (an authenticated INSERT naming the member's OWN studio is refused
// 42501) is deliberately NOT here. That becomes true only once B3 / migration
// 0172 revokes the verb; asserting it now would be a test that is red by
// design, in a PR that ships no migration.

describe("T4 appointments and appointment_audit cross-studio isolation", () => {
  const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

  // Every appointment below gets a unique whole-day offset. The studio-wide
  // EXCLUDE constraint (no_overlapping_appointments_studio_wide, active while
  // capacity is off) would otherwise be able to reject an insert for a reason
  // that has nothing to do with the foreign key under test — and a 23P01 read
  // as "the FK worked" is exactly the false pass this guards against.
  let dayCursor = 0;
  const nextDayOffset = () => (dayCursor += 1);

  let serviceA: string;
  let serviceB: string;
  let apptA: string;
  let apptB: string;
  let auditA: string;
  let auditB: string;

  // Builds the INSERT with fully independent parts so each foreign key can be
  // violated ON ITS OWN. Constructing one row with all three mismatches and
  // calling it three tests would prove only that *something* rejected it.
  function insertApptSql(): string {
    return `insert into public.appointments
              (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
               duration_minutes, status, cancellation_token_hash)
            values (gen_random_uuid(), $1, $2, $3, $4,
                    now() + make_interval(days => $5::int),
                    now() + make_interval(days => $5::int) + interval '60 minutes',
                    60, 'confirmed', $6)
            returning id`;
  }

  beforeAll(async () => {
    // buffer_minutes defaults to 15; zero it so appointments_enforce_buffer_trg
    // (HB001) can never pre-empt the constraint being measured.
    for (const s of [a, b]) {
      await adminQuery(`update public.studios set buffer_minutes = 0 where id = $1`, [
        s.studioId,
      ]);
    }
    const mkService = async (s: SeededStudio, name: string) => {
      const r = await adminQuery(
        `insert into public.services
           (id, studio_id, name, default_duration_minutes, price_cents, active)
         values ($1, $2, $3, 60, 0, true) returning id`,
        [randomUUID(), s.studioId, name],
      );
      return r.rows[0].id as string;
    };
    serviceA = await mkService(a, "Iso Service A");
    serviceB = await mkService(b, "Iso Service B");

    const mkAppt = async (s: SeededStudio, serviceId: string) => {
      const r = await adminQuery(insertApptSql(), [
        s.studioId,
        s.practitionerId,
        s.clientId,
        serviceId,
        nextDayOffset(),
        hash64(),
      ]);
      return r.rows[0].id as string;
    };
    apptA = await mkAppt(a, serviceA);
    apptB = await mkAppt(b, serviceB);

    // One audit row per studio. Inserted directly rather than through a
    // command: this block is about READ isolation, and a command would drag
    // its own preconditions into a test that is not about them.
    const mkAudit = async (apptId: string) => {
      const r = await adminQuery(
        `insert into public.appointment_audit
           (appointment_id, actor_type, actor_id, action, details)
         values ($1, 'practitioner', $2, 'created', '{"source":"iso-fixture"}'::jsonb)
         returning id`,
        [apptId, randomUUID()],
      );
      return r.rows[0].id as string;
    };
    auditA = await mkAudit(apptA);
    auditB = await mkAudit(apptB);
  });

  // -------------------------------------------------------------------------
  // T4.1 / T4.2 — the 0151 composite same-studio foreign keys, under service_role
  // -------------------------------------------------------------------------
  //
  // Run as `postgres` (adminQuery) on purpose, since B5 / 0174.
  //
  // These blocks were written against `service_role` because it bypasses RLS,
  // so RLS could not be what rejected the rows and the composite FK was
  // genuinely the control under test. 0174 GROUP 10.1 revoked service_role's
  // INSERT on public.appointments, so that role now fails at 42501 BEFORE any
  // constraint is consulted — which would silently destroy the FK coverage.
  //
  // The proof therefore moves to `postgres`, the table owner and migration
  // channel: the only role that still holds INSERT, and also a BYPASSRLS role,
  // so the original argument carries over intact. The privilege posture that
  // forced the move is pinned separately in
  // tests/db/appointment-boundary-revocation.db.test.ts and by T5.5 in
  // tests/db/appointment-audit-invariant.db.test.ts, so nothing is lost.
  //
  // Rows are cleaned up in this suite's teardown rather than by asRole's
  // rollback.

  describe("T4.1 client_id must belong to the appointment's studio", () => {
    it("positive control: a fully same-studio appointment INSERTs successfully as service_role", async () => {
      const offset = nextDayOffset();
      const ins = await adminQuery(insertApptSql(), [
        a.studioId,
        a.practitionerId,
        a.clientId,
        serviceA,
        offset,
        hash64(),
      ]);
      const id = ins.rows[0].id as string;
      const back = await adminQuery(
        `select studio_id, client_id, service_id, practitioner_id
           from public.appointments where id = $1`,
        [id],
      );
      const seen = back.rows[0];
      expect(seen.studio_id).toBe(a.studioId);
      expect(seen.client_id).toBe(a.clientId);
      expect(seen.service_id).toBe(serviceA);
      expect(seen.practitioner_id).toBe(a.practitionerId);
    });

    it("negative control: studio A's studio_id with studio B's client_id is rejected 23503", async () => {
      // service and practitioner stay valid for A, so the client FK is the
      // only constraint that can fire.
      const offset = nextDayOffset();
      await expect(
        adminQuery(insertApptSql(), [
            a.studioId,
            a.practitionerId,
            b.clientId,
            serviceA,
            offset,
            hash64(),
          ]),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "appointments_client_same_studio_fk",
      });
    });
  });

  describe("T4.2 service_id and practitioner_id must belong to the appointment's studio", () => {
    it("studio B's service_id on a studio A appointment is rejected 23503", async () => {
      const offset = nextDayOffset();
      await expect(
        adminQuery(insertApptSql(), [
            a.studioId,
            a.practitionerId,
            a.clientId,
            serviceB,
            offset,
            hash64(),
          ]),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "appointments_service_same_studio_fk",
      });
    });

    it("studio B's practitioner_id on a studio A appointment is rejected 23503", async () => {
      const offset = nextDayOffset();
      await expect(
        adminQuery(insertApptSql(), [
            a.studioId,
            b.practitionerId,
            a.clientId,
            serviceA,
            offset,
            hash64(),
          ]),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "appointments_practitioner_same_studio_fk",
      });
    });

    it("the three violations really do trip three DIFFERENT constraints", async () => {
      // Guards against the shortcut of forging all three references at once and
      // claiming coverage of all three keys. This does NOT assert a set literal
      // of three hand-written strings — that could not fail. It re-runs the
      // three violations and collects the constraint name Postgres actually
      // reported for each, then asserts those three OBSERVED names are
      // distinct and are exactly the three composite same-studio keys.
      const observed: string[] = [];
      const forge = async (
        practitionerId: string,
        clientId: string,
        serviceId: string,
      ) => {
        const offset = nextDayOffset();
        try {
          await adminQuery(insertApptSql(), [
              a.studioId,
              practitionerId,
              clientId,
              serviceId,
              offset,
              hash64(),
            ]);
          throw new Error("expected the insert to be rejected, but it succeeded");
        } catch (e) {
          const err = e as { code?: string; constraint?: string };
          expect(err.code).toBe("23503");
          observed.push(err.constraint ?? "(none reported)");
        }
      };

      await forge(a.practitionerId, b.clientId, serviceA); // client key
      await forge(a.practitionerId, a.clientId, serviceB); // service key
      await forge(b.practitionerId, a.clientId, serviceA); // practitioner key

      expect(observed).toHaveLength(3);
      expect(new Set(observed).size, `observed constraints: ${observed.join(", ")}`).toBe(3);
      expect([...observed].sort()).toEqual([
        "appointments_client_same_studio_fk",
        "appointments_practitioner_same_studio_fk",
        "appointments_service_same_studio_fk",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // T4.3 / T4.4 — authenticated read isolation
  // -------------------------------------------------------------------------

  describe("T4.3 appointments SELECT isolation", () => {
    it("positive control: a member of A can see A's appointment", async () => {
      await asUser(a.userId, async (q) => {
        const own = await q(`select id from public.appointments where id = $1`, [
          apptA,
        ]);
        expect(own.rowCount).toBe(1);
      });
    });

    it("negative control: the same member sees zero of B's appointments", async () => {
      await asUser(a.userId, async (q) => {
        const byId = await q(`select id from public.appointments where id = $1`, [
          apptB,
        ]);
        expect(byId.rowCount).toBe(0);
        const byStudio = await q(
          `select id from public.appointments where studio_id = $1`,
          [b.studioId],
        );
        expect(byStudio.rowCount).toBe(0);
      });
    });

    it("ground truth: B's appointment really does exist (the absence above is RLS, not a missing row)", async () => {
      const gt = await adminQuery(
        `select id from public.appointments where id = $1`,
        [apptB],
      );
      expect(gt.rowCount).toBe(1);
    });
  });

  describe("T4.4 appointment_audit SELECT isolation", () => {
    // Uses the CURRENT policy, appointment_audit_member_read (0010:280-288),
    // which reaches tenancy through the parent appointment. The future
    // studio_id-based rewrite arrives with 0174 and is not tested here.
    it("positive control: a member of A can see the audit row of A's appointment", async () => {
      await asUser(a.userId, async (q) => {
        const own = await q(
          `select id from public.appointment_audit where id = $1`,
          [auditA],
        );
        expect(own.rowCount).toBe(1);
      });
    });

    it("negative control: the same member sees zero audit rows belonging to B's appointments", async () => {
      await asUser(a.userId, async (q) => {
        const byId = await q(
          `select id from public.appointment_audit where id = $1`,
          [auditB],
        );
        expect(byId.rowCount).toBe(0);
        const byAppt = await q(
          `select id from public.appointment_audit where appointment_id = $1`,
          [apptB],
        );
        expect(byAppt.rowCount).toBe(0);
      });
    });

    it("ground truth: B's audit row really does exist", async () => {
      const gt = await adminQuery(
        `select id from public.appointment_audit where id = $1`,
        [auditB],
      );
      expect(gt.rowCount).toBe(1);
    });
  });
});

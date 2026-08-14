// MULTI-STUDIO SESSION-START AUTHORITY: 0181.
//
// THIS IS THE PRODUCTION INCIDENT REGRESSION.
//
// A practitioner active in TWO studios opened /clients/<id>/sessions/new
// (HTTP 200) and then got HTTP 500 on selecting a modality:
//
//   Failed to start session: Client not found in this studio.   digest 2140849265
//
// 0167's start_session resolved the acting studio with
// `where user_id = auth.uid() and active = true limit 1`, no studio input, no
// predicate, NO ORDER BY. The application meanwhile rendered against the user's
// SELECTED studio. Page and command disagreed, so the client the page had just
// loaded was invisible to the command.
//
// WHY THESE CASES WOULD HAVE BEEN FLAKY, NOT RED, AGAINST THE OLD COMMAND: the
// old pick was planner-dependent, so a two-studio run could pass by luck. Every
// assertion below therefore names the EXPECTED studio and the EXPECTED
// practitioner id rather than merely checking "it worked", the same discipline
// tests/db/treatment-image-multi-studio-actor.db.test.ts adopted for 0178.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

const CHECK_VIOLATION = "23514";
const COALESCE_MINUTES = 90;

/** Explicit five-argument command (what the deployed application now calls). */
const START_EXPLICIT = `select * from public.start_session($1,$2,$3,$4,$5)`;
/** Legacy four-argument signature (the migration→deploy compatibility path). */
const START_LEGACY = `select * from public.start_session($1,$2,$3,$4)`;

let A: SeededStudio;
let B: SeededStudio;
/** A THIRD studio the shared user is NOT a member of. */
let C: SeededStudio;

/** ONE human, active in BOTH A and B. */
let sharedUser: string;
let practInA: string;
let practInB: string;
let clientInA: string;
let clientInB: string;

async function sessionRow(id: string) {
  const r = await adminQuery(
    `select studio_id, client_id, practitioner_id, performed_by_practitioner_id,
            modality, appointment_id, treatment_plan_id
       from public.sessions where id = $1`,
    [id],
  );
  return r.rows[0] as {
    studio_id: string;
    client_id: string;
    practitioner_id: string;
    performed_by_practitioner_id: string;
    modality: string;
    appointment_id: string | null;
    treatment_plan_id: string | null;
  };
}

async function sessionCountFor(clientId: string): Promise<number> {
  const r = await adminQuery(
    `select count(*)::int n from public.sessions where client_id = $1 and deleted_at is null`,
    [clientId],
  );
  return (r.rows[0] as { n: number }).n;
}

/** Remove every session for a client so each case starts from a known floor. */
async function purgeSessions(clientId: string): Promise<void> {
  await adminQuery(`delete from public.sessions where client_id = $1`, [clientId]);
}

beforeAll(async () => {
  A = await seedStudio("msa-a");
  B = await seedStudio("msa-b");
  C = await seedStudio("msa-c");

  sharedUser = A.userId;
  practInA = A.practitionerId;
  clientInA = A.clientId;
  clientInB = B.clientId;

  // The shared human's SECOND active membership, this is the whole trigger.
  practInB = randomUUID();
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, 'Shared In B', $4, 'practitioner', true)`,
    [practInB, B.studioId, sharedUser, `shared-${practInB.slice(0, 8)}@harness.local`],
  );
});

afterAll(async () => {
  await closePool();
});

describe("0181 · start_session binds to the SELECTED studio", () => {
  it("DB1: explicit Studio A starts in A and attributes A's practitioner row", async () => {
    await purgeSessions(clientInA);
    const rows = await asUser(sharedUser, (q) =>
      q(START_EXPLICIT, [clientInA, "electrolysis", null, COALESCE_MINUTES, A.studioId]),
    );
    const { session_id, reused } = rows.rows[0] as {
      session_id: string;
      reused: boolean;
    };
    expect(session_id).toBeTruthy();
    expect(reused).toBe(false);

    const s = await sessionRow(session_id);
    expect(s.studio_id).toBe(A.studioId);
    expect(s.client_id).toBe(clientInA);
    // The SPECIFIC membership row for the named studio, not "some" row.
    expect(s.practitioner_id).toBe(practInA);
    expect(s.performed_by_practitioner_id).toBe(practInA);
  });

  it("DB2: explicit Studio B starts in B and attributes B's practitioner row (THE INCIDENT)", async () => {
    await purgeSessions(clientInB);
    const rows = await asUser(sharedUser, (q) =>
      q(START_EXPLICIT, [clientInB, "electrolysis", null, COALESCE_MINUTES, B.studioId]),
    );
    const { session_id, reused } = rows.rows[0] as {
      session_id: string;
      reused: boolean;
    };
    expect(session_id).toBeTruthy();
    expect(reused).toBe(false);

    const s = await sessionRow(session_id);
    expect(s.studio_id).toBe(B.studioId);
    expect(s.client_id).toBe(clientInB);
    expect(s.practitioner_id).toBe(practInB);
    expect(s.performed_by_practitioner_id).toBe(practInB);
    // The 0167 command raised "Client not found in this studio." here whenever
    // its unordered pick landed on A. It cannot any more: A is never consulted.
  });

  it("DB3: selected studio A + client B is REFUSED and inserts nothing", async () => {
    await purgeSessions(clientInB);
    const before = await sessionCountFor(clientInB);
    await expect(
      asUser(sharedUser, (q) =>
        q(START_EXPLICIT, [clientInB, "electrolysis", null, COALESCE_MINUTES, A.studioId]),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect(await sessionCountFor(clientInB)).toBe(before);
  });

  it("DB4: a studio the caller has NO active membership in is REFUSED", async () => {
    await purgeSessions(C.clientId);
    const before = await sessionCountFor(C.clientId);
    await expect(
      asUser(sharedUser, (q) =>
        q(START_EXPLICIT, [C.clientId, "electrolysis", null, COALESCE_MINUTES, C.studioId]),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect(await sessionCountFor(C.clientId)).toBe(before);

    // And naming a non-member studio for a client the caller CAN see is
    // likewise refused, p_studio_id is never taken on trust.
    await purgeSessions(clientInB);
    await expect(
      asUser(sharedUser, (q) =>
        q(START_EXPLICIT, [clientInB, "electrolysis", null, COALESCE_MINUTES, C.studioId]),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect(await sessionCountFor(clientInB)).toBe(0);
  });

  it("DB4b: an INACTIVE membership in the named studio is REFUSED", async () => {
    await purgeSessions(clientInB);
    await adminQuery(`update public.practitioners set active = false where id = $1`, [
      practInB,
    ]);
    try {
      await expect(
        asUser(sharedUser, (q) =>
          q(START_EXPLICIT, [clientInB, "electrolysis", null, COALESCE_MINUTES, B.studioId]),
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      expect(await sessionCountFor(clientInB)).toBe(0);
    } finally {
      await adminQuery(`update public.practitioners set active = true where id = $1`, [
        practInB,
      ]);
    }
  });
});

describe("0181 · appointment lineage is preserved (DB5)", () => {
  // `no_overlapping_appointments_studio_wide` is a real exclusion constraint, so
  // every fixture appointment needs its OWN window. `slot` is a distinct
  // hours-ago offset per case; reusing one would fail on the constraint rather
  // than on the lineage rule under test.
  async function makeAppointment(opts: {
    studioId: string;
    clientId: string;
    practitionerId: string | null;
    slot: number;
  }): Promise<string> {
    const id = randomUUID();
    await adminQuery(
      `insert into public.appointments
         (id, studio_id, client_id, practitioner_id, starts_at, ends_at,
          duration_minutes, status)
       values ($1,$2,$3,$4,
               now() - make_interval(hours => $5 + 1),
               now() - make_interval(hours => $5),
               60, 'confirmed')`,
      [id, opts.studioId, opts.clientId, opts.practitionerId, opts.slot],
    );
    return id;
  }

  it("DB5a: an appointment in ANOTHER studio is refused", async () => {
    await purgeSessions(clientInB);
    const apptInA = await makeAppointment({
      studioId: A.studioId,
      clientId: clientInA,
      practitionerId: practInA,
      slot: 2,
    });
    await expect(
      asUser(sharedUser, (q) =>
        q(START_EXPLICIT, [clientInB, "electrolysis", apptInA, COALESCE_MINUTES, B.studioId]),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect(await sessionCountFor(clientInB)).toBe(0);
  });

  it("DB5b: an appointment for a DIFFERENT client in the same studio is refused", async () => {
    await purgeSessions(clientInB);
    const otherClient = randomUUID();
    await adminQuery(
      `insert into public.clients (id, studio_id, name) values ($1,$2,'Other B')`,
      [otherClient, B.studioId],
    );
    const apptOther = await makeAppointment({
      studioId: B.studioId,
      clientId: otherClient,
      practitionerId: practInB,
      slot: 4,
    });
    await expect(
      asUser(sharedUser, (q) =>
        q(START_EXPLICIT, [clientInB, "electrolysis", apptOther, COALESCE_MINUTES, B.studioId]),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect(await sessionCountFor(clientInB)).toBe(0);
  });

  it("DB5c: an appointment assigned to ANOTHER practitioner is refused", async () => {
    await purgeSessions(clientInB);
    const otherPract = randomUUID();
    const otherUser = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [
      otherUser,
      `other-${otherPract.slice(0, 8)}@harness.local`,
    ]);
    await adminQuery(
      `insert into public.practitioners
         (id, studio_id, user_id, display_name, email, role, active)
       values ($1,$2,$3,'Other B Pract',$4,'practitioner',true)`,
      [otherPract, B.studioId, otherUser, `other-${otherPract.slice(0, 8)}@harness.local`],
    );
    const appt = await makeAppointment({
      studioId: B.studioId,
      clientId: clientInB,
      practitionerId: otherPract,
      slot: 6,
    });
    await expect(
      asUser(sharedUser, (q) =>
        q(START_EXPLICIT, [clientInB, "electrolysis", appt, COALESCE_MINUTES, B.studioId]),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect(await sessionCountFor(clientInB)).toBe(0);
  });

  it("DB5d: an UNASSIGNED appointment in the selected studio links and attributes correctly", async () => {
    await purgeSessions(clientInB);
    const appt = await makeAppointment({
      studioId: B.studioId,
      clientId: clientInB,
      practitionerId: null,
      slot: 8,
    });
    const rows = await asUser(sharedUser, (q) =>
      q(START_EXPLICIT, [clientInB, "electrolysis", appt, COALESCE_MINUTES, B.studioId]),
    );
    const { session_id } = rows.rows[0] as { session_id: string };
    const s = await sessionRow(session_id);
    expect(s.studio_id).toBe(B.studioId);
    expect(s.appointment_id).toBe(appt);
    expect(s.practitioner_id).toBe(practInB);
  });
});

describe("0181 · coalescing is preserved and never crosses studios (DB6)", () => {
  it("DB6a: two starts in the SAME selected studio reuse one session", async () => {
    await purgeSessions(clientInB);
    const first = await asUser(sharedUser, (q) =>
      q(START_EXPLICIT, [clientInB, "electrolysis", null, COALESCE_MINUTES, B.studioId]),
    );
    const second = await asUser(sharedUser, (q) =>
      q(START_EXPLICIT, [clientInB, "electrolysis", null, COALESCE_MINUTES, B.studioId]),
    );
    const a = first.rows[0] as { session_id: string; reused: boolean };
    const b = second.rows[0] as { session_id: string; reused: boolean };
    expect(a.reused).toBe(false);
    expect(b.reused).toBe(true);
    expect(b.session_id).toBe(a.session_id);
    expect(await sessionCountFor(clientInB)).toBe(1);
  });

  it("DB6b: a start in A never reuses a session that belongs to B", async () => {
    await purgeSessions(clientInA);
    await purgeSessions(clientInB);
    const inB = await asUser(sharedUser, (q) =>
      q(START_EXPLICIT, [clientInB, "electrolysis", null, COALESCE_MINUTES, B.studioId]),
    );
    const inA = await asUser(sharedUser, (q) =>
      q(START_EXPLICIT, [clientInA, "electrolysis", null, COALESCE_MINUTES, A.studioId]),
    );
    const bRow = inB.rows[0] as { session_id: string };
    const aRow = inA.rows[0] as { session_id: string; reused: boolean };
    expect(aRow.reused).toBe(false);
    expect(aRow.session_id).not.toBe(bRow.session_id);
    expect((await sessionRow(aRow.session_id)).studio_id).toBe(A.studioId);
    expect((await sessionRow(bRow.session_id)).studio_id).toBe(B.studioId);
  });

  it("DB6c: a different modality does not coalesce", async () => {
    await purgeSessions(clientInB);
    const e = await asUser(sharedUser, (q) =>
      q(START_EXPLICIT, [clientInB, "electrolysis", null, COALESCE_MINUTES, B.studioId]),
    );
    const l = await asUser(sharedUser, (q) =>
      q(START_EXPLICIT, [clientInB, "laser", null, COALESCE_MINUTES, B.studioId]),
    );
    expect((l.rows[0] as { reused: boolean }).reused).toBe(false);
    expect((l.rows[0] as { session_id: string }).session_id).not.toBe(
      (e.rows[0] as { session_id: string }).session_id,
    );
    expect(await sessionCountFor(clientInB)).toBe(2);
  });
});

describe("0181 · legacy four-argument compatibility (DB7)", () => {
  // THE MIGRATION-FIRST PROOF. The currently-deployed application still sends
  // four arguments between the hosted apply and the Vercel deploy. It must work
  // for BOTH memberships, and it must not depend on physical row order.
  it("DB7a: legacy call for a client in A succeeds in A", async () => {
    await purgeSessions(clientInA);
    const rows = await asUser(sharedUser, (q) =>
      q(START_LEGACY, [clientInA, "electrolysis", null, COALESCE_MINUTES]),
    );
    const { session_id } = rows.rows[0] as { session_id: string };
    const s = await sessionRow(session_id);
    expect(s.studio_id).toBe(A.studioId);
    expect(s.practitioner_id).toBe(practInA);
  });

  it("DB7b: legacy call for a client in B succeeds in B (was the 500)", async () => {
    await purgeSessions(clientInB);
    const rows = await asUser(sharedUser, (q) =>
      q(START_LEGACY, [clientInB, "electrolysis", null, COALESCE_MINUTES]),
    );
    const { session_id } = rows.rows[0] as { session_id: string };
    const s = await sessionRow(session_id);
    expect(s.studio_id).toBe(B.studioId);
    expect(s.practitioner_id).toBe(practInB);
  });

  it("DB7c: legacy call is independent of physical membership row order", async () => {
    // Rewrite both membership rows so their physical order flips, then prove the
    // answer is unchanged. Under the 0167 `limit 1` this is exactly what made
    // the defect intermittent.
    await adminQuery(
      `update public.practitioners set display_name = display_name || '.' where user_id = $1`,
      [sharedUser],
    );
    for (const [client, studio, pract] of [
      [clientInA, A.studioId, practInA],
      [clientInB, B.studioId, practInB],
    ] as const) {
      await purgeSessions(client);
      const rows = await asUser(sharedUser, (q) =>
        q(START_LEGACY, [client, "electrolysis", null, COALESCE_MINUTES]),
      );
      const s = await sessionRow((rows.rows[0] as { session_id: string }).session_id);
      expect(s.studio_id).toBe(studio);
      expect(s.practitioner_id).toBe(pract);
    }
  });

  it("DB7d: legacy call for a client the caller cannot reach is refused", async () => {
    await purgeSessions(C.clientId);
    await expect(
      asUser(sharedUser, (q) =>
        q(START_LEGACY, [C.clientId, "electrolysis", null, COALESCE_MINUTES]),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect(await sessionCountFor(C.clientId)).toBe(0);
  });
});

describe("0181 · single-studio control is unchanged", () => {
  it("a single-membership practitioner still starts sessions in their one studio", async () => {
    const solo = await seedStudio("msa-solo");
    const rows = await asUser(solo.userId, (q) =>
      q(START_EXPLICIT, [solo.clientId, "electrolysis", null, COALESCE_MINUTES, solo.studioId]),
    );
    const s = await sessionRow((rows.rows[0] as { session_id: string }).session_id);
    expect(s.studio_id).toBe(solo.studioId);
    expect(s.practitioner_id).toBe(solo.practitionerId);

    // …and through the legacy signature too.
    await purgeSessions(solo.clientId);
    const legacy = await asUser(solo.userId, (q) =>
      q(START_LEGACY, [solo.clientId, "laser", null, COALESCE_MINUTES]),
    );
    const s2 = await sessionRow((legacy.rows[0] as { session_id: string }).session_id);
    expect(s2.studio_id).toBe(solo.studioId);
    expect(s2.practitioner_id).toBe(solo.practitionerId);
  });
});

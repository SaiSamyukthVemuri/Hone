import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool } from "./helpers/harness";
import {
  seedFettStudio,
  dropFettStudio,
  type FettStudio,
} from "./helpers/fett-fixture";

// REFUSED-BOOKING ATOMICITY — a MEASURED defect, recorded in-tree as a tripwire.
//
// Codex P2 4266252488 (#874). Hone's public booking commands signal failure by
// RETURNING a result row -- 'time_unavailable', 'no_practitioner_available' --
// not by raising. A returned refusal is not an error, so the transaction
// COMMITS, including everything the function wrote before it reached the
// refusal. The new-client WRAPPERS insert the client row and only then call the
// appointment delegate, so a delegate refusal leaves that row behind.
//
// Measured on an isolated stack before this file existed:
//
//   PROBE         result=time_unavailable client_id=non-null
//   CONSENT-PROBE result=time_unavailable client_id=non-null has_consent=true
//                 source=public_booking
//
// The consent half matters more than the row: the insert carries
// `sms_consent_at` and `sms_consent_source = 'public_booking'`, so a refused
// booking commits a consent record indistinguishable from a real one. Composed
// with 0211 -- which makes consent WRITE-ONCE, never re-timed -- that record is
// also permanent, because it is the FIRST write and every later legitimate
// booking adopts it.
//
// WHY `it.fails` AND NOT RED TESTS. The fix is a `supabase/migrations/**` edit
// that is not in this change. A plain failing assertion would red the DB lane
// for every branch composing this one while fixing nothing; omitting the test
// would leave a measured defect unrecorded. `it.fails` records it and inverts:
// the moment the rollback lands, these go RED and force the flip to `it()`, so
// the fix cannot land without its proof. Coordination decision by the lane
// composing #874.
//
// `it.fails` HAS ONE SHARP EDGE, handled deliberately: it passes when the body
// fails for ANY reason, including a broken fixture, so on its own it is a
// vacuity risk of exactly the class this lane keeps finding. Two normal tests
// guard it. The PRECONDITION test proves the arrangement really produces a
// refusal, so a fixture break reds there instead of silently satisfying an
// `it.fails`. The METHOD CONTROL proves the measurement can tell a leaking
// wrapper from a non-leaking delegate: 0170 refuses without writing, and that
// test must PASS today.

const KNOWN =
  "KNOWN DEFECT: 0225/legacy refused-booking atomicity (#874 6161891231); flip to it() with the migration fix";

/** Next Wednesday 10:00 in the named zone, computed by the DATABASE so it is
 *  the database's idea of local time. Mirrors FETT_DEMO_SLOT_SQL, which hard-
 *  codes America/Los_Angeles and so cannot serve the Canadian case. */
const slotSql = (tz: string) =>
  `((date_trunc('week', (now() at time zone '${tz}'))` +
  ` + interval '9 days 10 hours') at time zone '${tz}')`;

const LA = "America/Los_Angeles";
const TORONTO = "America/Toronto";

async function setAdmission(fett: FettStudio, mode: string) {
  const r = await asUser(fett.userId, (q) =>
    q(`select * from public.set_new_client_admission_mode($1, $2)`, [
      fett.studioId,
      mode,
    ]),
  );
  expect(r.rows[0]?.outcome, `admission setter refused: ${mode}`).toBe("ok");
}

async function setTimezone(studioId: string, tz: string) {
  await adminQuery(`update public.studios set timezone = $2 where id = $1`, [
    studioId,
    tz,
  ]);
}

type Booked = { result: string; appointment_id: string | null; client_id: string | null };

/** 0225's wrapper. `consent` non-null exercises the consent columns the
 *  ordinary test helper leaves NULL at position 6 of 14. */
async function bookV2(
  fett: FettStudio,
  practitionerId: string | null,
  opts: { tz?: string; consent?: boolean } = {},
): Promise<Booked> {
  const tz = opts.tz ?? LA;
  const r = await adminQuery(
    `select * from public.create_public_appointment_for_new_client_v2(
       $1, null, $2, $3, $4, ${opts.consent ? "now()" : "null"},
       $5, ${slotSql(tz)}, $6, false, null, null, null, $7)`,
    [
      fett.studioId,
      "SYNTH-FETT refusal probe",
      `rba-${randomUUID().slice(0, 8)}@synth.local`,
      "+15555550144",
      fett.services.treatmentId,
      randomBytes(32).toString("hex"),
      practitionerId,
    ],
  );
  return r.rows[0] as Booked;
}

/** 0204's LEGACY wrapper — 13 arguments, no practitioner, same
 *  insert-then-delegate shape. Verified from source: the client insert is at
 *  0204:670 and `create_public_appointment` is called at 0204:730. */
async function bookLegacy(
  fett: FettStudio,
  opts: { tz?: string; consent?: boolean } = {},
): Promise<Booked> {
  const tz = opts.tz ?? LA;
  const r = await adminQuery(
    `select * from public.create_public_appointment_for_new_client(
       $1, null, $2, $3, $4, ${opts.consent ? "now()" : "null"},
       $5, ${slotSql(tz)}, $6, false, null, null, null)`,
    [
      fett.studioId,
      "SYNTH-FETT legacy refusal probe",
      `rba-legacy-${randomUUID().slice(0, 8)}@synth.local`,
      "+15555550145",
      fett.services.treatmentId,
      randomBytes(32).toString("hex"),
    ],
  );
  return r.rows[0] as Booked;
}

async function countClients(studioId: string) {
  return Number(
    (
      await adminQuery(
        `select count(*) n from public.clients where studio_id = $1`,
        [studioId],
      )
    ).rows[0].n,
  );
}

async function countAppointments(studioId: string) {
  return Number(
    (
      await adminQuery(
        `select count(*) n from public.appointments where studio_id = $1`,
        [studioId],
      )
    ).rows[0].n,
  );
}

afterAll(async () => {
  await closePool();
});

describe("refused-booking atomicity", () => {
  it("PRECONDITION: the arrangement really refuses, and writes no appointment", async () => {
    // The companion that keeps every `it.fails` below honest. If the fixture
    // stops producing a refusal -- wrong slot, closed admission, ineligible
    // practitioner -- this reds HERE, rather than satisfying an `it.fails` for
    // a reason that has nothing to do with atomicity.
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      await setAdmission(fett, "open");
      const p = fett.treating[0].practitionerId;
      const first = await bookV2(fett, p);
      expect(first.result, "the arranging booking must succeed").toBe("created");

      const before = await countAppointments(fett.studioId);
      const second = await bookV2(fett, p);
      expect(second.result, "the same practitioner at the same instant").toBe(
        "time_unavailable",
      );
      expect(second.appointment_id).toBeNull();
      expect(
        await countAppointments(fett.studioId),
        "a refusal must write no appointment -- that half is correct today",
      ).toBe(before);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("METHOD CONTROL: create_public_appointment (0170) refuses WITHOUT writing", async () => {
    // The discriminating control. 0170 is the DELEGATE, not a wrapper: it has
    // no `insert into public.clients` at all, and every one of its refusals
    // returns before its appointment/audit inserts (0170:49-146 vs 257/271).
    // So the leak is a property of the WRAPPERS, not of refusal-by-return in
    // general -- and this test must PASS, proving the measurement below
    // distinguishes the two rather than flagging every refusal path.
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      await setAdmission(fett, "open");
      const first = await bookV2(fett, fett.treating[0].practitionerId);
      expect(first.result).toBe("created");
      const clientId = first.client_id;
      expect(clientId).not.toBeNull();

      const clientsBefore = await countClients(fett.studioId);
      const apptsBefore = await countAppointments(fett.studioId);

      // Same client, same occupied instant, straight at the delegate.
      const r = await adminQuery(
        `select * from public.create_public_appointment(
           $1, $2, $3, ${slotSql(LA)}, $4, null, null)`,
        [
          fett.studioId,
          clientId,
          fett.services.treatmentId,
          randomBytes(32).toString("hex"),
        ],
      );
      expect(r.rows[0].result).not.toBe("created");
      expect(await countClients(fett.studioId)).toBe(clientsBefore);
      expect(await countAppointments(fett.studioId)).toBe(apptsBefore);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it.fails(`0225 leaves NO client row on a refusal — ${KNOWN}`, async () => {
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      await setAdmission(fett, "open");
      const p = fett.treating[0].practitionerId;
      expect((await bookV2(fett, p)).result).toBe("created");

      const before = await countClients(fett.studioId);
      const refused = await bookV2(fett, p);
      expect(refused.result).toBe("time_unavailable");
      // THE DEFECT: a refused booking must not create a client.
      expect(refused.client_id).toBeNull();
      expect(await countClients(fett.studioId)).toBe(before);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it.fails(`0225 records NO SMS consent on a refusal — ${KNOWN}`, async () => {
    // The half that is not merely an orphan. `sms_consent_source` is written as
    // 'public_booking', the same value a genuine stamp writes, so the record
    // carries no trace of the refusal -- and under 0211's write-once rule it is
    // the first write and therefore the permanent one.
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      await setAdmission(fett, "open");
      const p = fett.treating[0].practitionerId;
      expect((await bookV2(fett, p, { consent: true })).result).toBe("created");

      const refused = await bookV2(fett, p, { consent: true });
      expect(refused.result).toBe("time_unavailable");
      const consented = Number(
        (
          await adminQuery(
            `select count(*) n from public.clients
              where studio_id = $1 and sms_consent_at is not null
                and name = 'SYNTH-FETT refusal probe'`,
            [fett.studioId],
          )
        ).rows[0].n,
      );
      // THE DEFECT: exactly one consent record -- the booking that succeeded.
      expect(consented).toBe(1);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it.fails(
    `0204 (legacy, no practitioner) leaves NO client row on a refusal — ${KNOWN}`,
    async () => {
      // SAME SHAPE, OLDER COMMAND, and its own comment says so: 0204 is
      // documented as "Ordinary NEW-client booking as ONE commit ... Guarding
      // only the appointment command would have left an orphan client for a
      // refused request." It was written to prevent this orphan and has it
      // anyway, because the delegate's refusal is RETURNED as a row rather
      // than raised. So the fix belongs in both wrappers, not only in 0225.
      const fett = await seedFettStudio({ treatingCount: 2 });
      try {
        await setAdmission(fett, "open");
        expect((await bookLegacy(fett)).result).toBe("created");

        const before = await countClients(fett.studioId);
        const refused = await bookLegacy(fett);
        expect(refused.result).not.toBe("created");
        expect(await countClients(fett.studioId)).toBe(before);
      } finally {
        await dropFettStudio(fett);
      }
    },
  );

  for (const tz of [LA, TORONTO]) {
    it.fails(
      `${tz}: a refused booking leaves no client row — ${KNOWN}`,
      async () => {
        // The leak is on a path whose local-date handling differs by studio
        // timezone, and the fixture pins LA explicitly (the studios column
        // default is America/Toronto). Both zones are exercised so the fix
        // cannot be proved in one and broken in the other: the slot is "next
        // Wednesday 10:00 local", inside the fixture's Mon-Fri 09:00-17:00
        // window in either zone.
        const fett = await seedFettStudio({ treatingCount: 2 });
        try {
          await setTimezone(fett.studioId, tz);
          await setAdmission(fett, "open");
          const p = fett.treating[0].practitionerId;
          expect((await bookV2(fett, p, { tz })).result).toBe("created");

          const before = await countClients(fett.studioId);
          const refused = await bookV2(fett, p, { tz });
          expect(refused.result).toBe("time_unavailable");
          expect(await countClients(fett.studioId)).toBe(before);
        } finally {
          await dropFettStudio(fett);
        }
      },
    );
  }
});

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
// the moment the rollback lands, these go RED and force the flip to `it()`.
//
// =====================================================================
// WHY EVERY ARRANGEMENT LIVES IN A HOOK — Codex P2 4270794367.
// =====================================================================
//
// The first version of this file put the arranging bookings INSIDE each
// `it.fails` body. That is a false-positive generator, and Codex named the
// consequence exactly: if the wrapper or its fixture stops producing the
// initial successful booking, the arranging assertion throws, the body fails,
// and `it.fails` reports PASSING without ever reaching the atomicity
// assertion -- so the tripwire could stay green even AFTER the rollback fix
// lands, which is the one thing it exists to prevent. A single PRECONDITION
// test over `bookV2` did not cover it, because the legacy scenario never
// called `bookV2` at all.
//
// So the structure now guarantees what a comment cannot:
//
//   * every arrangement runs in `beforeAll`. A hook that throws is reported by
//     vitest as a SUITE error -- it cannot be absorbed by `it.fails`;
//   * each scenario's `it()` asserts the arrangement held: booked, then
//     refused with the precise `time_unavailable`, and no appointment written;
//   * each `it.fails` body is a SYNCHRONOUS one-line comparison of numbers the
//     hook already captured. There is nothing in it that can throw, so the only
//     way it can fail is the atomicity assertion itself;
//   * the captured counts start at -1, so a hook that silently did not run
//     makes the comparison hold, which makes `it.fails` go RED. The degenerate
//     case fails loudly rather than passing quietly.
//
// A GREEN RUN HERE IS NOT A FIX. Five of these are inverted: green means the
// defect is still present and still measured. It is not "solved", it is not
// "production-safe", and it does not authorize an apply. The suite turns red
// when the defect is fixed, and that red is the signal to flip each `it.fails`
// to `it()`.

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
  if (r.rows[0]?.outcome !== "ok") {
    throw new Error(`admission setter refused: ${mode}`);
  }
}

async function setTimezone(studioId: string, tz: string) {
  await adminQuery(`update public.studios set timezone = $2 where id = $1`, [
    studioId,
    tz,
  ]);
}

type Booked = {
  result: string;
  appointment_id: string | null;
  client_id: string | null;
};

type BookOpts = {
  tz?: string;
  consent?: boolean;
  name?: string;
  clientId?: string | null;
};

/** 0225's wrapper. `consent` exercises the consent columns the ordinary test
 *  helper leaves NULL at position 6 of 14. `clientId` non-null makes the
 *  wrapper SKIP its insert (`v_client_id := p_client_id` at 0225:131 guards the
 *  resolve-or-create block at :280), which is the existing-client control. */
async function bookV2(
  fett: FettStudio,
  practitionerId: string | null,
  opts: BookOpts = {},
): Promise<Booked> {
  const tz = opts.tz ?? LA;
  const r = await adminQuery(
    `select * from public.create_public_appointment_for_new_client_v2(
       $1, $8, $2, $3, $4, ${opts.consent ? "now()" : "null"},
       $5, ${slotSql(tz)}, $6, false, null, null, null, $7)`,
    [
      fett.studioId,
      opts.name ?? "SYNTH-FETT v2 probe",
      `rba-${randomUUID().slice(0, 8)}@synth.local`,
      "+15555550144",
      fett.services.treatmentId,
      randomBytes(32).toString("hex"),
      practitionerId,
      opts.clientId ?? null,
    ],
  );
  return r.rows[0] as Booked;
}

/** 0204's LEGACY wrapper — 13 arguments, no practitioner, same
 *  insert-then-delegate shape. Verified from source: the client insert is at
 *  0204:670 and `create_public_appointment` is called at 0204:730. */
async function bookLegacy(
  fett: FettStudio,
  _practitionerId: string | null,
  opts: BookOpts = {},
): Promise<Booked> {
  const tz = opts.tz ?? LA;
  const r = await adminQuery(
    `select * from public.create_public_appointment_for_new_client(
       $1, null, $2, $3, $4, ${opts.consent ? "now()" : "null"},
       $5, ${slotSql(tz)}, $6, false, null, null, null)`,
    [
      fett.studioId,
      opts.name ?? "SYNTH-FETT legacy probe",
      `rba-legacy-${randomUUID().slice(0, 8)}@synth.local`,
      "+15555550145",
      fett.services.treatmentId,
      randomBytes(32).toString("hex"),
    ],
  );
  return r.rows[0] as Booked;
}

const countClients = async (studioId: string) =>
  Number(
    (
      await adminQuery(
        `select count(*) n from public.clients where studio_id = $1`,
        [studioId],
      )
    ).rows[0].n,
  );

const countAppointments = async (studioId: string) =>
  Number(
    (
      await adminQuery(
        `select count(*) n from public.appointments where studio_id = $1`,
        [studioId],
      )
    ).rows[0].n,
  );

/** Consent records written by THIS scenario's probe name, so the fixture's own
 *  rows cannot be mistaken for the leak. */
const countConsented = async (studioId: string, name: string) =>
  Number(
    (
      await adminQuery(
        `select count(*) n from public.clients
          where studio_id = $1 and name = $2 and sms_consent_at is not null`,
        [studioId, name],
      )
    ).rows[0].n,
  );

afterAll(async () => {
  await closePool();
});

/**
 * One scenario: arrange in the hook, assert the arrangement normally, invert
 * ONLY the persisted-count assertion.
 *
 * Declared as a factory so the structure itself enforces the rule — a scenario
 * cannot be added with an `it.fails` and no PRECONDITION companion, which is
 * how the first version of this file drifted.
 */
function atomicityScenario(spec: {
  label: string;
  wrapper: typeof bookV2;
  tz: string;
  consent: boolean;
  name: string;
  /**
   * Is the wrapper under test FIXED yet?
   *
   * 0225's rollback has landed, so its scenarios assert atomicity POSITIVELY --
   * the five assertions that were inverted here went red the moment the fix
   * applied, which is exactly what the tripwire was for, and leaving them
   * inverted would now assert that the defect is still present.
   *
   * 0204's repair is a NEW FORWARD MIGRATION (0204 is applied and frozen) and is
   * not in this head, so the legacy scenario stays inverted and still measures a
   * real, unfixed leak.
   */
  fixed: boolean;
}) {
  describe(spec.label, () => {
    let fett: FettStudio;
    let first: Booked;
    let refused: Booked;
    // -1 sentinels: a hook that silently did not run makes the inverted
    // comparisons HOLD, which turns `it.fails` red. Degenerate loudly.
    let clientsBefore = -1;
    let clientsAfter = -1;
    let apptsBefore = -1;
    let apptsAfter = -1;
    let consented = -1;

    beforeAll(async () => {
      fett = await seedFettStudio({ treatingCount: 2 });
      await setTimezone(fett.studioId, spec.tz);
      await setAdmission(fett, "open");
      // The legacy wrapper takes no practitioner; the v2 one is scoped so the
      // refusal is the SAME practitioner at the SAME instant.
      const p = spec.wrapper === bookV2 ? fett.treating[0].practitionerId : null;
      const o = { tz: spec.tz, consent: spec.consent, name: spec.name };
      first = await spec.wrapper(fett, p, o);
      clientsBefore = await countClients(fett.studioId);
      apptsBefore = await countAppointments(fett.studioId);
      refused = await spec.wrapper(fett, p, o);
      clientsAfter = await countClients(fett.studioId);
      apptsAfter = await countAppointments(fett.studioId);
      consented = await countConsented(fett.studioId, spec.name);
    });

    afterAll(async () => {
      if (fett) await dropFettStudio(fett);
    });

    it("PRECONDITION: booked, then refused with time_unavailable, no appointment written", () => {
      expect(first.result, "the arranging booking must succeed").toBe("created");
      expect(first.appointment_id).not.toBeNull();
      expect(refused.result, "the second attempt must be refused").toBe(
        "time_unavailable",
      );
      expect(refused.appointment_id).toBeNull();
      expect(
        apptsAfter,
        "a refusal must write no appointment -- that half is correct today",
      ).toBe(apptsBefore);
    });

    const assertAtomic = spec.fixed ? it : it.fails;
    const suffix = spec.fixed ? "" : ` — ${KNOWN}`;

    assertAtomic(`persists NO client row from the refusal${suffix}`, () => {
      expect(clientsAfter).toBe(clientsBefore);
    });

    if (spec.consent) {
      assertAtomic(`records NO SMS consent from the refusal${suffix}`, () => {
        // One consent record: the booking that actually happened.
        expect(consented).toBe(1);
      });
    }
  });
}

describe("refused-booking atomicity", () => {
  // ---- NORMAL CONTROLS. These must PASS today, and they are what makes the
  // ---- inverted assertions above mean something specific.

  describe("controls", () => {
    let fett: FettStudio;
    let created: Booked;
    let delegateRefusal: string | null = null;
    let clientsBefore = -1;
    let clientsAfterDelegate = -1;
    let apptsBefore = -1;
    let apptsAfterDelegate = -1;
    let existingRefusal: string | null = null;
    let clientsAfterExisting = -1;

    beforeAll(async () => {
      fett = await seedFettStudio({ treatingCount: 2 });
      await setAdmission(fett, "open");
      created = await bookV2(fett, fett.treating[0].practitionerId, {
        name: "SYNTH-FETT control",
      });
      clientsBefore = await countClients(fett.studioId);
      apptsBefore = await countAppointments(fett.studioId);

      // METHOD CONTROL — straight at the DELEGATE with an occupied instant.
      const d = await adminQuery(
        `select * from public.create_public_appointment(
           $1, $2, $3, ${slotSql(LA)}, $4, null, null)`,
        [
          fett.studioId,
          created.client_id,
          fett.services.treatmentId,
          randomBytes(32).toString("hex"),
        ],
      );
      delegateRefusal = d.rows[0].result as string;
      clientsAfterDelegate = await countClients(fett.studioId);
      apptsAfterDelegate = await countAppointments(fett.studioId);

      // EXISTING-CLIENT CONTROL — the wrapper with a PRE-RESOLVED client, so
      // it skips its own insert entirely.
      const e = await bookV2(fett, fett.treating[0].practitionerId, {
        clientId: created.client_id,
        name: "SYNTH-FETT control",
      });
      existingRefusal = e.result;
      clientsAfterExisting = await countClients(fett.studioId);
    });

    afterAll(async () => {
      if (fett) await dropFettStudio(fett);
    });

    it("METHOD CONTROL: create_public_appointment (0170) refuses WITHOUT writing", () => {
      // 0170 is the DELEGATE, not a wrapper: it has no `insert into
      // public.clients` at all, and every refusal returns before its
      // appointment/audit inserts (0170:49-146 vs 257/271). This passing is
      // what shows the leak is a property of the WRAPPERS rather than of
      // refusal-by-return in general -- without it, the inverted assertions
      // would be consistent with "every refusal path writes something".
      expect(delegateRefusal).not.toBe("created");
      expect(clientsAfterDelegate).toBe(clientsBefore);
      expect(apptsAfterDelegate).toBe(apptsBefore);
    });

    it("EXISTING-CLIENT CONTROL: a pre-resolved client is not duplicated by a refusal", () => {
      // Isolates the defect to the wrapper CREATING the client. With
      // p_client_id supplied, `v_client_id` is non-null so the resolve-or-create
      // block is skipped, and a refusal has nothing of its own to leave behind.
      expect(existingRefusal).not.toBe("created");
      expect(clientsAfterExisting).toBe(clientsBefore);
    });

    it("records what is NOT covered, rather than implying it is", () => {
      // The INVITED path (p_entry_id non-null) routes to 0195's conversion
      // instead of create_public_appointment_v2, and arranging a redeemable
      // invitation needs a waitlist fixture this file does not build. It is
      // therefore UNPROVEN here, not proven safe: 0204 and 0225 both insert the
      // client BEFORE branching on p_entry_id, so the same shape is present on
      // that path by inspection. Stated so a green run cannot be read as
      // covering it.
      expect(true).toBe(true);
    });
  });

  // ---- THE INVERTED, MEASURED DEFECT. LA/Toronto and opt-in/no-opt-in.

  atomicityScenario({
    label: "0225 — LA, SMS consent opted in",
    wrapper: bookV2,
    tz: LA,
    consent: true,
    name: "SYNTH-FETT v2 la consent",
    fixed: true,
  });

  atomicityScenario({
    label: "0225 — LA, no consent",
    wrapper: bookV2,
    tz: LA,
    consent: false,
    name: "SYNTH-FETT v2 la plain",
    fixed: true,
  });

  atomicityScenario({
    label: "0225 — Toronto, SMS consent opted in",
    wrapper: bookV2,
    tz: TORONTO,
    consent: true,
    name: "SYNTH-FETT v2 toronto consent",
    fixed: true,
  });

  // 0204 shares the shape, and its own comment says it was written to stop
  // exactly this: "Guarding only the appointment command would have left an
  // orphan client for a refused request." It has the orphan anyway, because the
  // delegate's refusal is RETURNED as a row rather than raised. So the fix
  // belongs in BOTH wrappers.
  atomicityScenario({
    label: "0204 legacy — LA, SMS consent opted in",
    wrapper: bookLegacy,
    tz: LA,
    consent: true,
    name: "SYNTH-FETT legacy la consent",
    // 0204 is APPLIED and frozen, so its repair is the FORWARD migration
    // 0228_legacy_new_client_refusal_atomicity.sql rather than an edit. With
    // that in the chain this scenario asserts atomicity positively, like the
    // 0225 ones -- and it went red while still inverted the moment 0228
    // applied, which is the tripwire doing its job rather than a surprise.
    fixed: true,
  });
});

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { normalizePhoneForMatch } from "@/lib/sms/phone";

// ===========================================================================
// G1 / #914 — THE EXISTING-CLIENT SMS CONSENT GATE ON THE PUBLIC BOOKING PATH.
// ===========================================================================
//
// This drives the REAL `publicBookAppointmentAction` for an EXISTING client and
// asserts WHO MAY BE OPTED IN TO SMS, which is an anti-abuse property, not a
// formatting one. `app/book/[slug]/actions.ts:1494-1501` states the rule:
//
//   1. the client must not already be opted out (STOP is sticky);
//   2. the submitted phone must normalize to the same digits as the STORED
//      phone — "without this, anyone who knows a real client's email could opt
//      them into SMS by typing a different phone number on the public form";
//   3. an already-set `sms_consent_at` is never overwritten.
//
// WHY THESE TESTS EXIST AT THIS LEVEL. The booking-path gate was uncovered.
// `tests/db/refused-booking-atomicity.db.test.ts` owns 0225's refusal
// atomicity (including its SMS-consent scenarios) and records the legacy path
// as a KNOWN DEFECT; `tests/db/waitlist-*-sms-consent-*.db.test.ts` own the
// WAITLIST path. None of them drive this action, and a repo-wide search for
// `normalizePhoneForMatch` in tests/ reaches only the inbound-STOP webhook and
// a migration guard. So the gate above was asserted nowhere.
//
// WHAT THIS FILE IS NOT. It is not a proof that the DATABASE enforces any of
// this: the stamp's own `.is("sms_consent_at", null).is("sms_opted_out_at",
// null)` predicates are emulated by the mock below, deliberately, so that the
// ACTION's gate can be measured on its own. The database half belongs to 0211's
// write-once guard and its migration test. Nor does it cover the NEW-client
// branch, which stamps on a different rule (actions.ts:1555) and is stated here
// as uncovered rather than implied safe.

const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const APPT_ID = "66666666-6666-4666-8666-666666666666";
const SLUG = "legacy-studio";
const CLIENT_EMAIL = "returning@example.test";

// THE CLOCK IS FROZEN AND THE INSTANT IS DERIVED FROM IT, never hard-coded.
// `actions.ts:1099` refuses a start at or before `Date.now()`, and two suites in
// this very directory (invitation-conversion, invitation-fail-closed) went red
// on EVERY branch — production included — because they pinned an absolute
// future instant that the calendar caught up with. A start computed from the
// frozen now cannot rot.
const FROZEN_NOW = new Date("2026-10-01T12:00:00.000Z");
const START = new Date(FROZEN_NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
const START_ISO = START.toISOString();

// The SAME subscriber, written two ways. The positive case must prove
// NORMALIZATION, not string equality — a fixture whose stored and submitted
// phones are byte-identical would pass with the normalizer deleted.
const STORED_PHONE = "+1 (555) 010-1234";
const SUBMITTED_PHONE_EQUIVALENT = "555-010-1234";
// A genuinely different subscriber: the attacker's number.
const SUBMITTED_PHONE_OTHER = "555-010-9999";

const rpcCalls: string[] = [];
/** Every `clients` UPDATE payload the action issued, in order. */
const clientUpdates: Array<Record<string, unknown>> = [];
/** ONE interleaved log of both kinds of effect. Two separate arrays cannot
 *  express "the stamp came after the command" — each only knows its own order —
 *  so ordering is read from this. */
const sequence: string[] = [];

const scenario = {
  storedPhone: STORED_PHONE as string | null,
  storedConsentAt: null as string | null,
  storedOptedOutAt: null as string | null,
  bookingResult: "created" as string,
};

function existingClientRow() {
  return {
    id: CLIENT_ID,
    name: "Returning Client",
    email: CLIENT_EMAIL,
    phone: scenario.storedPhone,
    sms_consent_at: scenario.storedConsentAt,
    sms_opted_out_at: scenario.storedOptedOutAt,
  };
}

function makeChain(table: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain as never;
  let selected = "";
  let updatePayload: Record<string, unknown> | null = null;

  const settle = () => {
    // The consent stamp awaits the UPDATE chain directly. Emulate the database
    // predicates it relies on: the write lands only when nothing is on record
    // and the client has not opted out.
    if (table === "clients" && updatePayload) {
      const free = scenario.storedConsentAt === null && scenario.storedOptedOutAt === null;
      return { data: free ? [{ sms_consent_at: updatePayload.sms_consent_at }] : [], error: null };
    }
    if (table === "studio_availability_default") {
      return {
        data: [
          { is_open: true, open_time: "06:00", close_time: "22:00" },
          { is_open: true, open_time: "06:00", close_time: "22:00" },
        ],
        error: null,
      };
    }
    if (table === "services") return { count: 3, data: [], error: null };
    return { data: null, error: null, count: 0 };
  };

  Object.assign(chain, {
    select: (cols?: string) => {
      if (typeof cols === "string") selected = cols;
      return chain as never;
    },
    eq: self,
    is: self,
    not: self,
    in: self,
    order: self,
    limit: self,
    update: (payload: Record<string, unknown>) => {
      if (table === "clients") {
        updatePayload = payload;
        clientUpdates.push(payload);
        if ("sms_consent_at" in payload) sequence.push("stamp");
      }
      return chain;
    },
    insert: () => chain,
    upsert: () => chain,
    delete: () => chain,
    maybeSingle: async () => {
      if (table === "services") {
        return {
          data: {
            id: SERVICE_ID,
            studio_id: STUDIO_ID,
            name: "Consultation",
            modality: "consultation",
            default_duration_minutes: 45,
            active: true,
          },
          error: null,
        };
      }
      if (table === "clients") {
        // Two different reads hit this table. The existing-client LOOKUP asks
        // for the identity columns; the consent stamp's fallback read asks only
        // for the two consent columns. Serving one shape for both would let the
        // stamp mistake a lookup for its own re-read.
        if (selected.includes("sms_opted_out_at") && !selected.includes("id")) {
          return {
            data: {
              sms_consent_at: scenario.storedConsentAt,
              sms_opted_out_at: scenario.storedOptedOutAt,
            },
            error: null,
          };
        }
        return { data: existingClientRow(), error: null };
      }
      return { data: null, error: null };
    },
    single: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
  });
  return chain;
}

const admin = {
  from: (table: string) => makeChain(table),
  rpc: async (fn: string, args: Record<string, unknown> = {}) => {
    rpcCalls.push(fn);
    if (fn === "create_public_appointment") sequence.push("book");
    if (fn === "create_public_appointment") {
      return {
        data: [
          {
            result: scenario.bookingResult,
            client_id: (args.p_client_id as string | null) ?? CLIENT_ID,
            appointment_id: scenario.bookingResult === "created" ? APPT_ID : null,
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      };
    }
    return { data: null, error: null };
  },
};

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => admin }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitPublicBooking: async () => ({ allowed: true }),
  limitPublicSlots: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: () => "https://studio.example.test",
}));
vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => ({
    id: STUDIO_ID,
    slug: SLUG,
    name: "Legacy Studio",
    owner_email: "owner@studio.test",
    timezone: "America/Toronto",
    default_appointment_duration_minutes: 45,
    buffer_minutes: 0,
    public_booking_horizon_months: 6,
    send_confirmation_emails: false,
    show_treatment_time_to_clients: false,
    notify_practitioner_on_new_booking: false,
    // THE LEGACY STUDIO, explicitly: capacity OFF forces public assignment OFF
    // (0136's CHECK), which is the state ops asked this to be proven in.
    practitioner_capacity_enabled: false,
    practitioner_capacity_booking_enabled: false,
  }),
}));
vi.mock("@/lib/booking/slots", () => ({
  getAvailableSlots: async () => [
    { start: START_ISO, end: new Date(START.getTime() + 45 * 60_000).toISOString() },
  ],
  filterFutureSlots: (s: unknown[]) => s,
}));
vi.mock("@/lib/booking/readiness", () => ({
  isPubliclyBookable: () => true,
  UNAVAILABLE_PUBLIC_BOOKING_MESSAGE: "unavailable",
}));
vi.mock("@/lib/booking/horizon", () => ({
  isWithinPublicBookingHorizon: () => true,
  horizonRangeInStudioTz: () => ({ min: "2020-01-01", max: "2030-01-01" }),
  maxPublicBookingHorizonDays: () => 400,
}));
vi.mock("@/lib/intake/queries", () => ({
  ensureIntakeForClient: async () => ({
    id: "intake-1",
    url: "https://studio.example.test/intake/abc",
  }),
}));
vi.mock("@/lib/treatment-time/queries", () => ({
  buildTreatmentTimeLine: () => null,
  getTreatmentTimeContextForEmail: async () => ({ sessionCount: 0, totalMinutes: 0 }),
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: async () => ({ ok: true }),
  sendBookingNotificationToPractitioner: async () => ({ ok: true }),
  recordEmailAttempt: async () => {},
  logEmailFailure: () => {},
}));
vi.mock("@/lib/sms/send-appointment", () => ({
  sendBookingConfirmationSmsToClient: async () => ({ ok: false, skipped: true }),
}));
vi.mock("@/lib/conversion/dispatch", () => ({ dispatchBookingConversion: async () => {} }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: () => {} }));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: () => {},
}));

const { publicBookAppointmentAction } = await import("@/app/book/[slug]/actions");

function form(over: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("slug", SLUG);
  fd.set("service_id", SERVICE_ID);
  fd.set("starts_at", START_ISO);
  fd.set("name", "Returning Client");
  fd.set("email", CLIENT_EMAIL);
  fd.set("phone", SUBMITTED_PHONE_EQUIVALENT);
  fd.set("client_type", "existing");
  fd.set("sms_consent", "true");
  for (const [k, v] of Object.entries(over)) {
    if (v === "") fd.delete(k);
    else fd.set(k, v);
  }
  return fd;
}

const booked = () => rpcCalls.includes("create_public_appointment");
/** The consent stamp is the only `clients` update carrying `sms_consent_at`. */
const consentStamps = () => clientUpdates.filter((u) => "sms_consent_at" in u);

beforeEach(() => {
  // Only `Date` is faked; faking timers wholesale would stall the action's
  // awaited promises.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN_NOW);
  rpcCalls.length = 0;
  clientUpdates.length = 0;
  sequence.length = 0;
  Object.assign(scenario, {
    storedPhone: STORED_PHONE,
    storedConsentAt: null,
    storedOptedOutAt: null,
    bookingResult: "created",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the fixture's own discriminator", () => {
  // WITHOUT THESE TWO, every assertion below could hold for the wrong reason:
  // if the normalizer did not equate the two formats the positive case would
  // fail while the product was correct, and if it equated the attacker's number
  // the anti-abuse case would pass vacuously.
  it("equates the SAME subscriber written two ways", () => {
    expect(normalizePhoneForMatch(STORED_PHONE)).toBe(
      normalizePhoneForMatch(SUBMITTED_PHONE_EQUIVALENT),
    );
    expect(normalizePhoneForMatch(STORED_PHONE)).not.toBe("");
  });
  it("does NOT equate a different subscriber", () => {
    expect(normalizePhoneForMatch(STORED_PHONE)).not.toBe(
      normalizePhoneForMatch(SUBMITTED_PHONE_OTHER),
    );
  });
});

describe("POSITIVE: a legacy booking with SMS consent records it", () => {
  it("commits the booking AND stamps consent, sourced to public_booking", async () => {
    const r = await publicBookAppointmentAction(form());
    expect(r.ok, "the booking itself must succeed").toBe(true);
    expect(booked()).toBe(true);

    const stamps = consentStamps();
    expect(stamps.length, "consent must be recorded exactly once").toBe(1);
    // THE SOURCE IS PART OF THE PROPERTY. A stamp with no provenance cannot be
    // audited later, and 0211 treats consent as write-once evidence.
    expect(stamps[0].sms_consent_source).toBe("public_booking");
    // Stamped at the frozen now, so this also pins "the stamp is the time of
    // the booking" rather than some default.
    expect(stamps[0].sms_consent_at).toBe(FROZEN_NOW.toISOString());
  });
});

describe("ANTI-ABUSE: the submitted phone must be the client's own", () => {
  it("a DIFFERENT phone books normally but records NO consent", async () => {
    const r = await publicBookAppointmentAction(
      form({ phone: SUBMITTED_PHONE_OTHER }),
    );
    // The booking is NOT punished — declining to stamp must not break booking.
    expect(r.ok, "a phone mismatch must not block the booking").toBe(true);
    expect(booked()).toBe(true);
    expect(
      consentStamps(),
      "knowing the email must not be enough to opt someone into SMS",
    ).toEqual([]);
  });

  it("an ABSENT phone is refused outright, so it cannot dodge the match", async () => {
    // The empty string deletes the field: a form post with NO phone, which is
    // the shape that would avoid having to guess the stored one. MEASURED, and
    // it corrected this test's first premise — `actions.ts:921` makes a phone
    // MANDATORY for public booking, so the attempt never reaches the consent
    // gate at all. Asserted as a refusal rather than quietly relaxed, because
    // "no consent was stamped" is true here for a STRONGER reason than the
    // gate: there is no booking.
    const r = await publicBookAppointmentAction(form({ phone: "" }));
    expect(r.ok, "a public booking with no phone must be refused").toBe(false);
    expect(booked(), "it must not reach the booking command").toBe(false);
    expect(consentStamps()).toEqual([]);
  });

  it("a client with NO STORED phone cannot be opted in", async () => {
    scenario.storedPhone = null;
    const r = await publicBookAppointmentAction(form());
    expect(r.ok).toBe(true);
    expect(
      consentStamps(),
      "an empty stored phone must not match a submitted one",
    ).toEqual([]);
  });
});

describe("STOP is sticky, and consent is write-once", () => {
  it("an opted-OUT client is not re-opted-in by a consented booking", async () => {
    scenario.storedOptedOutAt = "2026-09-01T00:00:00.000Z";
    const r = await publicBookAppointmentAction(form());
    expect(r.ok).toBe(true);
    expect(
      consentStamps(),
      "a prior STOP must survive a later consented booking",
    ).toEqual([]);
  });

  it("an already-consented client is not re-timed", async () => {
    const earlier = "2026-09-01T00:00:00.000Z";
    scenario.storedConsentAt = earlier;
    await publicBookAppointmentAction(form());
    // The action may ATTEMPT the conditional write — that is the documented
    // design (a conditional first write, adopting the row when it loses) — so
    // the property is that nothing is OVERWRITTEN, which the predicates
    // enforce. Asserting "no attempt" would pin the implementation instead.
    for (const u of consentStamps()) {
      expect(u.sms_consent_at, "the earlier consent must stand").not.toBe(earlier);
    }
    expect(scenario.storedConsentAt).toBe(earlier);
  });
});

// ===========================================================================
// MEASURED GAP — CONSENT IS STAMPED BEFORE THE BOOKING COMMITS.
// ===========================================================================
//
// I wrote these two expecting "no consent without a committed booking" and both
// failed. The failure is NOT the mock: in the source the stamp is at
// `app/book/[slug]/actions.ts:1517` and the existing-client booking command at
// `:1678` — 161 lines LATER — so the order below is what the code does.
//
// CONSEQUENCE, stated without inflation. This is NOT a security hole: the
// client ticked the box themselves and the phone-match gate above still had to
// pass, so nobody is opted in against their will. What it does mean is that a
// booking which then REFUSES (slot taken) leaves `sms_consent_at` recorded. And
// because 0211 makes consent WRITE-ONCE, that refused attempt's timestamp
// becomes the permanent record — a later successful booking cannot correct it.
//
// WHETHER THAT SHOULD CHANGE IS THE CONSENT OWNER'S CALL, NOT MINE. The person
// did consent, so "stamp it" is a defensible reading; "consent belongs to a
// booking that happened" is the other. I am not reordering a consent write on
// my own judgement — that is the mistake I made once already by changing a
// charge-path gate that belonged to the billing owner.
//
// So these assert the OBSERVED behaviour and act as a TRIPWIRE: if the order is
// ever fixed, both go red and whoever fixes it inverts them here.
describe("MEASURED: consent is stamped BEFORE the booking commits (tripwire)", () => {
  it("a REFUSED booking still leaves consent recorded", async () => {
    scenario.bookingResult = "time_unavailable";
    const r = await publicBookAppointmentAction(form());
    expect(r.ok, "the refusal must surface as a refusal").toBe(false);
    expect(
      consentStamps().length,
      "MEASURED, not endorsed: the stamp precedes the commit, so a refused " +
        "booking records consent. Flip to toBe(0) when the order is fixed.",
    ).toBe(1);
  });

  it("the stamp precedes the booking command in one interleaved log", async () => {
    // Read from a single sequence, so this cannot pass on two independently
    // ordered lists. Expected ["book", "stamp"] when this is fixed.
    await publicBookAppointmentAction(form());
    expect(sequence).toEqual(["stamp", "book"]);
  });
});

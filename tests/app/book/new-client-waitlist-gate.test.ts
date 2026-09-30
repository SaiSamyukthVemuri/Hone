import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEW_CLIENT_WAITLIST_SLUGS_ENV } from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// SERVER AUTHORITY — a forged / stale NEW-client booking is refused BEFORE
// anything can mutate.
// ===========================================================================
//
// The waitlist UI is presentation. This drives the REAL
// publicBookAppointmentAction against an in-memory fake and proves the refusal
// precedes every mutation, using TRIPWIRES rather than source greps: each
// collaborator that could create business state records every call, and the
// refused path must leave all of them empty.
//
// It also carries the positive controls that stop the gate being vacuously
// "safe" by refusing everything.

const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const APPT_ID = "66666666-6666-4666-8666-666666666666";
const SLUG = "waitlisted-studio";
const START = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const START_ISO = START.toISOString();

const dbWrites: Array<{ table: string; op: string }> = [];
const rpcCalls: string[] = [];
const intakeCalls: unknown[] = [];
const confirmationEmails: unknown[] = [];
const practitionerEmails: unknown[] = [];
const smsCalls: unknown[] = [];
const conversions: unknown[] = [];
const analyticsEvents: unknown[] = [];
const practitionerNotifications: unknown[] = [];

function resetTripwires() {
  for (const a of [
    dbWrites, rpcCalls, intakeCalls, confirmationEmails, practitionerEmails,
    smsCalls, conversions, analyticsEvents, practitionerNotifications,
  ]) a.length = 0;
}

const scenario = { existingClientOnFile: false };

function makeChain(table: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain as never;
  let insertedClient = false;
  const result = () => {
    if (table === "services") return { count: 3, data: [], error: null };
    if (table === "studio_availability_default") {
      return {
        data: [
          { is_open: true, open_time: "09:00", close_time: "17:00" },
          { is_open: true, open_time: "09:00", close_time: "17:00" },
        ],
        error: null,
      };
    }
    return { data: null, error: null, count: 0 };
  };
  Object.assign(chain, {
    select: self, eq: self, is: self, not: self, in: self, order: self, limit: self,
    insert: () => {
      dbWrites.push({ table, op: "insert" });
      if (table === "clients") insertedClient = true;
      return chain;
    },
    update: () => { dbWrites.push({ table, op: "update" }); return chain; },
    delete: () => { dbWrites.push({ table, op: "delete" }); return chain; },
    upsert: () => { dbWrites.push({ table, op: "upsert" }); return chain; },
    maybeSingle: async () => {
      if (table === "services") {
        return {
          data: {
            id: SERVICE_ID, studio_id: STUDIO_ID, name: "Consultation",
            modality: "consultation", default_duration_minutes: 45, active: true,
          },
          error: null,
        };
      }
      if (table === "clients") {
        return scenario.existingClientOnFile
          ? {
              data: {
                id: CLIENT_ID, name: "Returning Client", email: "returning@example.test",
                phone: "+15550100", sms_consent_at: null, sms_opted_out_at: null,
              },
              error: null,
            }
          : { data: null, error: null };
      }
      return { data: null, error: null };
    },
    single: async () =>
      table === "clients" && insertedClient
        ? {
            data: {
              id: CLIENT_ID, name: "Forged Booker", email: "forged@example.test",
              phone: "+15550111", sms_consent_at: null, sms_opted_out_at: null,
            },
            error: null,
          }
        : { data: null, error: null },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
  });
  return chain;
}

const admin = {
  from: (table: string) => makeChain(table),
  rpc: async (fn: string) => {
    rpcCalls.push(fn);
    return {
      data: {
        ok: true,
        appointment: {
          id: APPT_ID, studio_id: STUDIO_ID, client_id: CLIENT_ID,
          service_id: SERVICE_ID, starts_at: START_ISO,
          ends_at: new Date(START.getTime() + 45 * 60_000).toISOString(),
          status: "scheduled",
        },
      },
      error: null,
    };
  },
};

// NEW-CLIENT-MODE-01: the admission authority now performs the read these
// suites used to make via the env predicate. Delegating to the REAL
// `resolveAdmission` with no stored value routes it through the transition
// bridge, so every `stubEnv` below keeps meaning exactly what it meant.
// A test-set admission state, for the cases that must drive the FOUR modes
// directly rather than through the env bridge. `null` keeps the historical
// behaviour, so every pre-existing `setEnv` case below is untouched.
let admissionOverride:
  | import("@/lib/booking/new-client-admission").NewClientAdmission
  | null = null;

vi.mock("@/lib/booking/new-client-admission", async (orig) => {
  const actual =
    await orig<typeof import("@/lib/booking/new-client-admission")>();
  return {
    ...actual,
    getNewClientAdmissionMode: vi.fn(
      async (studio: { slug: string | null }) =>
        admissionOverride ??
        actual.resolveAdmission({
          storedMode: null,
          storedSetAt: null,
          readFailed: false,
          studioSlug: studio.slug,
        }),
    ),
  };
});

// The invitation authority is mocked so the ORDER can be observed: under
// `closed` or an unreadable mode the admission refusal must come back WITHOUT
// this ever being called, which is what makes "refuses before authorisation"
// a behavioural fact rather than a reading of the source.
const authorizeCalls: unknown[] = [];
let authorizeResult: "authorized" | "scope_refused" = "authorized";

vi.mock("@/lib/booking/waitlist-invitation", async (orig) => {
  const actual =
    await orig<typeof import("@/lib/booking/waitlist-invitation")>();
  return {
    ...actual,
    authorizeInvitationForBooking: vi.fn(async (input: unknown) => {
      authorizeCalls.push(input);
      if (authorizeResult === "scope_refused") {
        return { kind: "scope_refused", reason: "service" } as never;
      }
      return {
        kind: "authorized",
        rawToken: "raw-token",
        invitation: { invitationId: "inv-1", entryId: "entry-1" },
      } as never;
    }),
    consumeInvitationForBooking: vi.fn(async () => ({
      kind: "redeemed",
      studioId: STUDIO_ID,
      entryId: "entry-1",
    })),
  };
});

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => admin }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitPublicBooking: async () => ({ allowed: true }),
  limitPublicSlots: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://studio.example.test" }));
vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => ({
    id: STUDIO_ID,
    // THE SERVER-RESOLVED SLUG. The gate must consult this, never the posted
    // one, so a forged test below posts a different value.
    slug: SLUG,
    name: "Waitlisted Studio",
    owner_email: "owner@studio.test",
    timezone: "America/Toronto",
    default_appointment_duration_minutes: 45,
    buffer_minutes: 0,
    public_booking_horizon_months: 6,
    send_confirmation_emails: true,
    show_treatment_time_to_clients: false,
    notify_practitioner_on_new_booking: false,
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
  ensureIntakeForClient: async (p: unknown) => {
    intakeCalls.push(p);
    return { id: "intake-1", url: "https://studio.example.test/intake/abc" };
  },
}));
vi.mock("@/lib/treatment-time/queries", () => ({
  buildTreatmentTimeLine: () => null,
  getTreatmentTimeContextForEmail: async () => ({ sessionCount: 0, totalMinutes: 0 }),
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: async (p: unknown) => { confirmationEmails.push(p); return { ok: true }; },
  sendBookingNotificationToPractitioner: async (p: unknown) => { practitionerEmails.push(p); return { ok: true }; },
  recordEmailAttempt: async () => {},
  logEmailFailure: () => {},
}));
vi.mock("@/lib/sms/send-appointment", () => ({
  sendBookingConfirmationSmsToClient: async (p: unknown) => { smsCalls.push(p); return { ok: false, skipped: true }; },
}));
vi.mock("@/lib/conversion/dispatch", () => ({
  dispatchBookingConversion: async (p: unknown) => { conversions.push(p); },
}));
vi.mock("@/lib/analytics/server", () => ({
  captureServerEvent: (p: unknown) => { analyticsEvents.push(p); },
}));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: (p: unknown) => { practitionerNotifications.push(p); },
}));

const { publicBookAppointmentAction } = await import("@/app/book/[slug]/actions");

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("slug", SLUG);
  fd.set("service_id", SERVICE_ID);
  fd.set("starts_at", START_ISO);
  fd.set("name", "Forged Booker");
  fd.set("email", "forged@example.test");
  fd.set("phone", "+15550111");
  fd.set("client_type", "new");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

const ORIGINAL = process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
function setEnv(v: string | undefined) {
  if (v === undefined) delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
  else process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = v;
}

beforeEach(() => {
  resetTripwires();
  scenario.existingClientOnFile = false;
  setEnv(undefined);
  admissionOverride = null;
  authorizeCalls.length = 0;
  authorizeResult = "authorized";
});
afterEach(() => setEnv(ORIGINAL));

function expectNothingMutated() {
  expect(dbWrites, "no client/appointment/intake row may be written").toEqual([]);
  expect(rpcCalls, "no appointment command may be issued").toEqual([]);
  expect(intakeCalls, "no intake may be created").toEqual([]);
  expect(confirmationEmails, "no booking confirmation may be sent").toEqual([]);
  expect(practitionerEmails, "no practitioner notification may be sent").toEqual([]);
  expect(smsCalls, "no confirmation SMS may be sent").toEqual([]);
  expect(conversions, "no booking conversion may be dispatched").toEqual([]);
  expect(practitionerNotifications).toEqual([]);
  expect(analyticsEvents, "no booking-success analytics may be emitted").toEqual([]);
}

describe("public booking — new-client waitlist admission gate", () => {
  it("REFUSES a forged/stale new-client submission and mutates nothing", async () => {
    setEnv(SLUG);
    const result = await publicBookAppointmentAction(form());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("new_client_waitlist");
    expect(result.ok === false && result.error).toBe(
      "New-client booking is currently by waitlist. Please join the waitlist.",
    );
    expectNothingMutated();
  });

  it("consults the SERVER-RESOLVED slug, not the one the browser posted", async () => {
    setEnv(SLUG);
    const result = await publicBookAppointmentAction(form({ slug: "definitely-not-waitlisted" }));
    expect(result.ok === false && result.code).toBe("new_client_waitlist");
    expectNothingMutated();
  });

  it("refuses even with a valid consultation service and a free slot", async () => {
    setEnv(`another-studio, ${SLUG} ,third-studio`);
    const result = await publicBookAppointmentAction(form());
    expect(result.ok === false && result.code).toBe("new_client_waitlist");
    expectNothingMutated();
  });

  it("leaks neither the configured slug list nor the env name", async () => {
    setEnv(`${SLUG},secret-other-studio`);
    const result = await publicBookAppointmentAction(form());
    const message = result.ok === false ? result.error : "";
    expect(message).not.toContain("secret-other-studio");
    expect(message).not.toContain(NEW_CLIENT_WAITLIST_SLUGS_ENV);
  });

  // --- POSITIVE CONTROLS ----------------------------------------------------

  it("POSITIVE CONTROL: flag OFF -> a legitimate new-client consultation is NOT intercepted", async () => {
    setEnv(undefined);
    const result = await publicBookAppointmentAction(form());
    expect(result.ok === false && result.code).not.toBe("new_client_waitlist");
    // The exact inverse of the negative assertions: the same post DOES create
    // the client row and DOES issue the command when the flag is off.
    expect(dbWrites).toContainEqual({ table: "clients", op: "insert" });
    expect(rpcCalls.length).toBeGreaterThan(0);
  });

  it("POSITIVE CONTROL: flag ON for OTHER studios only -> booking still runs", async () => {
    setEnv("some-other-studio,yet-another");
    const result = await publicBookAppointmentAction(form());
    expect(result.ok === false && result.code).not.toBe("new_client_waitlist");
    expect(dbWrites).toContainEqual({ table: "clients", op: "insert" });
    expect(rpcCalls.length).toBeGreaterThan(0);
  });

  it("POSITIVE CONTROL: flag ON -> an EXISTING client is NOT intercepted", async () => {
    setEnv(SLUG);
    scenario.existingClientOnFile = true;
    const result = await publicBookAppointmentAction(
      form({ client_type: "existing", email: "returning@example.test" }),
    );
    expect(result.ok === false && result.code).not.toBe("new_client_waitlist");
    expect(
      result.ok === false && result.error,
      "an existing client must never see the waitlist refusal",
    ).not.toBe("New-client booking is currently by waitlist. Please join the waitlist.");
    expect(rpcCalls.length, "existing-client booking must still run").toBeGreaterThan(0);
  });

  it("POSITIVE CONTROL: flag ON + existing client with NO match keeps the pre-existing refusal", async () => {
    setEnv(SLUG);
    scenario.existingClientOnFile = false;
    const result = await publicBookAppointmentAction(
      form({ client_type: "existing", email: "unknown@example.test" }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).not.toBe("new_client_waitlist");
  });
});

// ===========================================================================
// Exact-head P1 at be6722b7 — the four admission states must not collapse.
//
// `admissionGateApplies = !newClientMayBook(admission)` was ONE boolean over
// `waitlist`, `closed` and `unknown`, and the branch it guarded let ANY
// successfully authorized invitation continue. So an invitation issued while a
// studio was waitlisted still booked after the owner switched to CLOSED, and
// booked identically when the admission read FAILED.
//
// The states differ in exactly one respect: whether a valid scoped invitation
// may still admit the client. Only `waitlist` says yes.
// ===========================================================================
const ADMISSION_REFUSAL_CODE = "new_client_admission_closed";
const ADMISSION_REFUSAL_TEXT =
  "This studio is not accepting new-client bookings right now.";

const INVITED = {
  invitation_token: "tok_live_example",
  invitation_capability: "cap_live_example",
} as const;

describe("NEW-CLIENT-MODE-01 — the four admission states are distinct", () => {
  // 1 -------------------------------------------------------------------
  it("OPEN + no invitation: an ordinary new-client booking is permitted", async () => {
    admissionOverride = { ok: true, mode: "open", source: "persisted" };
    const result = await publicBookAppointmentAction(form());
    expect(result.ok === false && result.code).not.toBe(ADMISSION_REFUSAL_CODE);
    expect(result.ok === false && result.code).not.toBe("new_client_waitlist");
    expect(dbWrites).toContainEqual({ table: "clients", op: "insert" });
    expect(rpcCalls.length).toBeGreaterThan(0);
    // No credentials were presented, so the invitation authority is not consulted.
    expect(authorizeCalls).toEqual([]);
  });

  // 2 -------------------------------------------------------------------
  it("OPEN + valid invitation: the credentials are still PROCESSED, not bypassed", async () => {
    admissionOverride = { ok: true, mode: "open", source: "persisted" };
    const result = await publicBookAppointmentAction(form({ ...INVITED }));
    // The point of this case: presenting credentials in OPEN must not silently
    // skip the invitation's own authorisation and lifecycle.
    expect(authorizeCalls.length, "credentials must be processed in OPEN").toBe(1);
    expect(result.ok === false && result.code).not.toBe(ADMISSION_REFUSAL_CODE);
    expect(rpcCalls.length).toBeGreaterThan(0);
  });

  // 3 -------------------------------------------------------------------
  it("WAITLIST + no invitation: admission refusal, nothing mutated", async () => {
    admissionOverride = { ok: true, mode: "waitlist", source: "persisted" };
    const result = await publicBookAppointmentAction(form());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("new_client_waitlist");
    expectNothingMutated();
  });

  // 4 -------------------------------------------------------------------
  it("WAITLIST + valid invitation: the invitation MAY authorise the booking", async () => {
    admissionOverride = { ok: true, mode: "waitlist", source: "persisted" };
    const result = await publicBookAppointmentAction(form({ ...INVITED }));
    // The WAIT invitation lifecycle is preserved: this is the ONE exception.
    expect(authorizeCalls.length).toBe(1);
    expect(result.ok === false && result.code).not.toBe("new_client_waitlist");
    expect(result.ok === false && result.code).not.toBe(ADMISSION_REFUSAL_CODE);
    expect(rpcCalls.length, "an invited waitlist booking must run").toBeGreaterThan(0);
  });

  // 5, 7 ----------------------------------------------------------------
  it.each([
    ["CLOSED", { ok: true, mode: "closed", source: "persisted" } as const],
    ["UNKNOWN", { ok: false } as const],
  ])("%s + no invitation: admission refusal, nothing mutated", async (_label, state) => {
    admissionOverride = state;
    const result = await publicBookAppointmentAction(form());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe(ADMISSION_REFUSAL_CODE);
    expect(result.ok === false && result.error).toBe(ADMISSION_REFUSAL_TEXT);
    expectNothingMutated();
  });

  // 6, 8, 9 -------------------------------------------------------------
  it.each([
    ["CLOSED", { ok: true, mode: "closed", source: "persisted" } as const],
    ["UNKNOWN", { ok: false } as const],
  ])(
    "%s + valid invitation: STILL refused, and authorisation is never reached",
    async (_label, state) => {
      admissionOverride = state;
      const result = await publicBookAppointmentAction(form({ ...INVITED }));

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.code).toBe(ADMISSION_REFUSAL_CODE);
      // REQUIREMENT 9, behaviourally: the refusal happens BEFORE the invitation
      // authority runs, so a valid invitation cannot become an admission bypass
      // and no invitation is consumed on a path that cannot produce a booking.
      expect(
        authorizeCalls,
        "authorizeInvitationForBooking must not run under closed/unknown",
      ).toEqual([]);
      expect(dbWrites).toEqual([]);
      expect(rpcCalls, "no appointment may be created").toEqual([]);
      expectNothingMutated();
    },
  );

  it("CLOSED and UNKNOWN are not an invitation oracle", async () => {
    // The SAME answer for a valid and an invalid invitation: the refusal is
    // returned without consulting the credentials at all, so it cannot be used
    // to learn whether a token is real.
    admissionOverride = { ok: true, mode: "closed", source: "persisted" };
    authorizeResult = "authorized";
    const withValid = await publicBookAppointmentAction(form({ ...INVITED }));
    authorizeResult = "scope_refused";
    const withInvalid = await publicBookAppointmentAction(form({ ...INVITED }));

    expect(withValid).toEqual(withInvalid);
    expect(withValid.ok === false && withValid.code).toBe(ADMISSION_REFUSAL_CODE);
  });

  // 10 ------------------------------------------------------------------
  it.each([
    ["CLOSED", { ok: true, mode: "closed", source: "persisted" } as const],
    ["UNKNOWN", { ok: false } as const],
    ["WAITLIST", { ok: true, mode: "waitlist", source: "persisted" } as const],
  ])("%s: an EXISTING client is completely outside this authority", async (_l, state) => {
    admissionOverride = state;
    scenario.existingClientOnFile = true;
    const result = await publicBookAppointmentAction(
      form({ client_type: "existing", email: "returning@example.test" }),
    );
    expect(result.ok === false && result.code).not.toBe(ADMISSION_REFUSAL_CODE);
    expect(result.ok === false && result.code).not.toBe("new_client_waitlist");
    expect(
      result.ok === false && result.error,
      "an existing client must never see a new-client admission refusal",
    ).not.toBe(ADMISSION_REFUSAL_TEXT);
    expect(rpcCalls.length, "existing-client booking must still run").toBeGreaterThan(0);
  });
});

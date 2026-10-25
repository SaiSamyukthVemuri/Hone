import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 0256 / SEC-004. The action's mapping of the database command's new refusal. Drives the REAL publicBookAppointmentAction with tripwires (same
// scaffold as new-client-waitlist-gate.test.ts). Expiry and single use of the
// confirmation that replaces attachment - the portal's emailed link - are
// owned by tests/app/portal/login/magic-link-ttl.test.ts; this surface mints no
// confirmation of its own, so there is no token here to expire or replay.

const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const APPT_ID = "66666666-6666-4666-8666-666666666666";
const SLUG = "sec-004-studio";
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
  eqCalls.length = 0;
  for (const a of [
    dbWrites, rpcCalls, intakeCalls, confirmationEmails, practitionerEmails,
    smsCalls, conversions, analyticsEvents, practitionerNotifications,
  ]) a.length = 0;
}

const scenario = {
  existingClientOnFile: false,
  // The studio the matching clients row belongs to. The fake HONOURS the
  // lookup's studio_id filter, so a row in another studio can never match.
  clientStudioId: STUDIO_ID,
  clientSmsConsentAt: null as string | null,
  rpcResult: "created" as string,
};
const eqCalls: Array<[string, unknown]> = [];

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
    select: self, eq: (col: string, val: unknown) => { if (table === "clients") eqCalls.push([col, val]); return chain; }, is: self, not: self, in: self, order: self, limit: self,
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
        const scoped = eqCalls.some(([c, v]) => c === "studio_id" && v === scenario.clientStudioId);
        return scenario.existingClientOnFile && scoped
          ? {
              data: {
                id: CLIENT_ID, name: "Returning Client", email: "returning@example.test",
                phone: "+15550100", sms_consent_at: scenario.clientSmsConsentAt, sms_opted_out_at: null,
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
      data: scenario.rpcResult !== "created" ? [{ result: scenario.rpcResult }] : [{ result: "created", client_id: CLIENT_ID, appointment_id: APPT_ID, created_at: new Date().toISOString() }],
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
  fd.set("name", "Someone Else");
  fd.set("email", "returning@example.test");
  fd.set("phone", "+15550100");
  fd.set("client_type", "new");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

const logged: string[] = [];
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetTripwires();
  scenario.existingClientOnFile = false;
  scenario.clientStudioId = STUDIO_ID;
  scenario.clientSmsConsentAt = null;
  scenario.rpcResult = "created";
  admissionOverride = null;
  authorizeCalls.length = 0;
  authorizeResult = "authorized";
  logged.length = 0;
  errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
});
afterEach(() => errSpy.mockRestore());


const ARCHIVED_COPY = "We couldn't complete this booking with those details. Please contact Waitlisted Studio or use a different email.";

describe("0256: the command's existing_client_requires_confirmation is the SAME answer as an archived collision", () => {
  it("maps to the archived-collision copy byte for byte, with no booking side effect", async () => {
    admissionOverride = { ok: true, mode: "open", source: "persisted" };
    scenario.rpcResult = "archived_client_collision";
    const archived = await publicBookAppointmentAction(form({ email: "a@example.test" }));
    resetTripwires();
    scenario.rpcResult = "existing_client_requires_confirmation";
    const raced = await publicBookAppointmentAction(form({ email: "b@example.test" }));
    expect(raced).toEqual({ ok: false, error: ARCHIVED_COPY });
    expect(raced).toEqual(archived);
    expect(rpcCalls).toEqual(["create_public_appointment_for_new_client"]);
    expect(confirmationEmails).toEqual([]);
    expect(smsCalls).toEqual([]);
    expect(conversions).toEqual([]);
    expect(analyticsEvents).toEqual([]);
  });

  it("logs a fingerprint, never the submitted email", async () => {
    admissionOverride = { ok: true, mode: "open", source: "persisted" };
    scenario.rpcResult = "existing_client_requires_confirmation";
    await publicBookAppointmentAction(form({ email: "raced@example.test" }));
    const line = logged.join("\n");
    expect(line).toContain("public_booking_identity_unconfirmed");
    expect(line).not.toContain("raced@example.test");
  });

  it("an INVITED booking that the command refuses reports the spent invitation, not retryable copy", async () => {
    admissionOverride = { ok: true, mode: "open", source: "persisted" };
    scenario.rpcResult = "existing_client_requires_confirmation";
    const r = await publicBookAppointmentAction(form({ invitation_token: "tok", invitation_capability: "cap" }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe("invitation_consumed");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0313 / Vercel Security Review 01M6WR22TXXCQPVTFJB1J98JJM. With WAITLIST_BOOKING_COMMAND=1 the
// invitation CAPABILITY is proved only inside redeem_and_book_waitlist_invitation, so NO write may
// happen before that command returns a committed booking. Drives the REAL publicBookAppointmentAction
// (scaffold copied from sec-004-public-booking-no-attach.test.ts) and records the ORDER of writes
// and commands.

const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const APPT_ID = "66666666-6666-4666-8666-666666666666";
const SLUG = "sec-004-studio";
const OTHER_STUDIO_ID = "99999999-9999-4999-8999-999999999999";
const START = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const START_ISO = START.toISOString();

const events: string[] = [];
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
  events.length = 0;
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
  rpcClientId: null as string | null,
  rpcError: null as { code: string; message: string } | null,
  /** 0323 marker: applied | absent (not yet applied) | error (any other failure). */
  marker: "absent" as "applied" | "absent" | "error",
};
let markerReads = 0;
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
      events.push(`write:${table}:insert`);
      if (table === "clients") insertedClient = true;
      return chain;
    },
    update: () => { dbWrites.push({ table, op: "update" }); events.push(`write:${table}:update`); return chain; },
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
    // The 0323 marker is a read, not a command: answered from the scenario, never recorded as one.
    if (fn === "waitlist_closed_invited_booking_enabled") {
      markerReads += 1;
      if (scenario.marker === "applied") return { data: true, error: null };
      return { data: null, error: { code: scenario.marker === "absent" ? "PGRST202" : "XX000", message: "x" } };
    }
    rpcCalls.push(fn);
    events.push(`rpc:${fn}`);
    if (scenario.rpcError) return { data: null, error: scenario.rpcError };
    return {
      data: scenario.rpcResult !== "created" && scenario.rpcResult !== "created_and_converted" ? [{ result: scenario.rpcResult }] : [{ result: scenario.rpcResult, client_id: scenario.rpcClientId ?? CLIENT_ID, appointment_id: APPT_ID, created_at: new Date().toISOString() }],
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
let consumeRefused = false;

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
    consumeInvitationForBooking: vi.fn(async () =>
      consumeRefused
        ? ({ kind: "capability_refused" } as never)
        : {
      kind: "redeemed",
      studioId: STUDIO_ID,
      entryId: "entry-1",
    }),
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
  scenario.rpcClientId = null;
  scenario.rpcError = null;
  scenario.marker = "absent";
  markerReads = 0;
  admissionOverride = null;
  authorizeCalls.length = 0;
  authorizeResult = "authorized";
  consumeRefused = false;
  logged.length = 0;
  errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
});
afterEach(() => errSpy.mockRestore());

function expectNothingMutated() {
  expect(dbWrites, "no client/consent/appointment row may be written").toEqual([]);
  expect(rpcCalls, "no booking command may be issued").toEqual([]);
  expect(intakeCalls).toEqual([]);
  expect(confirmationEmails, "nothing may be mailed to the stored client").toEqual([]);
  expect(practitionerEmails).toEqual([]);
  expect(smsCalls, "no SMS may be sent to the stored client").toEqual([]);
  expect(conversions).toEqual([]);
  expect(practitionerNotifications).toEqual([]);
  expect(analyticsEvents).toEqual([]);
}


const INVITED = { invitation_token: "raw-token", invitation_capability: "cap-under-test" };
const CLIENT_CONSENT_WRITE = "write:clients:update";

function invitedForm(extra: Record<string, string> = {}) {
  return form({ sms_consent: "true", ...INVITED, ...extra });
}

describe("0313 command path: no write precedes proof of the capability", () => {
  beforeEach(() => {
    scenario.existingClientOnFile = true; // the invited person is already a client, matching phone
    vi.stubEnv("WAITLIST_BOOKING_COMMAND", "1");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["invalid capability", "redeem_proof_invalid"],
    ["expired capability", "redeem_proof_expired"],
    ["another invitation's capability", "redeem_invitation_mismatch"],
  ])("%s: refused, and the clients row is never written", async (_l, result) => {
    scenario.rpcResult = result;
    const r = await publicBookAppointmentAction(invitedForm());
    expect(r.ok).toBe(false);
    expect(events).toContain("rpc:redeem_and_book_waitlist_invitation");
    expect(events, "no consent (or any clients) write on a refused capability").not.toContain(CLIENT_CONSENT_WRITE);
    expect(dbWrites.filter((w) => w.table === "clients")).toEqual([]);
  });

  it("a committed booking stamps consent, and only AFTER the command", async () => {
    scenario.rpcResult = "created_and_converted";
    const r = await publicBookAppointmentAction(invitedForm());
    expect(r, JSON.stringify(r) + " " + logged.join(" | ").slice(0, 400)).toMatchObject({ ok: true });
    const cmd = events.indexOf("rpc:redeem_and_book_waitlist_invitation");
    const stamp = events.indexOf(CLIENT_CONSENT_WRITE);
    expect(cmd).toBeGreaterThanOrEqual(0);
    expect(stamp).toBeGreaterThan(cmd);
  });

  it("nothing at all is written before the command on this path", async () => {
    scenario.rpcResult = "redeem_proof_invalid";
    await publicBookAppointmentAction(invitedForm());
    const cmd = events.indexOf("rpc:redeem_and_book_waitlist_invitation");
    expect(cmd).toBeGreaterThanOrEqual(0);
    expect(events.slice(0, cmd).filter((e) => e.startsWith("write:"))).toEqual([]);
  });

  it("H1: a committed booking whose client is NOT the matched client stamps nothing", async () => {
    scenario.rpcResult = "created_and_converted";
    scenario.rpcClientId = "99999999-0000-4000-8000-000000000001";
    await publicBookAppointmentAction(invitedForm());
    expect(events).toContain("rpc:redeem_and_book_waitlist_invitation");
    expect(events).not.toContain(CLIENT_CONSENT_WRITE);
  });

  it("an rpc error (outcome uncertain) stamps nothing", async () => {
    scenario.rpcError = { code: "57014", message: "canceled" };
    const r = await publicBookAppointmentAction(invitedForm());
    expect(r.ok).toBe(false);
    expect(events).not.toContain(CLIENT_CONSENT_WRITE);
  });

  it.each(["time_unavailable", "outside_availability", "new_client_admission_refused", "archived_client_collision"])(
    "a non-created refusal (%s) stamps nothing",
    async (result) => {
      scenario.rpcResult = result;
      const r = await publicBookAppointmentAction(invitedForm());
      expect(r.ok).toBe(false);
      expect(events).not.toContain(CLIENT_CONSENT_WRITE);
    },
  );

  it("flag OFF is unchanged: redeem-first (proof), then the stamp RUNS ahead of the command as before", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("WAITLIST_BOOKING_COMMAND", "");
    scenario.rpcResult = "created_and_converted";
    await publicBookAppointmentAction(invitedForm());
    expect(events).not.toContain("rpc:redeem_and_book_waitlist_invitation");
    const stamp = events.indexOf(CLIENT_CONSENT_WRITE);
    const cmd = events.findIndex((e) => e.startsWith("rpc:create_"));
    expect(stamp, "the flag-off stamp still runs").toBeGreaterThanOrEqual(0);
    expect(cmd).toBeGreaterThan(stamp);
  });
});

describe("0323: a CLOSED studio books an invited person through publicBookAppointmentAction", () => {
  const CLOSED = { ok: true, mode: "closed", source: "persisted" } as never;
  const UNKNOWN = { ok: false } as never;
  beforeEach(() => {
    vi.stubEnv("WAITLIST_BOOKING_COMMAND", "1");
    scenario.rpcResult = "created_and_converted";
  });
  afterEach(() => vi.unstubAllEnvs());

  it("marker applied + both halves: the invitation is authorized and the booking command runs", async () => {
    admissionOverride = CLOSED;
    scenario.marker = "applied";
    const r = await publicBookAppointmentAction(invitedForm());
    expect(r.ok).toBe(true);
    expect(authorizeCalls).toHaveLength(1);
    expect(rpcCalls).toContain("redeem_and_book_waitlist_invitation");
  });

  it("marker applied but the invitation is not authorized: refused as an invitation refusal, no command", async () => {
    admissionOverride = CLOSED;
    scenario.marker = "applied";
    authorizeResult = "scope_refused";
    const r = await publicBookAppointmentAction(invitedForm());
    expect(r.ok).toBe(false);
    expect(authorizeCalls).toHaveLength(1);
    expect(rpcCalls).toEqual([]);
  });

  it.each([["absent"], ["error"]] as const)(
    "marker %s: still refused as closed, before the invitation is consulted",
    async (marker) => {
      admissionOverride = CLOSED;
      scenario.marker = marker;
      const r = await publicBookAppointmentAction(invitedForm());
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.code).toBe("new_client_admission_closed");
      expect(authorizeCalls).toEqual([]);
      expectNothingMutated();
    },
  );

  // The both-halves check is a PRESENCE check, not proof. A real token with a garbage capability
  // reaches the proof, which refuses; nothing is written on either path. What is pinned HERE is the
  // app side only (no write, no email, no SMS, no conversion after a refusal); the real redeem's
  // refusal of a garbage capability is pinned by the 0313 DB tests.
  it("marker applied + a real token but a GARBAGE capability, flag ON: the command refuses and nothing is written", async () => {
    admissionOverride = CLOSED;
    scenario.marker = "applied";
    scenario.rpcResult = "redeem_proof_invalid";
    const r = await publicBookAppointmentAction(invitedForm({ invitation_capability: "garbage" }));
    expect(r.ok).toBe(false);
    expect(dbWrites, "no row may be written").toEqual([]);
    expect(confirmationEmails).toEqual([]);
    expect(smsCalls).toEqual([]);
    expect(conversions).toEqual([]);
  });

  it("marker applied + a real token but a GARBAGE capability, LEGACY path: the proof refuses before any write", async () => {
    vi.stubEnv("WAITLIST_BOOKING_COMMAND", "");
    admissionOverride = CLOSED;
    scenario.marker = "applied";
    consumeRefused = true;
    const r = await publicBookAppointmentAction(invitedForm({ invitation_capability: "garbage" }));
    expect(r.ok).toBe(false);
    expect(rpcCalls, "no booking command may be issued").toEqual([]);
    expect(dbWrites, "no row may be written").toEqual([]);
    expect(confirmationEmails).toEqual([]);
    expect(smsCalls).toEqual([]);
    expect(conversions).toEqual([]);
  });

  it("marker applied but only ONE half presented: refused as closed, invitation never consulted", async () => {
    admissionOverride = CLOSED;
    scenario.marker = "applied";
    for (const half of [{ invitation_token: "raw-token" }, { invitation_capability: "cap-under-test" }, {}] as Record<string, string>[]) {
      authorizeCalls.length = 0;
      const r = await publicBookAppointmentAction(form(half));
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.code).toBe("new_client_admission_closed");
      expect(authorizeCalls).toEqual([]);
    }
  });

  it("an ordinary public booking (no invitation) under Closed is refused and the marker is not even read", async () => {
    admissionOverride = CLOSED;
    scenario.marker = "applied";
    const r = await publicBookAppointmentAction(form());
    expect(r.ok).toBe(false);
    expect(markerReads).toBe(0);
    expectNothingMutated();
  });

  it("an UNKNOWN mode refuses even with both halves and the marker applied; the marker is not read", async () => {
    admissionOverride = UNKNOWN;
    scenario.marker = "applied";
    const r = await publicBookAppointmentAction(invitedForm());
    expect(r.ok).toBe(false);
    expect(markerReads).toBe(0);
    expect(authorizeCalls).toEqual([]);
    expectNothingMutated();
  });
});

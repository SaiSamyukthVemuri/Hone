import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// SEC-004. Drives the REAL publicBookAppointmentAction with tripwires (same
// scaffold as new-client-waitlist-gate.test.ts). Expiry and single use of the
// confirmation that replaces attachment - the portal's emailed link - are
// owned by tests/app/portal/login/magic-link-ttl.test.ts; this surface mints no
// confirmation of its own, so there is no token here to expire or replay.

const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const APPT_ID = "66666666-6666-4666-8666-666666666666";
const SLUG = "sec-004-studio";
const OTHER_STUDIO_ID = "99999999-9999-4999-8999-999999999999";
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

const ARCHIVED_COPY = "We couldn't complete this booking with those details. Please contact Waitlisted Studio or use a different email.";

describe("SEC-004: knowing an email does not attach a public booking to a client", () => {
  it("client_type=new + an ACTIVE client's email: refused, nothing written, nothing sent", async () => {
    scenario.existingClientOnFile = true;
    const r = await publicBookAppointmentAction(form());
    expect(r).toEqual({ ok: false, error: ARCHIVED_COPY });
    expectNothingMutated();
  });

  it("client_type=existing + a matched email: refused the same way (the legacy attach path is closed)", async () => {
    scenario.existingClientOnFile = true;
    const r = await publicBookAppointmentAction(form({ client_type: "existing" }));
    expect(r).toEqual({ ok: false, error: ARCHIVED_COPY });
    expectNothingMutated();
  });

  it("PRIVACY: matched, unmatched and ARCHIVED answers for client_type=existing are byte-identical", async () => {
    scenario.existingClientOnFile = true;
    const matched = await publicBookAppointmentAction(form({ client_type: "existing" }));
    scenario.existingClientOnFile = false;
    const unmatched = await publicBookAppointmentAction(form({ client_type: "existing", email: "nobody@example.test" }));
    // An ARCHIVED client reads as unmatched (the lookup is active-only).
    const archived = await publicBookAppointmentAction(form({ client_type: "existing", email: "archived@example.test" }));
    expect(unmatched).toEqual(matched);
    expect(archived).toEqual(matched);
    expectNothingMutated();
  });

  it("PRIVACY: a matched new-client refusal is the archived-collision copy, so active and archived are not told apart", async () => {
    scenario.existingClientOnFile = true;
    const active = await publicBookAppointmentAction(form());
    resetTripwires();
    scenario.existingClientOnFile = false;
    scenario.rpcResult = "archived_client_collision";
    const archived = await publicBookAppointmentAction(form());
    expect(active).toEqual({ ok: false, error: ARCHIVED_COPY });
    expect(archived).toEqual({ ok: false, error: ARCHIVED_COPY });
  });

  it("the refusal logs a salted fingerprint, never the submitted email", async () => {
    scenario.existingClientOnFile = true;
    await publicBookAppointmentAction(form());
    const line = logged.join("\n");
    expect(line).toContain("public_booking_identity_unconfirmed");
    expect(line).not.toContain("returning@example.test");
  });

  it("CONSENT: a matching phone + SMS consent no longer stamps the stored client", async () => {
    scenario.existingClientOnFile = true;
    const r = await publicBookAppointmentAction(form({ sms_consent: "on", phone: "+15550100" }));
    expect(r.ok).toBe(false);
    expect(dbWrites.filter((w) => w.table === "clients")).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("DOUBLE SUBMIT: repeating a refused submission is refused identically, with no side effect", async () => {
    scenario.existingClientOnFile = true;
    const a = await publicBookAppointmentAction(form());
    const b = await publicBookAppointmentAction(form());
    expect(b).toEqual(a);
    expectNothingMutated();
  });

  it("RACE, ARCHIVED WINNER: the client is archived between the lookup and the commit -> the command's own refusal, same copy, nothing booked", async () => {
    scenario.existingClientOnFile = false;
    scenario.rpcResult = "archived_client_collision";
    const r = await publicBookAppointmentAction(form());
    expect(r).toEqual({ ok: false, error: ARCHIVED_COPY });
    expect(rpcCalls).toEqual(["create_public_appointment_for_new_client"]);
    expect(confirmationEmails).toEqual([]);
    expect(smsCalls).toEqual([]);
    expect(conversions).toEqual([]);
  });

  it("CROSS-STUDIO: the lookup is scoped to the booked studio, so another studio's client never matches", async () => {
    scenario.existingClientOnFile = true;
    scenario.clientStudioId = OTHER_STUDIO_ID;
    admissionOverride = { ok: true, mode: "open", source: "persisted" };
    const r = await publicBookAppointmentAction(form());
    expect(eqCalls).toContainEqual(["studio_id", STUDIO_ID]);
    expect(eqCalls.some(([c, v]) => c === "studio_id" && v === OTHER_STUDIO_ID)).toBe(false);
    // Not matched, so it is an ordinary new-client booking in THIS studio, and
    // it passes no client id to the command.
    expect(r.ok).toBe(true);
    expect(rpcCalls).toEqual(["create_public_appointment_for_new_client"]);
  });

  it("POSITIVE CONTROL: an unmatched new client still books", async () => {
    admissionOverride = { ok: true, mode: "open", source: "persisted" };
    const r = await publicBookAppointmentAction(form({ email: "fresh@example.test" }));
    expect(r.ok).toBe(true);
    expect(rpcCalls).toEqual(["create_public_appointment_for_new_client"]);
  });

  it("EXCEPTION: an AUTHORIZED invitation proves the address, so it is not refused as unconfirmed", async () => {
    scenario.existingClientOnFile = true;
    admissionOverride = { ok: true, mode: "open", source: "persisted" };
    const r = await publicBookAppointmentAction(
      form({ invitation_token: "tok", invitation_capability: "cap" }),
    );
    expect(r.ok === false && r.error).not.toBe(ARCHIVED_COPY);
    expect(rpcCalls.length).toBeGreaterThan(0);
  });

  // KNOWN RESIDUAL - PINNED, NOT HIDDEN (Insurance PEER-1132 F1).
  //
  // The action's lookup and the database commit are not one step. An ACTIVE
  // client with the submitted email that appears in between (staff "Add
  // Client" takes no studio lock; a concurrent public booking can create one)
  // is ADOPTED by create_public_appointment_for_new_client, and the booking
  // lands on that client. Only an ARCHIVED winner is refused. The DB-side fix
  // is the 0256 request; WHEN IT LANDS, FLIP THESE TWO TESTS to expect the
  // refusal. They exist so the window is documented, not rediscovered.
  it("KNOWN RESIDUAL: an ACTIVE client created between the lookup and the commit is adopted by the command (booked, not refused)", async () => {
    scenario.existingClientOnFile = false; // the lookup saw nobody...
    admissionOverride = { ok: true, mode: "open", source: "persisted" };
    // ...but the command, under its lock, resolves an active client and books on it.
    const r = await publicBookAppointmentAction(form({ email: "raced@example.test" }));
    expect(r.ok, "documents the residual: this is an attach, closed only by 0256").toBe(true);
    expect(rpcCalls).toEqual(["create_public_appointment_for_new_client"]);
  });

  it("KNOWN RESIDUAL (database side): 0204's command refuses only an ARCHIVED winner and adopts an active one", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0204_new_client_admission_mode.sql"), "utf8");
    const start = sql.indexOf("function public.create_public_appointment_for_new_client");
    const body = sql.slice(start, sql.indexOf("\n$$;", start));
    // The lookup under the lock keeps an ACTIVE row's id and carries on...
    expect(body).toMatch(/select c\.id, c\.archived_at is not null\s+into v_client_id, v_archived/);
    // ...and the only identity refusal is the archived one.
    const refusals = [...body.matchAll(/select '([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(refusals).toContain("archived_client_collision");
    expect(refusals).not.toContain("existing_client_requires_confirmation");
  });
});

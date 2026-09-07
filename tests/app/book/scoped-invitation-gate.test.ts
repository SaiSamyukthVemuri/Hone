import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NEW_CLIENT_WAITLIST_SLUGS_ENV } from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// WAIT-03B B2 — a scoped invitation is the ONE way past the new-client gate.
// ===========================================================================
//
// This drives the REAL publicBookAppointmentAction. The load-bearing claims:
//
//   * a BEARER token with no capability never reaches the redeem, let alone a
//     booking -- possession of the link is not authorisation;
//   * tenancy, recipient and scope are all checked BEFORE anything is consumed,
//     so a refused attempt never burns the recipient's invitation;
//   * on the authorised path the invitation is consumed BEFORE the appointment
//     command, never after.
//
// Ordering is asserted from the recorded RPC sequence rather than from source,
// because the ordering IS the safety property: booking first would risk two
// appointments from one invitation.

const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_STUDIO_ID = "99999999-9999-4999-8999-999999999999";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_SERVICE_ID = "77777777-7777-4777-8777-777777777777";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const APPT_ID = "66666666-6666-4666-8666-666666666666";
const SLUG = "waitlisted-studio";

const TOKEN = "a".repeat(64);
const CAP = "b".repeat(64);
const INVITED_EMAIL = "chloe@example.test";
const INVITED_HASH = createHash("sha256").update(INVITED_EMAIL, "utf8").digest("hex");

// A Wednesday well inside the horizon, fixed so the scope window is stable.
const START = new Date("2026-10-07T14:00:00.000Z");
const START_ISO = START.toISOString();

const rpcCalls: string[] = [];
const dbWrites: Array<{ table: string; op: string }> = [];

const scenario = {
  resolveResult: "live" as string,
  studioIdOnInvitation: STUDIO_ID,
  scopeServiceId: SERVICE_ID,
  scopeStart: "2026-10-01",
  scopeEnd: "2026-10-31",
  scopeWeekdays: null as number[] | null,
  redeemResult: "redeemed" as string,
};

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
    insert: () => { dbWrites.push({ table, op: "insert" }); if (table === "clients") insertedClient = true; return chain; },
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
      return { data: null, error: null };
    },
    single: async () =>
      table === "clients" && insertedClient
        ? {
            data: {
              id: CLIENT_ID, name: "Chloe", email: INVITED_EMAIL,
              phone: null, sms_consent_at: null, sms_opted_out_at: null,
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
    if (fn === "resolve_new_client_waitlist_invitation") {
      return {
        data: [
          {
            result: scenario.resolveResult,
            invitation_id: "inv-1",
            studio_id: scenario.studioIdOnInvitation,
            entry_id: "entry-1",
            scope_service_id: scenario.scopeServiceId,
            scope_start_date: scenario.scopeStart,
            scope_end_date: scenario.scopeEnd,
            scope_allowed_weekdays: scenario.scopeWeekdays,
            expires_at: "2026-10-31T12:00:00Z",
            recipient_contact_hash: INVITED_HASH,
          },
        ],
        error: null,
      };
    }
    if (fn === "redeem_new_client_waitlist_invitation_verified") {
      return {
        data: [{ result: scenario.redeemResult, studio_id: STUDIO_ID, entry_id: "entry-1" }],
        error: null,
      };
    }
    if (fn === "create_public_appointment") {
      return {
        data: [{ result: "created", appointment_id: APPT_ID, created_at: new Date().toISOString() }],
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
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://studio.example.test" }));
vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => ({
    id: STUDIO_ID, slug: SLUG, name: "Waitlisted Studio",
    owner_email: "owner@studio.test", timezone: "America/Toronto",
    default_appointment_duration_minutes: 45, buffer_minutes: 0,
    public_booking_horizon_months: 6, send_confirmation_emails: false,
    show_treatment_time_to_clients: false, notify_practitioner_on_new_booking: false,
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
  ensureIntakeForClient: async () => ({ id: "intake-1", url: "https://studio.example.test/intake/abc" }),
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
  fd.set("name", "Chloe");
  fd.set("email", INVITED_EMAIL);
  fd.set("phone", "+15550111");
  fd.set("client_type", "new");
  for (const [k, v] of Object.entries(over)) {
    if (v === "") fd.delete(k);
    else fd.set(k, v);
  }
  return fd;
}

const redeemed = () => rpcCalls.includes("redeem_new_client_waitlist_invitation_verified");
const booked = () => rpcCalls.includes("create_public_appointment");

beforeEach(() => {
  process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = SLUG;
  rpcCalls.length = 0;
  dbWrites.length = 0;
  Object.assign(scenario, {
    resolveResult: "live",
    studioIdOnInvitation: STUDIO_ID,
    scopeServiceId: SERVICE_ID,
    scopeStart: "2026-10-01",
    scopeEnd: "2026-10-31",
    scopeWeekdays: null,
    redeemResult: "redeemed",
  });
});

describe("scoped invitation — bearer possession is not authorisation", () => {
  it("refuses a token with NO capability, and consumes nothing", async () => {
    const out = await publicBookAppointmentAction(form({ invitation_token: TOKEN }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("invitation_refused");
    expect(redeemed()).toBe(false);
    expect(booked()).toBe(false);
  });

  it("refuses a capability with no token", async () => {
    const out = await publicBookAppointmentAction(form({ invitation_capability: CAP }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    // No token presented at all -> this is the plain waitlist refusal.
    expect(out.code).toBe("new_client_waitlist");
    expect(redeemed()).toBe(false);
  });

  it("still refuses a new client presenting nothing (existing behaviour intact)", async () => {
    const out = await publicBookAppointmentAction(form());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("new_client_waitlist");
    expect(rpcCalls).toEqual([]);
  });
});

describe("scoped invitation — bindings refuse BEFORE anything is consumed", () => {
  it("refuses an invitation issued by another studio", async () => {
    scenario.studioIdOnInvitation = OTHER_STUDIO_ID;
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    expect(redeemed()).toBe(false);
  });

  it("refuses a substituted email — a typed address is not identity", async () => {
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP, email: "someone.else@example.test" }),
    );
    expect(out.ok).toBe(false);
    expect(redeemed()).toBe(false);
  });

  it("refuses a service the offer does not cover", async () => {
    scenario.scopeServiceId = OTHER_SERVICE_ID;
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    expect(redeemed()).toBe(false);
  });

  it("refuses a date outside the offered window", async () => {
    scenario.scopeStart = "2026-11-01";
    scenario.scopeEnd = "2026-11-30";
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    expect(redeemed()).toBe(false);
  });

  it("refuses a weekday outside the offer", async () => {
    // START is a Wednesday (3) in Toronto; offer Mondays only.
    scenario.scopeWeekdays = [1];
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    expect(redeemed()).toBe(false);
  });

  it.each(["already_redeemed", "declined", "released", "expired", "invalid_token"])(
    "refuses a %s invitation",
    async (code) => {
      scenario.resolveResult = code;
      const out = await publicBookAppointmentAction(
        form({ invitation_token: TOKEN, invitation_capability: CAP }),
      );
      expect(out.ok).toBe(false);
      expect(redeemed()).toBe(false);
    },
  );

  it("gives every refusal the SAME message, so probing reveals nothing", async () => {
    const messages = new Set<string>();
    const cases: Array<() => void> = [
      () => { scenario.studioIdOnInvitation = OTHER_STUDIO_ID; },
      () => { scenario.scopeServiceId = OTHER_SERVICE_ID; },
      () => { scenario.scopeWeekdays = [1]; },
      () => { scenario.resolveResult = "expired"; },
    ];
    for (const mutate of cases) {
      Object.assign(scenario, {
        resolveResult: "live", studioIdOnInvitation: STUDIO_ID,
        scopeServiceId: SERVICE_ID, scopeWeekdays: null,
      });
      mutate();
      const out = await publicBookAppointmentAction(
        form({ invitation_token: TOKEN, invitation_capability: CAP }),
      );
      if (out.ok) throw new Error("expected refusal");
      messages.add(out.error);
    }
    expect(messages.size).toBe(1);
  });
});

describe("scoped invitation — the authorised path", () => {
  it("admits an in-scope invited recipient past the new-client gate", async () => {
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(true);
    expect(redeemed()).toBe(true);
    expect(booked()).toBe(true);
  });

  // THE ORDERING IS THE SAFETY PROPERTY. Booking before redeeming would risk two
  // appointments from one invitation, which is exactly what admission control
  // exists to prevent.
  it("consumes the invitation BEFORE the appointment command", async () => {
    await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    const redeemAt = rpcCalls.indexOf("redeem_new_client_waitlist_invitation_verified");
    const bookAt = rpcCalls.indexOf("create_public_appointment");
    expect(redeemAt).toBeGreaterThanOrEqual(0);
    expect(bookAt).toBeGreaterThanOrEqual(0);
    expect(redeemAt).toBeLessThan(bookAt);
  });

  it("resolves before it redeems, so scope is checked on a non-consuming read", async () => {
    await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(rpcCalls.indexOf("resolve_new_client_waitlist_invitation")).toBeLessThan(
      rpcCalls.indexOf("redeem_new_client_waitlist_invitation_verified"),
    );
  });

  it.each(["proof_required", "proof_expired", "proof_invalid", "not_live"])(
    "creates NO appointment when the locked redeem answers %s",
    async (code) => {
      scenario.redeemResult = code;
      const out = await publicBookAppointmentAction(
        form({ invitation_token: TOKEN, invitation_capability: CAP }),
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("unreachable");
      expect(out.code).toBe("invitation_refused");
      expect(booked()).toBe(false);
    },
  );

  it("creates no appointment when the redeem answers with an unknown code", async () => {
    scenario.redeemResult = "surprise";
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    expect(booked()).toBe(false);
  });
});

describe("scoped invitation — the gate is not weakened for anyone else", () => {
  it("does not consult an invitation when the studio is not waitlisted", async () => {
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "some-other-studio";
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(true);
    // No invitation was consumed: the gate never applied, so nothing was spent.
    expect(redeemed()).toBe(false);
  });
});

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
  // P2-A. The service the booking command reads. An ACTIVE CONSULTATION by
  // default -- the ordinary invitation journey -- and varied below to prove an
  // invitation buys no exemption from the new-client service rule.
  serviceModality: "consultation" as string | null,
  serviceName: "Consultation",
  serviceActive: true,
  resolveResult: "live" as string,
  studioIdOnInvitation: STUDIO_ID,
  scopeServiceId: SERVICE_ID,
  scopeStart: "2026-10-01",
  scopeEnd: "2026-10-31",
  scopeWeekdays: null as number[] | null,
  redeemResult: "redeemed" as string,
  bookingResult: "created" as string,
  bookingError: null as { message: string } | null,
  suppressAppointmentId: false,
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
        // The action's own read filters `active`, so an inactive service must
        // come back as NO ROW here rather than as an inactive one.
        if (!scenario.serviceActive) return { data: null, error: null };
        return {
          data: {
            id: SERVICE_ID, studio_id: STUDIO_ID, name: scenario.serviceName,
            modality: scenario.serviceModality, default_duration_minutes: 45,
            active: true,
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
      if (scenario.bookingError) return { data: null, error: scenario.bookingError };
      return {
        data: [
          {
            result: scenario.bookingResult,
            appointment_id:
              scenario.bookingResult === "created" && !scenario.suppressAppointmentId
                ? APPT_ID
                : null,
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
    serviceModality: "consultation",
    serviceName: "Consultation",
    serviceActive: true,
    resolveResult: "live",
    studioIdOnInvitation: STUDIO_ID,
    scopeServiceId: SERVICE_ID,
    scopeStart: "2026-10-01",
    scopeEnd: "2026-10-31",
    scopeWeekdays: null,
    redeemResult: "redeemed",
    bookingResult: "created",
    bookingError: null,
    suppressAppointmentId: false,
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

// ===========================================================================
// P2-B — AN ISSUED INVITATION'S AUTHORITY OUTLIVES THE FEATURE FLAG
// ===========================================================================
//
// THE ASSERTION THIS REPLACES SAID THE OPPOSITE, and said it deliberately:
//
//     it("does not consult an invitation when the studio is not waitlisted",
//        ... expect(out.ok).toBe(true); expect(redeemed()).toBe(false); ...)
//
// A booking that carried a token and a capability, succeeded, and consumed
// NOTHING. That is the defect stated as a guarantee, which is why it survived
// -- the suite was pinning it.
//
// The sequence it permitted: issue an invitation while the waitlist is on, turn
// the waitlist off, then redeem. The gate is skipped, so
// `authorizeInvitationForBooking` never runs (no recipient check, no scope
// check) and `consumeInvitationForBooking` -- reachable only from an authorised
// result -- never runs either. An appointment exists and the invitation is
// still LIVE.
//
// The flag governs ADMISSION: whether a visitor presenting nothing may book as
// a new client. It does not govern AUTHORITY over an invitation already issued.

describe("P2-B — the flag controls admission, never an issued invitation", () => {
  const flagOff = () => {
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "some-other-studio";
  };

  it("PROOF 1 — flag ON + valid invitation: behaviour unchanged", async () => {
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(true);
    expect(redeemed()).toBe(true);
    expect(booked()).toBe(true);
  });

  it("PROOF 2 — flag OFF + valid in-scope invitation: still authorised, still consumed", async () => {
    flagOff();
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(true);
    // Authorization ran: the non-consuming resolve is what it reads scope from.
    expect(rpcCalls).toContain("resolve_new_client_waitlist_invitation");
    // And the offer was spent -- the whole point.
    expect(redeemed()).toBe(true);
    expect(booked()).toBe(true);
  });

  it("PROOF 2 — consumed EXACTLY ONCE, and before the appointment", async () => {
    flagOff();
    await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    const redeems = rpcCalls.filter(
      (c) => c === "redeem_new_client_waitlist_invitation_verified",
    );
    expect(redeems).toHaveLength(1);
    expect(rpcCalls.indexOf("redeem_new_client_waitlist_invitation_verified")).toBeLessThan(
      rpcCalls.indexOf("create_public_appointment"),
    );
  });

  it("PROOF 2 — the RECIPIENT is still checked with the flag off", async () => {
    flagOff();
    const out = await publicBookAppointmentAction(
      form({
        invitation_token: TOKEN,
        invitation_capability: CAP,
        email: "someone.else@example.test",
      }),
    );
    expect(out.ok).toBe(false);
    expect(redeemed()).toBe(false);
    expect(booked()).toBe(false);
  });

  it("PROOF 3 — flag OFF + OUT-OF-SCOPE slot: refused, no appointment", async () => {
    flagOff();
    // START is a Wednesday in Toronto; offer Mondays only.
    scenario.scopeWeekdays = [1];
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("invitation_refused");
    expect(redeemed()).toBe(false);
    expect(booked()).toBe(false);
    // NO SCOPE BYPASS: nothing was written on the refused path at all.
    expect(dbWrites).toEqual([]);
  });

  it("PROOF 3 — an out-of-window DATE is refused with the flag off too", async () => {
    flagOff();
    scenario.scopeStart = "2026-11-01";
    scenario.scopeEnd = "2026-11-30";
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    expect(booked()).toBe(false);
  });

  it("PROOF 3 — a service outside the offer is refused with the flag off too", async () => {
    flagOff();
    scenario.scopeServiceId = OTHER_SERVICE_ID;
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    expect(booked()).toBe(false);
  });

  it.each(["proof_required", "proof_expired", "proof_invalid", "not_live"])(
    "PROOF 4 — flag OFF + a capability the locked redeem rejects (%s): refused, no appointment",
    async (code) => {
      flagOff();
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

  it("PROOF 4 — flag OFF + a STALE invitation is refused", async () => {
    flagOff();
    scenario.resolveResult = "expired";
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    expect(redeemed()).toBe(false);
    expect(booked()).toBe(false);
  });

  it("PROOF 5 — flag OFF + NO credentials: ordinary public booking, unchanged", async () => {
    flagOff();
    const out = await publicBookAppointmentAction(form());
    expect(out.ok).toBe(true);
    expect(booked()).toBe(true);
    // The invitation machinery is not consulted at all for an ordinary visitor.
    expect(rpcCalls).not.toContain("resolve_new_client_waitlist_invitation");
    expect(redeemed()).toBe(false);
  });

  it("PROOF 6 — flag ON + NO credentials: the admission gate is unchanged", async () => {
    const out = await publicBookAppointmentAction(form());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("new_client_waitlist");
    expect(rpcCalls).toEqual([]);
  });

  // THE PROPERTY, STATED AS ONE COMPARISON. Every other test here fixes the
  // flag and varies the request; this one fixes the request and varies the
  // flag, which is the thing that must not matter.
  it("PROOF 7 — toggling the flag never converts an invitation booking into an ordinary one", async () => {
    const runWith = async (enabled: boolean) => {
      process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = enabled ? SLUG : "some-other-studio";
      rpcCalls.length = 0;
      const out = await publicBookAppointmentAction(
        form({ invitation_token: TOKEN, invitation_capability: CAP }),
      );
      return { ok: out.ok, redeemed: redeemed(), booked: booked() };
    };
    const on = await runWith(true);
    const off = await runWith(false);
    expect(off).toEqual(on);
    // And it is the AUTHORISED shape both times, not "refused both times".
    expect(off).toEqual({ ok: true, redeemed: true, booked: true });
  });

  it("PROOF 7 — a BEARER token alone still cannot book with the flag off", async () => {
    flagOff();
    const out = await publicBookAppointmentAction(form({ invitation_token: TOKEN }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("invitation_refused");
    expect(redeemed()).toBe(false);
    expect(booked()).toBe(false);
  });

  it("PROOF 7 — a lone capability does not buy the ordinary path with the flag off", async () => {
    flagOff();
    // Presenting half a credential is not a way to opt out of invitation
    // handling: there is no invitation to authorise, so it fails closed.
    const out = await publicBookAppointmentAction(form({ invitation_capability: CAP }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("invitation_refused");
    expect(booked()).toBe(false);
  });

  // With the flag OFF the studio IS taking new clients, so the admission copy
  // ("we're not taking new clients right now") would be a false statement about
  // the studio. It is never returned on that path.
  it("never claims the studio is closed to new clients when it is not", async () => {
    flagOff();
    for (const fd of [
      form({ invitation_token: TOKEN }),
      form({ invitation_capability: CAP }),
      form({ invitation_token: TOKEN, invitation_capability: CAP, email: "x@y.test" }),
    ]) {
      const out = await publicBookAppointmentAction(fd);
      if (out.ok) throw new Error("expected refusal");
      expect(out.code).not.toBe("new_client_waitlist");
    }
  });

  // The gate's own copy is UNCHANGED for the case it actually describes.
  it("still returns the admission refusal for a bare new client at a waitlisted studio", async () => {
    const out = await publicBookAppointmentAction(form());
    if (out.ok) throw new Error("expected refusal");
    expect(out.code).toBe("new_client_waitlist");
  });
});

describe("scoped invitation — the gate is not weakened for anyone else", () => {
  it("leaves an EXISTING client's booking untouched with the flag on", async () => {
    // Admission control is for new intake only. An existing client presenting
    // no invitation is not gated, and nothing invitation-shaped is consulted.
    const out = await publicBookAppointmentAction(form({ client_type: "existing" }));
    expect(rpcCalls).not.toContain("resolve_new_client_waitlist_invitation");
    expect(redeemed()).toBe(false);
    // The existing-client lookup finds nobody in this fixture, so it refuses --
    // on the EXISTING-client rule, not on admission.
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).not.toBe("new_client_waitlist");
  });
});

// ===========================================================================
// P2-1 — a CONSUMED invitation plus a failed booking is its own outcome.
// ===========================================================================
//
// The defect this closes: the redeem succeeded, so the offer is spent, but the
// booking command then refused and the visitor was told "That time is no longer
// available. Please choose another time." That invites them back to a link that
// can no longer book anything, and the second attempt fails with a message
// explaining none of it.

describe("P2-1 — the invitation is spent and the booking did not commit", () => {
  const RETRYABLE = /choose another time|no longer available/i;

  it("POSITIVE CONTROL: authorise + consume + created still succeeds", async () => {
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(true);
    expect(redeemed()).toBe(true);
    expect(booked()).toBe(true);
  });

  it.each([
    "time_unavailable",
    "outside_availability",
    "studio_closed",
    "invalid_time",
    "not_a_public_slot",
    "outside_horizon",
    "public_booking_unavailable",
  ])("reports a consumed invitation, not a retryable slot, when booking answers %s", async (code) => {
    scenario.bookingResult = code;
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(redeemed()).toBe(true);
    expect(out.code).toBe("invitation_consumed");
    // THE LOAD-BEARING ASSERTION: the copy must not imply the invitation can be
    // used again.
    expect(out.error).not.toMatch(RETRYABLE);
    expect(out.code).not.toBe("slot_taken");
  });

  it("covers a TRANSPORT failure too — spent with no booking either way", async () => {
    scenario.bookingError = { message: "connection reset" };
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(redeemed()).toBe(true);
    expect(out.code).toBe("invitation_consumed");
    expect(out.error).not.toMatch(RETRYABLE);
  });

  it("records the consumed invitation id, and never the token or capability", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logged.push(String(a[0]));
    });
    scenario.bookingResult = "time_unavailable";
    await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    spy.mockRestore();
    const line = logged.find((l) => l.includes("waitlist_invitation_consumed_without_booking"));
    expect(line, "the consumed-without-booking event must be recorded").toBeTruthy();
    const event = JSON.parse(line as string);
    expect(event.invitationId).toBe("inv-1");
    expect(event.code).toBe("time_unavailable");
    // Secrets must never reach a log line.
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain(CAP);
  });

  it("does NOT claim a consumed invitation when the redeem never succeeded", async () => {
    scenario.redeemResult = "proof_expired";
    scenario.bookingResult = "time_unavailable";
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    // Refused at the gate, nothing spent -- this is the refused code, not consumed.
    expect(out.code).toBe("invitation_refused");
    expect(booked()).toBe(false);
  });

  it("leaves the ordinary non-invitation booking path untouched", async () => {
    // An EXISTING client with no invitation still gets the retryable slot copy:
    // nothing was consumed, so "choose another time" is the correct answer.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "some-other-studio";
    scenario.bookingResult = "time_unavailable";
    const out = await publicBookAppointmentAction(form());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("slot_taken");
    expect(out.error).toMatch(RETRYABLE);
  });
});

// P3-A. `created` with no appointment_id must not slip past the consumed guard.
describe("P3-A — an internally inconsistent booking command still fails closed", () => {
  it("reports the consumed invitation when created carries no appointment id", async () => {
    scenario.suppressAppointmentId = true;
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(redeemed()).toBe(true);
    // Before the fix this fell through to the GENERIC error: spent invitation,
    // no invitation_consumed code, and no consumed-without-booking event.
    expect(out.code).toBe("invitation_consumed");
    expect(out.error).not.toMatch(/choose another time|no longer available/i);
  });

  it("still records the consumed-without-booking event in that case", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logged.push(String(a[0]));
    });
    scenario.suppressAppointmentId = true;
    await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    spy.mockRestore();
    const line = logged.find((l) => l.includes("waitlist_invitation_consumed_without_booking"));
    expect(line, "the event must fire for created-without-id too").toBeTruthy();
    expect(JSON.parse(line as string).invitationId).toBe("inv-1");
  });
});

// P2-A. The in-code recovery guidance must not claim a reissue that the accepted
// contract cannot perform: release_new_client_waitlist_entry answers
// `already_redeemed` once redeemed, so the only real recovery is direct operator
// booking. This is a source guard because the defect WAS a false comment.
describe("P2-A — the documented recovery path is the one that exists", () => {
  const SOURCES = [
    "app/book/[slug]/actions.ts",
    "lib/booking/waitlist-invitation.ts",
  ];

  it("never claims a consumed invitation can be reissued", async () => {
    const { readFileSync } = await import("node:fs");
    for (const path of SOURCES) {
      const src = readFileSync(path, "utf8");
      // The false claims that were actually present, in both their phrasings.
      expect(src, `${path} must not claim reissue`).not.toMatch(
        /which an operator can reissue/i,
      );
      expect(src, `${path} must not claim reissue`).not.toMatch(
        /find and reissue the offer/i,
      );
    }
  });

  it("names the real recovery path where the consumed case is documented", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/book/[slug]/actions.ts", "utf8");
    expect(src).toMatch(/already_redeemed/);
    expect(src).toMatch(/operator surface/i);
  });
});

// ===========================================================================
// P2-A — AN INVITATION IS NOT AN EXEMPTION FROM THE NEW-CLIENT SERVICE RULE
// ===========================================================================
//
// The ruling for this launch: a waitlist invite-to-book is the NEW-CLIENT
// CONSULTATION path. The tempting repair -- teach the booking command to accept
// any service "because an invitation says so" -- would let an unconsulted new
// client book an arbitrary treatment, which is precisely what the
// consultation-first rule exists to prevent.
//
// So the rule is UNCHANGED here and enforced earlier instead: the recipient
// route refuses to render such an offer at all (see
// tests/app/invitation/recipient-actions.test.ts). These assert that the
// booking engine grew no invitation-shaped hole underneath it.

describe("P2-A — an authorised invitation buys no service exemption", () => {
  it("refuses a NON-CONSULTATION service even with a fully valid invitation", async () => {
    scenario.serviceModality = "laser";
    scenario.serviceName = "Laser — full leg";
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toMatch(/must book a consultation/i);
    expect(booked()).toBe(false);
  });

  it("refuses it with the waitlist flag OFF too — the rule is not the flag's", async () => {
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "some-other-studio";
    scenario.serviceModality = "laser";
    scenario.serviceName = "Laser — full leg";
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    expect(booked()).toBe(false);
  });

  // THE INVITATION SURVIVES THE REFUSAL. The service guard sits BEFORE the
  // consume, so a recipient whose offer names the wrong service does not also
  // lose it -- the operator can still release and reissue.
  it("does NOT consume the invitation on that refusal", async () => {
    scenario.serviceModality = "laser";
    await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(redeemed()).toBe(false);
    expect(dbWrites).toEqual([]);
  });

  it("refuses a DEACTIVATED service, and consumes nothing", async () => {
    scenario.serviceActive = false;
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toMatch(/no longer available/i);
    expect(redeemed()).toBe(false);
    expect(booked()).toBe(false);
  });

  // NON-VACUITY. Without this the block above could pass because the fixture
  // refuses everything.
  it("POSITIVE CONTROL — the eligible consultation journey still books", async () => {
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(true);
    expect(redeemed()).toBe(true);
    expect(booked()).toBe(true);
  });

  // The name fallback is part of the SHARED rule, so a studio that never set
  // `modality` is served identically by both surfaces.
  it("POSITIVE CONTROL — an unset modality named like a consultation books", async () => {
    scenario.serviceModality = null;
    scenario.serviceName = "New Client Consultation";
    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP }),
    );
    expect(out.ok).toBe(true);
    expect(booked()).toBe(true);
  });
});

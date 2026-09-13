import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NEW_CLIENT_WAITLIST_SLUGS_ENV } from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// WAIT-03 — REDEEM -> BOOK -> RECORD. The entry must not stay `invited`.
// ===========================================================================
//
// The defect this file exists for: a successful invitation booking redeemed the
// invitation, created the appointment, and then dropped the redemption's own
// `entryId` on the floor. Nothing ever called
// `record_new_client_waitlist_conversion`, so the prospect walked away with a
// confirmed appointment while the queue still showed them waiting to hear back
// -- and the next operator sweep could invite the same person again.
//
// WHY THE FAKE DATABASE HAS A STATE MACHINE. A call-count assertion would pass
// for a conversion issued with the wrong entry id, in the wrong order, or
// against an entry nobody had redeemed. So the fake below implements the
// REFUSAL RULES MIGRATION 0192 ACTUALLY SHIPS -- a redeemed invitation is
// required, the entry must be `invited`, the client must be the studio's -- and
// the tests then ask the product's own question: what state is the entry in
// when the booking is finished? That is a question a count cannot answer and a
// source grep cannot reach.
//
// Every control here is behavioural. Nothing in this file reads the source of
// the action it drives.

const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const APPT_ID = "66666666-6666-4666-8666-666666666666";

// DELIBERATELY DISTINCT from every other id in scope. The conversion must carry
// the id the REDEMPTION returned, so a test that reused CLIENT_ID or the
// invitation id could not tell a correct implementation from one that guessed.
const ENTRY_ID = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";
const INVITATION_ID = "11111111-1111-4111-8111-111111111111";

// The three client identities, one per resolution branch.
const NEW_CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const EXISTING_CLIENT_ID = "44444444-4444-4444-8444-444444444444";
const RACE_WINNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const SLUG = "waitlisted-studio";
const TOKEN = "a".repeat(64);
const CAP = "b".repeat(64);
const INVITED_EMAIL = "chloe@example.test";
const INVITED_HASH = createHash("sha256").update(INVITED_EMAIL, "utf8").digest("hex");

const START = new Date("2026-10-07T14:00:00.000Z");
const START_ISO = START.toISOString();

type RpcCall = { fn: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];
const logLines: string[] = [];

// ---------------------------------------------------------------------------
// The fake queue. Not a spy: it enforces 0192's own preconditions, so a
// conversion issued at the wrong moment is REFUSED here exactly as the database
// would refuse it, and the entry simply does not move.
// ---------------------------------------------------------------------------
const queue = {
  status: "invited" as "invited" | "converted",
  convertedClientId: null as string | null,
  convertedAt: null as string | null,
  /** Set by a successful redeem, read by the conversion precondition. */
  invitationRedeemed: false,
};

function recordConversion(args: Record<string, unknown>): string {
  const studioId = args.p_studio_id;
  const entryId = args.p_entry_id;
  const clientId = args.p_client_id;
  if (!studioId || !entryId || !clientId) return "invalid_input";
  // 0192: the client must belong to the studio.
  if (studioId !== STUDIO_ID) return "client_not_found";
  if (![NEW_CLIENT_ID, EXISTING_CLIENT_ID, RACE_WINNER_ID].includes(clientId as string)) {
    return "client_not_found";
  }
  // 0192: an id that is not this studio's entry matches no row at all.
  if (entryId !== ENTRY_ID) return "not_invited";
  // 0192: CONVERSION REQUIRES A REDEEMED INVITATION. `invited` alone only says
  // an operator sent one. This is the rule that catches a conversion hoisted
  // above the redemption.
  if (!queue.invitationRedeemed && queue.status === "invited") return "not_redeemed";
  // 0192: the stamp only ever moves `invited` -> `converted`, so a second call
  // is refused rather than re-stamped.
  if (queue.status !== "invited") return "not_invited";
  queue.status = "converted";
  queue.convertedClientId = clientId as string;
  queue.convertedAt = new Date().toISOString();
  return "converted";
}

const scenario = {
  clientPath: "new" as "new" | "existing" | "unique_race",
  redeemResult: "redeemed" as string,
  bookingResult: "created" as string,
  bookingError: null as { message: string; code?: string } | null,
  suppressAppointmentId: false,
  /** Transport failure from the conversion command (a PostgREST/network error). */
  conversionError: null as { message: string; code?: string } | null,
  /** An unexpected exception thrown by the conversion round trip. */
  conversionThrows: false,
  /** A closed refusal code the command may legitimately answer. */
  conversionResult: null as string | null,
  /**
   * The admin client itself fails to CONSTRUCT for the conversion. This is the
   * one throw the command binding's own try/catch cannot see, because the
   * factory is called before it -- so it is what proves the action's outer
   * post-commit guard is load-bearing rather than decorative.
   */
  adminFactoryThrows: false,
};

function makeChain(table: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain as never;
  let inserted = false;
  let archivedFiltered = false;
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
  const existingRow = {
    id: EXISTING_CLIENT_ID,
    name: "Chloe",
    email: INVITED_EMAIL,
    phone: null,
    sms_consent_at: null,
    sms_opted_out_at: null,
  };
  Object.assign(chain, {
    select: self,
    eq: self,
    not: self,
    in: self,
    order: self,
    limit: self,
    // `.is("archived_at", null)` is what distinguishes the ACTIVE-only
    // existing-client lookup from the unique-race winner re-read, which
    // deliberately drops that filter.
    is: () => {
      archivedFiltered = true;
      return chain as never;
    },
    insert: () => {
      inserted = true;
      return chain;
    },
    update: () => chain,
    delete: () => chain,
    upsert: () => chain,
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
        if (archivedFiltered) {
          // The up-front active-client lookup.
          return scenario.clientPath === "existing"
            ? { data: existingRow, error: null }
            : { data: null, error: null };
        }
        // The 23505 race-fallback re-read (no archived filter).
        return scenario.clientPath === "unique_race"
          ? {
              data: {
                id: RACE_WINNER_ID,
                name: "Chloe",
                phone: null,
                sms_consent_at: null,
                sms_opted_out_at: null,
                archived_at: null,
              },
              error: null,
            }
          : { data: null, error: null };
      }
      return { data: null, error: null };
    },
    single: async () => {
      if (table === "clients" && inserted) {
        if (scenario.clientPath === "unique_race") {
          // The partial unique index fires; the action re-reads the winner.
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        return {
          data: {
            id: NEW_CLIENT_ID,
            name: "Chloe",
            email: INVITED_EMAIL,
            phone: null,
            sms_consent_at: null,
            sms_opted_out_at: null,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
  });
  return chain;
}

const admin = {
  from: (table: string) => makeChain(table),
  rpc: async (fn: string, args: Record<string, unknown> = {}) => {
    rpcCalls.push({ fn, args });
    if (fn === "resolve_new_client_waitlist_invitation") {
      return {
        data: [
          {
            result: "live",
            invitation_id: INVITATION_ID,
            studio_id: STUDIO_ID,
            entry_id: ENTRY_ID,
            scope_service_id: SERVICE_ID,
            scope_start_date: "2026-10-01",
            scope_end_date: "2026-10-31",
            scope_allowed_weekdays: null,
            expires_at: "2026-10-31T12:00:00Z",
            recipient_contact_hash: INVITED_HASH,
          },
        ],
        error: null,
      };
    }
    if (fn === "redeem_new_client_waitlist_invitation_verified") {
      if (scenario.redeemResult === "redeemed") queue.invitationRedeemed = true;
      return {
        data: [
          {
            result: scenario.redeemResult,
            studio_id: STUDIO_ID,
            entry_id: ENTRY_ID,
          },
        ],
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
            starts_at: START_ISO,
            ends_at: new Date(START.getTime() + 45 * 60_000).toISOString(),
            duration_minutes: 45,
            practitioner_id: null,
          },
        ],
        error: null,
      };
    }
    if (fn === "record_new_client_waitlist_conversion") {
      if (scenario.conversionThrows) throw new TypeError("conversion round trip exploded");
      if (scenario.conversionError) return { data: null, error: scenario.conversionError };
      if (scenario.conversionResult) return { data: scenario.conversionResult, error: null };
      return { data: recordConversion(args), error: null };
    }
    return { data: null, error: null };
  },
};

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    // Only AFTER the booking, so the action's own client is unaffected and the
    // appointment still commits -- the precondition the law is about.
    if (scenario.adminFactoryThrows && rpcCalls.some((c) => c.fn === "create_public_appointment")) {
      throw new TypeError("admin client unavailable");
    }
    return admin;
  },
}));
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
    name: "Waitlisted Studio",
    owner_email: "owner@studio.test",
    timezone: "America/Toronto",
    default_appointment_duration_minutes: 45,
    buffer_minutes: 0,
    public_booking_horizon_months: 6,
    send_confirmation_emails: false,
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

const invited = () => form({ invitation_token: TOKEN, invitation_capability: CAP });

const conversions = () => rpcCalls.filter((c) => c.fn === "record_new_client_waitlist_conversion");
const indexOfCall = (fn: string) => rpcCalls.findIndex((c) => c.fn === fn);

beforeEach(() => {
  process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = SLUG;
  rpcCalls.length = 0;
  logLines.length = 0;
  Object.assign(queue, {
    status: "invited",
    convertedClientId: null,
    convertedAt: null,
    invitationRedeemed: false,
  });
  Object.assign(scenario, {
    clientPath: "new",
    redeemResult: "redeemed",
    bookingResult: "created",
    bookingError: null,
    suppressAppointmentId: false,
    conversionError: null,
    conversionThrows: false,
    conversionResult: null,
    adminFactoryThrows: false,
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
});

// ===========================================================================
// A + the journey. The entry must END CONVERTED.
// ===========================================================================

describe("a successful invitation booking converts the entry", () => {
  it("JOURNEY — invited, redeemed, booked, and the entry ends CONVERTED", async () => {
    expect(queue.status, "the fixture must start where the product does").toBe("invited");

    const out = await publicBookAppointmentAction(invited());

    expect(out.ok).toBe(true);
    // The product's own question, asked of the queue rather than of a spy.
    expect(queue.status).toBe("converted");
    expect(queue.convertedClientId).toBe(NEW_CLIENT_ID);
    expect(queue.convertedAt).not.toBeNull();
  });

  it("A — conversion is issued EXACTLY ONCE, with studio, entry and client", async () => {
    await publicBookAppointmentAction(invited());

    expect(conversions()).toHaveLength(1);
    expect(conversions()[0].args).toEqual({
      p_studio_id: STUDIO_ID,
      p_entry_id: ENTRY_ID,
      p_client_id: NEW_CLIENT_ID,
    });
  });

  it("carries the REDEMPTION's entry id, not the invitation's and not the client's", async () => {
    await publicBookAppointmentAction(invited());

    const sent = conversions()[0].args.p_entry_id;
    const redeem = rpcCalls.find((c) => c.fn === "redeem_new_client_waitlist_invitation_verified");
    expect(redeem, "the redemption must have happened").toBeTruthy();
    expect(sent).toBe(ENTRY_ID);
    // Non-vacuity: these are all genuinely different values, so the assertion
    // above could have failed.
    expect(sent).not.toBe(INVITATION_ID);
    expect(sent).not.toBe(NEW_CLIENT_ID);
    expect(sent).not.toBe(STUDIO_ID);
  });

  it("ignores an entry id smuggled through the browser payload", async () => {
    const other = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await publicBookAppointmentAction(
      form({
        invitation_token: TOKEN,
        invitation_capability: CAP,
        entry_id: other,
        p_entry_id: other,
      }),
    );

    expect(conversions()[0].args.p_entry_id).toBe(ENTRY_ID);
    expect(queue.status).toBe("converted");
  });
});

// ===========================================================================
// B. ORDER. The record may only ever be late, never early.
// ===========================================================================

describe("B — conversion happens AFTER the appointment command returns created", () => {
  it("the recorded call order is redeem -> create -> record", async () => {
    await publicBookAppointmentAction(invited());

    const redeemAt = indexOfCall("redeem_new_client_waitlist_invitation_verified");
    const bookAt = indexOfCall("create_public_appointment");
    const convertAt = indexOfCall("record_new_client_waitlist_conversion");

    expect(redeemAt).toBeGreaterThanOrEqual(0);
    expect(bookAt).toBeGreaterThan(redeemAt);
    expect(convertAt).toBeGreaterThan(bookAt);
  });

  it("the appointment id the booking returned already exists when it records", async () => {
    await publicBookAppointmentAction(invited());
    // A conversion issued before the command could not have observed this.
    const bookAt = indexOfCall("create_public_appointment");
    const convertAt = indexOfCall("record_new_client_waitlist_conversion");
    expect(rpcCalls.slice(0, convertAt).some((c) => c.fn === "create_public_appointment")).toBe(
      true,
    );
    expect(bookAt).toBeLessThan(convertAt);
  });
});

// ===========================================================================
// D + E. The two paths that must record NOTHING.
// ===========================================================================

describe("D — ordinary public booking is untouched", () => {
  it("a non-invitation booking issues ZERO conversions", async () => {
    // No waitlist studio, no invitation: the ordinary public journey.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "some-other-studio";

    const out = await publicBookAppointmentAction(form());

    expect(out.ok).toBe(true);
    expect(conversions()).toHaveLength(0);
    expect(queue.status).toBe("invited");
    // Non-vacuity: the booking really did happen on this path.
    expect(indexOfCall("create_public_appointment")).toBeGreaterThanOrEqual(0);
  });

  it("an EXISTING client booking without an invitation issues ZERO conversions", async () => {
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "some-other-studio";
    scenario.clientPath = "existing";

    const out = await publicBookAppointmentAction(form({ client_type: "existing" }));

    expect(out.ok).toBe(true);
    expect(conversions()).toHaveLength(0);
  });
});

describe("E — a spent invitation whose appointment failed records NOTHING", () => {
  it.each([
    ["a refused command", { bookingResult: "time_unavailable" }],
    ["a transport error", { bookingError: { message: "boom", code: "08006" } }],
    ["created with no appointment id", { suppressAppointmentId: true }],
  ])("%s — zero conversions, and the entry stays invited", async (_label, over) => {
    Object.assign(scenario, over);

    const out = await publicBookAppointmentAction(invited());

    expect(out.ok).toBe(false);
    expect(conversions()).toHaveLength(0);
    expect(queue.status).toBe("invited");
    expect(queue.convertedClientId).toBeNull();
  });

  it("the existing invitation_consumed recovery behaviour is intact", async () => {
    scenario.bookingResult = "time_unavailable";

    const out = await publicBookAppointmentAction(invited());

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("invitation_consumed");
    expect(out.error).toContain("Please contact the studio to rebook");
    expect(
      logLines.some((l) => l.includes("waitlist_invitation_consumed_without_booking")),
      "the recovery event must still be emitted",
    ).toBe(true);
  });

  it("a REFUSED redemption never reaches the conversion", async () => {
    scenario.redeemResult = "proof_invalid";

    const out = await publicBookAppointmentAction(invited());

    expect(out.ok).toBe(false);
    expect(conversions()).toHaveLength(0);
    expect(indexOfCall("create_public_appointment")).toBe(-1);
    expect(queue.status).toBe("invited");
  });
});

// ===========================================================================
// F. POST-COMMIT FAILURE LAW.
// ===========================================================================

describe("F — a conversion failure never turns a committed booking into a failure", () => {
  const EVENT = "public_booking_waitlist_conversion_not_recorded";

  it.each([
    ["a transport error", { conversionError: { message: "gateway down", code: "08006" } }],
    ["an unexpected exception", { conversionThrows: true }],
    ["an unrecognised result", { conversionResult: "some_new_code" }],
    ["a closed refusal", { conversionResult: "not_redeemed" }],
  ])("%s — the client still receives the successful booking", async (_label, over) => {
    Object.assign(scenario, over);

    const out = await publicBookAppointmentAction(invited());

    expect(out.ok, "a durable appointment must never be reported as a failure").toBe(true);
    if (!out.ok) throw new Error("unreachable");
    // The full success payload survives, not a degraded one.
    expect(out.appointmentId).toBe(APPT_ID);
    expect(out.manageUrl).toContain("https://studio.example.test");
  });

  it.each([
    ["a transport error", { conversionError: { message: "gateway down", code: "08006" } }],
    ["an unexpected exception", { conversionThrows: true }],
    ["an unrecognised result", { conversionResult: "some_new_code" }],
    ["a closed refusal", { conversionResult: "not_redeemed" }],
  ])("%s — sanitized operational evidence is emitted", async (_label, over) => {
    Object.assign(scenario, over);

    await publicBookAppointmentAction(invited());

    const evidence = logLines.filter((l) => l.includes(EVENT));
    expect(evidence, "failing silently is not fail-soft").toHaveLength(1);
    // Enough to locate all three rows by hand.
    expect(evidence[0]).toContain(APPT_ID);
    expect(evidence[0]).toContain(INVITATION_ID);
    expect(evidence[0]).toContain(ENTRY_ID);
    expect(evidence[0]).toContain(STUDIO_ID);
  });

  it("no secret ever reaches the log", async () => {
    scenario.conversionError = { message: "gateway down", code: "08006" };

    await publicBookAppointmentAction(invited());

    for (const line of logLines) {
      expect(line, "raw invitation token").not.toContain(TOKEN);
      expect(line, "raw capability").not.toContain(CAP);
      expect(line, "recipient address").not.toContain(INVITED_EMAIL);
      expect(line, "raw DB message").not.toContain("gateway down");
    }
    // Non-vacuity: the log is not empty, so the loop above really inspected it.
    expect(logLines.some((l) => l.includes(EVENT))).toBe(true);
  });

  it("NO BLIND RETRY — the failed conversion is attempted once and not repeated", async () => {
    scenario.conversionError = { message: "gateway down", code: "08006" };

    await publicBookAppointmentAction(invited());

    expect(conversions()).toHaveLength(1);
    // And nothing tries to re-redeem or reissue the spent invitation.
    expect(
      rpcCalls.filter((c) => c.fn === "redeem_new_client_waitlist_invitation_verified"),
    ).toHaveLength(1);
    expect(rpcCalls.map((c) => c.fn)).not.toContain(
      "issue_scoped_new_client_waitlist_invitation",
    );
    expect(rpcCalls.map((c) => c.fn)).not.toContain("release_new_client_waitlist_entry");
  });

  it("the OUTER post-commit guard is load-bearing: a throw the binding cannot see", async () => {
    // The command binding catches its own round-trip failures, so its `try`
    // would make the action's wrapper look unnecessary. It is not: the admin
    // client is constructed BEFORE that try, and a factory that throws escapes
    // the binding entirely. Without the wrapper this is an unhandled exception
    // after a durable commit -- the booking succeeds and the visitor is told it
    // failed.
    scenario.adminFactoryThrows = true;

    const out = await publicBookAppointmentAction(invited());

    expect(out.ok, "a durable appointment must survive a throw from the factory").toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.appointmentId).toBe(APPT_ID);
    // Both traces: the wrapper's own, and the one naming the entry to repair.
    expect(logLines.some((l) => l.includes("public_booking_waitlist_conversion_threw"))).toBe(
      true,
    );
    expect(logLines.filter((l) => l.includes(EVENT))).toHaveLength(1);
    // The command was never reached, so nothing was converted and nothing retried.
    expect(conversions()).toHaveLength(0);
    expect(queue.status).toBe("invited");
  });

  it("a SUCCESSFUL conversion is silent — the evidence log is for failures only", async () => {
    await publicBookAppointmentAction(invited());

    expect(queue.status).toBe("converted");
    expect(logLines.filter((l) => l.includes(EVENT))).toHaveLength(0);
  });
});

// ===========================================================================
// G. The client id is the RESOLVED one, on every branch that can reach a
// booking.
// ===========================================================================

describe("G — every client resolution path converts the client it actually booked", () => {
  // ALL THREE POST `client_type=new`, because that is the only declaration an
  // invitation booking can carry (see the boundary test below). The branch is
  // then chosen by what the CLIENTS TABLE holds, not by what the form claimed:
  //   * no active row      -> INSERT, the new-client branch;
  //   * an active row      -> the existing-client branch, reached even though
  //                           the visitor called themselves new;
  //   * a 23505 collision  -> the unique-index race re-read.
  it.each([
    ["a brand new client", "new" as const, NEW_CLIENT_ID],
    ["an already-active client under the invited address", "existing" as const, EXISTING_CLIENT_ID],
    ["the unique-index race winner", "unique_race" as const, RACE_WINNER_ID],
  ])("%s", async (_label, path, expectedClientId) => {
    scenario.clientPath = path;

    const out = await publicBookAppointmentAction(invited());

    expect(out.ok).toBe(true);
    // The SAME id the appointment command was given -- read from the recorded
    // call rather than from the constant, so a divergence between the two is
    // what fails.
    const booked = rpcCalls.find((c) => c.fn === "create_public_appointment");
    expect(booked?.args.p_client_id).toBe(expectedClientId);
    expect(conversions()[0].args.p_client_id).toBe(expectedClientId);
    expect(booked?.args.p_client_id).toBe(conversions()[0].args.p_client_id);
    expect(queue.convertedClientId).toBe(expectedClientId);
  });

  it("the three branches really do resolve to three different clients", () => {
    // Non-vacuity for the table above: if they collapsed to one id, every row
    // would pass regardless of which branch ran.
    expect(new Set([NEW_CLIENT_ID, EXISTING_CLIENT_ID, RACE_WINNER_ID]).size).toBe(3);
  });

  // -------------------------------------------------------------------------
  // THE BOUNDARY, recorded rather than assumed. A visitor who declares
  // themselves an EXISTING client never enters the invitation block at all --
  // it is gated on `clientType === "new"` (WAIT-03B B2's admission gate, which
  // this change does not touch). So there is no redemption on that path, and
  // therefore no conversion to skip: the offer is not spent, and the entry is
  // correctly still `invited`.
  //
  // This is asserted so the zero-conversion result above is understood as the
  // gate's doing and not as a dropped record. If the gate is ever widened to
  // admit a self-declared existing client, this test goes red and the
  // conversion call must be reconsidered with it.
  // -------------------------------------------------------------------------
  it("a SELF-DECLARED existing client never reaches an invitation booking", async () => {
    scenario.clientPath = "existing";

    const out = await publicBookAppointmentAction(
      form({ invitation_token: TOKEN, invitation_capability: CAP, client_type: "existing" }),
    );

    expect(out.ok).toBe(true);
    // Nothing was consumed, so nothing was converted -- and the offer survives.
    expect(indexOfCall("redeem_new_client_waitlist_invitation_verified")).toBe(-1);
    expect(conversions()).toHaveLength(0);
    expect(queue.invitationRedeemed).toBe(false);
    expect(queue.status).toBe("invited");
  });
});

// ===========================================================================
// The fake's own refusal rules are real rules, not decoration.
// ===========================================================================

describe("the fixture enforces 0192's preconditions (so the controls above can bite)", () => {
  it("refuses a conversion on an entry with no redeemed invitation", () => {
    queue.invitationRedeemed = false;
    expect(
      recordConversion({
        p_studio_id: STUDIO_ID,
        p_entry_id: ENTRY_ID,
        p_client_id: NEW_CLIENT_ID,
      }),
    ).toBe("not_redeemed");
    expect(queue.status).toBe("invited");
  });

  it("refuses a second conversion rather than re-stamping", () => {
    queue.invitationRedeemed = true;
    expect(
      recordConversion({
        p_studio_id: STUDIO_ID,
        p_entry_id: ENTRY_ID,
        p_client_id: NEW_CLIENT_ID,
      }),
    ).toBe("converted");
    expect(
      recordConversion({
        p_studio_id: STUDIO_ID,
        p_entry_id: ENTRY_ID,
        p_client_id: EXISTING_CLIENT_ID,
      }),
    ).toBe("not_invited");
    expect(queue.convertedClientId, "the first client wins").toBe(NEW_CLIENT_ID);
  });

  it("refuses a client that is not the studio's, and a null argument", () => {
    queue.invitationRedeemed = true;
    expect(
      recordConversion({
        p_studio_id: STUDIO_ID,
        p_entry_id: ENTRY_ID,
        p_client_id: "99999999-9999-4999-8999-999999999999",
      }),
    ).toBe("client_not_found");
    expect(
      recordConversion({ p_studio_id: STUDIO_ID, p_entry_id: null, p_client_id: NEW_CLIENT_ID }),
    ).toBe("invalid_input");
    expect(queue.status).toBe("invited");
  });
});

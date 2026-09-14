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
  /** What 0195 answers for an INVITATION booking. Its refusals roll the whole
   *  transaction back, so a refusal here must leave the queue untouched. */
  waitlistResult: "created_and_converted" as string,
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
    if (fn === "create_waitlist_public_appointment") {
      if (scenario.bookingError) return { data: null, error: scenario.bookingError };
      const empty = {
        appointment_id: null,
        created_at: null,
        starts_at: null,
        ends_at: null,
        duration_minutes: null,
        practitioner_id: null,
      };
      // ATOMIC, AND THE FAKE HONOURS IT. A refusal rolls everything back, so
      // the queue must not move — that is what makes the refusal tests able to
      // tell "nothing happened" from "booked but not converted", the very state
      // 0195 exists to make unreachable.
      if (scenario.waitlistResult !== "created_and_converted") {
        return { data: [{ result: scenario.waitlistResult, ...empty }], error: null };
      }
      // The conversion runs INSIDE the same command, against 0192's own
      // preconditions, so a conversion refusal takes the appointment with it.
      const conv = recordConversion(args);
      if (conv !== "converted") {
        return { data: [{ result: `conversion:${conv}`, ...empty }], error: null };
      }
      return {
        data: [
          {
            result: "created_and_converted",
            appointment_id: scenario.suppressAppointmentId ? null : APPT_ID,
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
    if (
      scenario.adminFactoryThrows &&
      rpcCalls.some((c) =>
        ["create_public_appointment", "create_waitlist_public_appointment"].includes(c.fn),
      )
    ) {
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
/** Calls to the atomic command 0195 owns. */
const atomicBookings = () => rpcCalls.filter((c) => c.fn === "create_waitlist_public_appointment");
/** Calls to the ordinary, non-invitation booking command. */
const ordinaryBookings = () => rpcCalls.filter((c) => c.fn === "create_public_appointment");
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
    waitlistResult: "created_and_converted",
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

describe("A — a successful invitation booking converts the entry, atomically", () => {
  it("JOURNEY — invited, redeemed, booked and converted by ONE command", async () => {
    const res = await publicBookAppointmentAction(invited());
    expect(res.ok).toBe(true);
    // The entry moved, and the thing that moved it was the booking command.
    expect(queue.status).toBe("converted");
    expect(queue.convertedClientId).toBe(NEW_CLIENT_ID);
  });

  it("calls 0195 EXACTLY ONCE, and never the ordinary command beside it", async () => {
    await publicBookAppointmentAction(invited());
    expect(atomicBookings()).toHaveLength(1);
    // NOT "as well as". An invitation booking that also ran the ordinary
    // command would be two appointments' worth of intent for one visitor.
    expect(ordinaryBookings()).toHaveLength(0);
  });

  it("there is NO second conversion writer", async () => {
    // THE POINT OF THE BINDING. The application used to record the conversion
    // itself after the commit; 0195 owns it now, and the old caller is gone.
    await publicBookAppointmentAction(invited());
    expect(conversions()).toHaveLength(0);
  });

  it("passes authoritative studio, entry, client, service and time", async () => {
    await publicBookAppointmentAction(invited());
    const call = atomicBookings()[0];
    expect(call.args.p_studio_id).toBe(STUDIO_ID);
    expect(call.args.p_client_id).toBe(NEW_CLIENT_ID);
    expect(call.args.p_service_id).toBe(SERVICE_ID);
    expect(call.args.p_starts_at).toBe(START_ISO);
    // THE REDEMPTION'S ENTRY, not the invitation's and not the client's.
    expect(call.args.p_entry_id).toBe(ENTRY_ID);
    expect(call.args.p_entry_id).not.toBe(INVITATION_ID);
    expect(call.args.p_entry_id).not.toBe(NEW_CLIENT_ID);
  });

  it("ignores an entry id smuggled through the browser payload", async () => {
    const forged = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await publicBookAppointmentAction(
      form({
        invitation_token: TOKEN,
        invitation_capability: CAP,
        entry_id: forged,
        p_entry_id: forged,
        studio_id: forged,
      }),
    );
    const call = atomicBookings()[0];
    expect(call.args.p_entry_id).toBe(ENTRY_ID);
    expect(call.args.p_studio_id).toBe(STUDIO_ID);
  });

  it("redeems BEFORE it books, and books once", async () => {
    await publicBookAppointmentAction(invited());
    const redeem = indexOfCall("redeem_new_client_waitlist_invitation_verified");
    const book = indexOfCall("create_waitlist_public_appointment");
    expect(redeem).toBeGreaterThan(-1);
    expect(book).toBeGreaterThan(redeem);
  });
});

describe("B — 0195 refusals are refusals, and nothing is retried", () => {
  // Every 0195 refusal that is NOT about the calendar. Each must fail closed:
  // no success, no second booking attempt, no standalone conversion.
  const INVITATION_REFUSALS = [
    "not_redeemed",
    "recipient_mismatch",
    "scope_ambiguous",
    "scope_service_not_offered",
    "scope_date_out_of_range",
    "scope_weekday_not_allowed",
    "entry_not_found",
    "client_not_found",
    "invalid_input",
  ];

  for (const refusal of INVITATION_REFUSALS) {
    it(`${refusal} is never rendered as a booking`, async () => {
      scenario.waitlistResult = refusal;
      const res = await publicBookAppointmentAction(invited());
      expect(res.ok, `${refusal} read as success`).toBe(false);
      // ONE attempt. A refused invitation booking must not be retried, because
      // the invitation is already spent and the second attempt cannot succeed.
      expect(atomicBookings()).toHaveLength(1);
      expect(ordinaryBookings()).toHaveLength(0);
      expect(conversions()).toHaveLength(0);
      // NOTHING IS RE-DRIVEN. The invitation is already spent, so re-redeeming,
      // reissuing or releasing it would loop rather than heal — these were
      // asserted before the binding and must stay asserted after it.
      for (const fn of [
        "redeem_new_client_waitlist_invitation_verified",
        "issue_scoped_new_client_waitlist_invitation",
        "release_new_client_waitlist_entry",
      ]) {
        expect(
          rpcCalls.filter((c) => c.fn === fn).length,
          `${fn} was driven again after ${refusal}`,
        ).toBeLessThanOrEqual(fn.startsWith("redeem") ? 1 : 0);
      }
      // Rolled back: the entry did not move.
      expect(queue.status).toBe("invited");
    });
  }

  it("an UNRECOGNISED result fails closed rather than being waved through", async () => {
    // A result 0195 gains later, or a vocabulary drift. It must not become a
    // booking, and it must not be explained to the visitor as if understood.
    for (const unknown of ["newly_invented_refusal", "created", "", "converted"]) {
      rpcCalls.length = 0;
      Object.assign(queue, { status: "invited", invitationRedeemed: false });
      scenario.waitlistResult = unknown;
      const res = await publicBookAppointmentAction(invited());
      expect(res.ok, `${JSON.stringify(unknown)} read as success`).toBe(false);
      expect(queue.status).toBe("invited");
    }
  });

  it("a CONVERSION refusal takes the appointment with it", async () => {
    // The state this binding makes unreachable: booked but still `invited`.
    // 0195 rolls the appointment back, so the visitor is not told they booked.
    // 0195 re-emits the nested conversion's own word under a `conversion:`
    // prefix after rolling the appointment back. Driving it directly is what
    // tests the BINDING; setting the fixture's precondition instead did not,
    // because the action's own redeem step satisfies it again on the way past.
    scenario.waitlistResult = "conversion:not_redeemed";
    const res = await publicBookAppointmentAction(invited());
    // ASSERTED, NOT GUARDED. Wrapping these in `if (!res.ok)` meant a mapping
    // regression that read `conversion:*` as success would pass this test with
    // zero assertions run.
    expect(res.ok).toBe(false);
    expect(queue.status).toBe("invited");
    expect(conversions()).toHaveLength(0);
  });

  it("a transport failure is not turned into a definite booking", async () => {
    scenario.bookingError = { message: "connection reset", code: "PGRST000" };
    const res = await publicBookAppointmentAction(invited());
    expect(res.ok).toBe(false);
    expect(atomicBookings()).toHaveLength(1);
    // NO AUTOMATIC RETRY. The response was lost; booking again could double it.
    expect(ordinaryBookings()).toHaveLength(0);
  });
});

describe("G/H — the atomic command is reachable ONLY by a proven invitation", () => {
  it("an ordinary visitor never reaches 0195", async () => {
    // The waitlist gate is what makes a new client need an invitation at all,
    // so the ordinary journey is a studio the gate does not cover.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "some-other-studio";
    const res = await publicBookAppointmentAction(form());
    expect(res.ok).toBe(true);
    // The ordinary command still books them, and the invitation command is not
    // consulted at all — the branch is on the server-derived redemption.
    expect(ordinaryBookings()).toHaveLength(1);
    expect(atomicBookings()).toHaveLength(0);
    expect(conversions()).toHaveLength(0);
  });

  it("a token WITHOUT a capability cannot reach 0195", async () => {
    // No proof, no redemption, so no entry id — and without one the atomic
    // command is not even a candidate.
    const res = await publicBookAppointmentAction(form({ invitation_token: TOKEN }));
    expect(res.ok).toBe(false);
    expect(atomicBookings()).toHaveLength(0);
    // AND NOT THROUGH THE ORDINARY COMMAND EITHER. Without this, "no proof
    // books through the other command" would satisfy the test above.
    expect(ordinaryBookings()).toHaveLength(0);
    expect(queue.status).toBe("invited");
  });

  it("a refused redemption cannot reach 0195", async () => {
    scenario.redeemResult = "already_redeemed";
    const res = await publicBookAppointmentAction(invited());
    expect(res.ok).toBe(false);
    expect(atomicBookings()).toHaveLength(0);
    expect(ordinaryBookings()).toHaveLength(0);
    expect(queue.status).toBe("invited");
  });
});

describe("the OUTER post-commit guard is still load-bearing", () => {
  it("a throw the command binding cannot see never un-books a durable booking", async () => {
    // RESTORED, ON THE PATH THAT STILL HAS ONE. The old version of this proof
    // rode on the post-commit conversion call, which 0195 removed — but
    // `postCommit` still wraps the confirmation email, the notification and the
    // revalidate, and the invariant is unchanged: once the command says the
    // appointment committed, nothing after it may turn that into `ok: false`.
    //
    // The admin client fails to CONSTRUCT, which is the one throw the command
    // binding's own try/catch cannot catch, because the factory runs before it.
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = "some-other-studio";
    scenario.adminFactoryThrows = true;

    const out = await publicBookAppointmentAction(form());

    expect(out.ok, "a post-commit throw flipped a durable booking to a failure").toBe(true);
    expect(indexOfCall("create_public_appointment")).toBeGreaterThanOrEqual(0);
  });
});

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

describe("E — a spent invitation whose booking failed leaves the entry alone", () => {
  it("a refused 0195 leaves the entry invited and records no conversion", async () => {
    scenario.waitlistResult = "scope_weekday_not_allowed";
    const res = await publicBookAppointmentAction(invited());
    expect(res.ok).toBe(false);
    expect(queue.status).toBe("invited");
    expect(conversions()).toHaveLength(0);
  });

  it("the existing invitation_consumed recovery behaviour is intact", async () => {
    // The redeem committed and the booking did not, which is still possible:
    // they are separate transactions by design, and 0195 cannot un-redeem.
    // What changed is only WHICH command failed.
    scenario.waitlistResult = "scope_date_out_of_range";
    const res = await publicBookAppointmentAction(invited());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invitation_consumed");
    // The operator evidence still names the invitation, and never a secret.
    const joined = logLines.join("\n");
    expect(joined).toContain(INVITATION_ID);
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain(CAP);
    expect(joined).not.toContain(INVITED_EMAIL);
  });

  it("`created_and_converted` with no appointment id fails closed", async () => {
    // An internally inconsistent answer is the one case worth refusing hardest:
    // the command claims it committed and cannot say what it committed.
    scenario.suppressAppointmentId = true;
    const res = await publicBookAppointmentAction(invited());
    expect(res.ok).toBe(false);
  });
});

describe("F — booked-but-unconverted is now unreachable, not merely logged", () => {
  it("there is no post-commit conversion left to fail", async () => {
    // THE WHOLE CLASS OF DEFECT THIS BINDING REMOVES. The old model committed
    // the appointment, then recorded the conversion, then logged if that
    // failed — leaving a booked client on an `invited` entry for an operator to
    // repair by hand. There is no second step now, so there is nothing to
    // half-complete.
    await publicBookAppointmentAction(invited());
    expect(conversions()).toHaveLength(0);
    expect(queue.status).toBe("converted");
  });

  it("success and conversion are the SAME answer, never two", async () => {
    // Either both happened or neither did. The fake enforces the atomicity, so
    // a success that left the entry invited would fail here.
    for (const result of ["created_and_converted", "not_redeemed", "recipient_mismatch"]) {
      rpcCalls.length = 0;
      Object.assign(queue, { status: "invited", invitationRedeemed: true, convertedClientId: null });
      scenario.waitlistResult = result;
      const res = await publicBookAppointmentAction(invited());
      expect(queue.status === "converted", `${result}`).toBe(res.ok);
    }
  });

  it("no secret ever reaches the log", async () => {
    scenario.waitlistResult = "recipient_mismatch";
    await publicBookAppointmentAction(invited());
    const joined = logLines.join("\n");
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain(CAP);
    expect(joined).not.toContain(INVITED_EMAIL);
    expect(joined).not.toContain(INVITED_HASH);
  });
});

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
    // ONE command now carries both, so "the client booked" and "the client
    // converted" cannot diverge — they are the same argument.
    const booked = rpcCalls.find((c) => c.fn === "create_waitlist_public_appointment");
    expect(booked?.args.p_client_id).toBe(expectedClientId);
    expect(queue.convertedClientId).toBe(expectedClientId);
    expect(conversions()).toHaveLength(0);
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

// ===========================================================================
// TRANSPORT AMBIGUITY — a lost response is not a rollback
// ===========================================================================
//
// 0195 writes the appointment, its mandatory audit row and the conversion in
// ONE transaction. If the response is lost, the transaction may have COMMITTED.
// Reporting that as "spent, nothing booked" tells the recipient to contact the
// studio for a booking they may already have, and tells the operator to create
// a second one.

describe("A — a transport failure on the atomic path is INDETERMINATE", () => {
  it("is never reported as consumed-without-booking", async () => {
    scenario.bookingError = { message: "connection reset", code: "PGRST000" };
    const out = await publicBookAppointmentAction(invited());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("invitation_booking_indeterminate");
    expect(out.code).not.toBe("invitation_consumed");
  });

  it("attempts the booking exactly ONCE and never falls back", async () => {
    scenario.bookingError = { message: "connection reset" };
    await publicBookAppointmentAction(invited());
    // E — the no-retry negative control. A second atomic call, an ordinary
    // fallback, or a standalone conversion would each be visible here.
    expect(atomicBookings()).toHaveLength(1);
    expect(ordinaryBookings()).toHaveLength(0);
    expect(conversions()).toHaveLength(0);
    for (const fn of [
      "issue_scoped_new_client_waitlist_invitation",
      "release_new_client_waitlist_entry",
    ]) {
      expect(rpcCalls.filter((c) => c.fn === fn)).toHaveLength(0);
    }
    expect(
      rpcCalls.filter((c) => c.fn === "redeem_new_client_waitlist_invitation_verified").length,
    ).toBeLessThanOrEqual(1);
  });

  it("logs an INDETERMINATE event, not a consumed-without-booking one", async () => {
    scenario.bookingError = { message: "connection reset" };
    await publicBookAppointmentAction(invited());
    const joined = logLines.join("\n");
    expect(joined).toContain("waitlist_invitation_booking_outcome_indeterminate");
    expect(joined).not.toContain("waitlist_invitation_consumed_without_booking");
    // Operator guidance: CHECK before booking, never "book the client directly".
    expect(joined).toContain("verify_appointment_exists_before_manual_booking");
    // Still no secrets.
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain(CAP);
    expect(joined).not.toContain(INVITED_EMAIL);
    expect(joined).not.toContain(INVITED_HASH);
  });

  it("F — the copy claims NEITHER outcome and never advises rebooking", async () => {
    scenario.bookingError = { message: "connection reset" };
    const out = await publicBookAppointmentAction(invited());
    if (out.ok) throw new Error("unreachable");
    const copy = out.error.toLowerCase();
    for (const forbidden of [
      "nothing is booked",
      "book the time for you",
      "rebook",
      "try another time",
      "choose another time",
      "try again",
    ]) {
      expect(copy, `indeterminate copy must not say "${forbidden}"`).not.toContain(forbidden);
    }
    // It must say what IS known: the invitation is spent, and the outcome is not
    // confirmed, so the studio has to check.
    expect(copy).toContain("couldn't confirm");
    expect(copy).toContain("contact the studio");
  });
});

describe("B — a DETERMINISTIC refusal still means no booking exists", () => {
  it("keeps consumed-without-booking, and cannot become indeterminate", async () => {
    // The command ANSWERED. Its answer was a refusal, so the transaction rolled
    // back and there is genuinely no appointment — a different fact from a lost
    // response, and it keeps its own code, copy and event.
    for (const refusal of ["scope_weekday_not_allowed", "not_redeemed", "recipient_mismatch"]) {
      rpcCalls.length = 0;
      logLines.length = 0;
      Object.assign(queue, { status: "invited", invitationRedeemed: false });
      scenario.bookingError = null;
      scenario.waitlistResult = refusal;
      const out = await publicBookAppointmentAction(invited());
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("unreachable");
      expect(out.code, refusal).toBe("invitation_consumed");
      expect(out.code).not.toBe("invitation_booking_indeterminate");
      expect(logLines.join("\n")).toContain("waitlist_invitation_consumed_without_booking");
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashAppointmentToken } from "@/lib/booking/appointment-token";

// ===========================================================================
// BOOK-01 Tranche 1, behavioural proof that a COMMITTED public booking leaves
// the client with a working management path, and that the copy stays truthful.
// ===========================================================================
//
// These are NOT source greps. The real server action runs against an in-memory
// fake, and the assertions are about the value it returns and the payloads it
// hands to every logging / analytics / bookkeeping collaborator.
//
// THE INVARIANT. Before this change the action returned `{ ok: true,
// appointmentId }` while holding a valid `/manage/<token>` URL in memory, and
// the confirmation card told the client their cancel/reschedule links were in
// an email that may never have arrived. The raw token is a one-time in-memory
// secret, only its SHA-256 is persisted, so discarding it discarded the
// client's in-band route to their own appointment.
//
// THE SECRECY WALL. The management URL is bearer authority. It may reach the
// authorised browser that just created the appointment and NOTHING else: not
// the database in plaintext, not a log line, not an analytics event, not an ops
// alert, not an audit row, not an error message. Every collaborator payload is
// captured below and swept for the raw token extracted from the returned URL.
//
// WHAT THIS DOES NOT CLAIM. If the process dies after the COMMIT but before the
// HTTP response reaches the browser, there is no response to carry the link.
// That case is covered by the pre-existing recovery paths (the authenticated
// client portal and the 24h/2h reminder passes, both of which mint a stateless
// HMAC management token from the appointment id), not by this response.

const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const APPT_ID = "66666666-6666-4666-8666-666666666666";
const ORIGIN = "https://studio.example.test";
const EMAIL = "booker@example.test";

// Far-future start so the past-time guard and the horizon check both pass.
const START = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const START_ISO = START.toISOString();

// --- captured collaborator traffic ----------------------------------------

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const consoleErrors: string[] = [];
const analyticsEvents: unknown[] = [];
const emailAttempts: unknown[] = [];
const emailFailures: unknown[] = [];
const conversions: unknown[] = [];
const practitionerNotifications: unknown[] = [];
const smsCalls: unknown[] = [];
const confirmationEmails: unknown[] = [];
const practitionerEmails: unknown[] = [];
const clientUpdates: unknown[] = [];

const scenario = {
  sendConfirmationEmails: true,
  emailOk: true,
  // BOOK-01 P2-A throw injection. Each flag makes one POST-COMMIT dependency
  // raise an unexpected exception. The thrown message deliberately carries a
  // POISON string so the secrecy assertions can prove `err.message` is never
  // recorded, a real template or provider error can carry the recipient
  // address or a URL embedding the raw token.
  originThrows: false,
  intakeThrows: false,
  treatmentTimeThrows: false,
  emailThrows: false,
  attemptWriteThrows: false,
  practitionerNotificationThrows: false,
  practitionerEmailThrows: false,
  revalidateThrows: false,
  showTreatmentTime: false,
  notifyPractitioner: false,
  commandRefuses: false,
};

/** Any real error message could carry a token or address; none may be logged. */
const POISON = "POISONED-secret-token-A1b2C3d4E5f6G7h8I9j0K1l2/manage/LEAKED";
const boom = (what: string) => new Error(`${what} exploded ${POISON}`);

// --- in-memory admin client ------------------------------------------------
//
// The chain is both thenable (for the count/list reads inside
// loadPublicReadiness) and terminal via maybeSingle()/single().

function makeChain(table: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain as never;
  const result = () => {
    if (table === "services") {
      // Two shapes: the count/head probe in loadPublicReadiness, and the
      // single-service select. maybeSingle() below serves the latter.
      return { count: 3, data: [], error: null };
    }
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
    select: self,
    eq: self,
    is: self,
    not: self,
    in: self,
    order: self,
    limit: self,
    insert: (payload: unknown) => {
      if (table === "clients") clientUpdates.push({ op: "insert", payload });
      return chain;
    },
    update: (payload: unknown) => {
      if (table === "clients") clientUpdates.push({ op: "update", payload });
      return chain;
    },
    upsert: (payload: unknown) => {
      clientUpdates.push({ op: "upsert", table, payload });
      return chain;
    },
    single: async () => chain.maybeSingle as never,
    maybeSingle: async () => {
      if (table === "services") {
        return {
          data: {
            id: SERVICE_ID,
            studio_id: STUDIO_ID,
            active: true,
            name: "Consultation",
            default_duration_minutes: 45,
            modality: "electrolysis",
            pre_care_instructions: null,
          },
          error: null,
        };
      }
      if (table === "clients") {
        return {
          data: {
            id: CLIENT_ID,
            name: "Booker",
            email: EMAIL,
            phone: "+15555550123",
            sms_consent_at: null,
            sms_opted_out_at: null,
          },
          error: null,
        };
      }
      if (table === "practitioners") {
        return {
          data: { id: "44444444-4444-4444-8444-444444444444", display_name: "Pract", email: "p@example.test" },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    // Thenable so `await admin.from(t).select(...).eq(...)` resolves.
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
  });
  return chain;
}

const admin = {
  from(table: string) {
    return makeChain(table);
  },
  async rpc(fn: string, args: Record<string, unknown>) {
    rpcCalls.push({ fn, args });
    if (fn === "create_public_appointment") {
      if (scenario.commandRefuses) {
        return { data: [{ result: "time_unavailable" }], error: null };
      }
      return {
        data: [
          {
            result: "created",
            appointment_id: APPT_ID,
            created_at: new Date().toISOString(),
            starts_at: START_ISO,
            ends_at: new Date(START.getTime() + 45 * 60_000).toISOString(),
            duration_minutes: 45,
            practitioner_id: "44444444-4444-4444-8444-444444444444",
          },
        ],
        error: null,
      };
    }
    return { data: null, error: null };
  },
};

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => admin }));
vi.mock("next/cache", () => ({
  revalidatePath: () => {
    if (scenario.revalidateThrows) throw boom("revalidatePath");
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitPublicBooking: async () => ({ allowed: true }),
  limitPublicSlots: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: () => {
    if (scenario.originThrows) throw boom("app origin");
    return ORIGIN;
  },
}));
vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => ({
    id: STUDIO_ID,
    name: "Test Studio",
    timezone: "America/Toronto",
    default_appointment_duration_minutes: 45,
    buffer_minutes: 0,
    public_booking_horizon_months: 6,
    send_confirmation_emails: scenario.sendConfirmationEmails,
    show_treatment_time_to_clients: scenario.showTreatmentTime,
    notify_practitioner_on_new_booking: scenario.notifyPractitioner,
  }),
}));
vi.mock("@/lib/booking/slots", () => ({
  getAvailableSlots: async () => [{ start: START_ISO, end: new Date(START.getTime() + 45 * 60_000).toISOString() }],
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
  ensureIntakeForClient: async () => {
    if (scenario.intakeThrows) throw boom("intake");
    return { id: "intake-1", url: `${ORIGIN}/intake/abc` };
  },
}));
vi.mock("@/lib/treatment-time/queries", () => ({
  buildTreatmentTimeLine: () => "Treatment time so far: 1h.",
  getTreatmentTimeContextForEmail: async () => {
    if (scenario.treatmentTimeThrows) throw boom("treatment time");
    return { sessionCount: 1, totalMinutes: 60 };
  },
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: async (payload: unknown) => {
    confirmationEmails.push(payload);
    if (scenario.emailThrows) throw boom("confirmation email");
    return scenario.emailOk
      ? { ok: true }
      : { ok: false, error: "provider refused", retryable: true };
  },
  sendBookingNotificationToPractitioner: async (payload: unknown) => {
    practitionerEmails.push(payload);
    if (scenario.practitionerEmailThrows) throw boom("practitioner email");
    return { ok: true };
  },
  recordEmailAttempt: async (
    _admin: unknown,
    appointmentId: string,
    emailType: string,
    success: boolean,
  ) => {
    emailAttempts.push({ appointmentId, emailType, success });
    if (scenario.attemptWriteThrows) throw boom("attempt write");
  },
  logEmailFailure: (payload: unknown) => {
    emailFailures.push(payload);
  },
}));
vi.mock("@/lib/sms/send-appointment", () => ({
  sendBookingConfirmationSmsToClient: async (payload: unknown) => {
    smsCalls.push(payload);
    return { ok: false, skipped: true };
  },
}));
vi.mock("@/lib/conversion/dispatch", () => ({
  dispatchBookingConversion: async (payload: unknown) => {
    conversions.push(payload);
  },
}));
vi.mock("@/lib/analytics/server", () => ({
  captureServerEvent: (payload: unknown) => {
    analyticsEvents.push(payload);
  },
}));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: (payload: unknown) => {
    practitionerNotifications.push(payload);
    if (scenario.practitionerNotificationThrows) throw boom("notification");
  },
}));

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("slug", "test-studio");
  fd.set("service_id", SERVICE_ID);
  fd.set("starts_at", START_ISO);
  fd.set("name", "Booker");
  fd.set("email", EMAIL);
  // Required for every public submission (actions.ts:433). The existing-client
  // path deliberately never writes it back onto the stored row.
  fd.set("phone", "+15555550123");
  fd.set("client_type", "existing");
  fd.set("referral_source", "");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

/**
 * Every payload the action handed to a collaborator that PERSISTS, LOGS or
 * EMITS, the surfaces the management URL must never reach.
 *
 * `confirmationEmails` and `smsCalls` are deliberately EXCLUDED: those are the
 * client's own delivery channels and carrying the link is their entire purpose.
 * `practitionerNotifications` IS included, that payload goes to studio staff
 * and to the notifications table, so a management link appearing there would be
 * both a leak and a persistence.
 */
function allEmittedPayloads(): string {
  return JSON.stringify({
    rpcCalls,
    consoleErrors,
    analyticsEvents,
    emailAttempts,
    emailFailures,
    conversions,
    practitionerNotifications,
    clientUpdates,
  });
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rpcCalls.length = 0;
  consoleErrors.length = 0;
  analyticsEvents.length = 0;
  emailAttempts.length = 0;
  emailFailures.length = 0;
  conversions.length = 0;
  practitionerNotifications.length = 0;
  smsCalls.length = 0;
  confirmationEmails.length = 0;
  clientUpdates.length = 0;
  practitionerEmails.length = 0;
  scenario.sendConfirmationEmails = true;
  scenario.emailOk = true;
  scenario.originThrows = false;
  scenario.intakeThrows = false;
  scenario.treatmentTimeThrows = false;
  scenario.emailThrows = false;
  scenario.attemptWriteThrows = false;
  scenario.practitionerNotificationThrows = false;
  scenario.practitionerEmailThrows = false;
  scenario.revalidateThrows = false;
  scenario.showTreatmentTime = false;
  scenario.notifyPractitioner = false;
  scenario.commandRefuses = false;
  errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
});

afterEach(() => {
  errSpy.mockRestore();
});

async function book(overrides?: Record<string, string>) {
  const { publicBookAppointmentAction } = await import("@/app/book/[slug]/actions");
  return publicBookAppointmentAction(form(overrides));
}

describe("BOOK-01 T1: a committed booking returns an in-band management path", () => {
  it("case A: email succeeds, manageUrl returned and status is `sent`", async () => {
    const r = await book();
    expect(r.ok, `action failed: ${r.ok ? "" : r.error}`).toBe(true);
    if (!r.ok) return;
    expect(r.appointmentId).toBe(APPT_ID);
    expect(r.manageUrl.startsWith(`${ORIGIN}/manage/`)).toBe(true);
    expect(r.confirmationEmailStatus).toBe("sent");
    expect(emailAttempts).toEqual([
      { appointmentId: APPT_ID, emailType: "confirmation", success: true },
    ]);
  });

  it("case B/C: provider refuses, manageUrl STILL returned, status is `failed`", async () => {
    scenario.emailOk = false;
    const r = await book();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manageUrl.startsWith(`${ORIGIN}/manage/`)).toBe(true);
    expect(r.confirmationEmailStatus).toBe("failed");
    // The truthful-bookkeeping contract is unchanged: the attempt is recorded
    // as a failure, so `confirmation_sent_at` is never stamped.
    expect(emailAttempts).toEqual([
      { appointmentId: APPT_ID, emailType: "confirmation", success: false },
    ]);
    expect(emailFailures.length).toBe(1);
  });

  it("case C: studio has confirmations disabled, manageUrl returned, status is `disabled`", async () => {
    scenario.sendConfirmationEmails = false;
    const r = await book();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manageUrl.startsWith(`${ORIGIN}/manage/`)).toBe(true);
    expect(r.confirmationEmailStatus).toBe("disabled");
    // Nothing was attempted, so nothing may be recorded or reported.
    expect(confirmationEmails).toEqual([]);
    expect(emailAttempts).toEqual([]);
    expect(emailFailures).toEqual([]);
  });

  it("status reflects the PROVIDER, not the bookkeeping write", async () => {
    // A `sent` verdict must come from the sender's own result. The attempt
    // write is independent and cannot upgrade or downgrade it.
    scenario.emailOk = false;
    const failed = await book();
    scenario.emailOk = true;
    const sent = await book();
    expect(failed.ok && failed.confirmationEmailStatus).toBe("failed");
    expect(sent.ok && sent.confirmationEmailStatus).toBe("sent");
  });

  it("case D: SMS is attempted with the same management URL and cannot change the verdict", async () => {
    scenario.emailOk = false;
    const r = await book();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // One neutral /manage link is what SMS carries; it must be the same URL the
    // browser was handed, so the two channels can never contradict each other.
    expect(smsCalls.length).toBe(1);
    expect((smsCalls[0] as { manageUrl: string }).manageUrl).toBe(r.manageUrl);
    expect(r.confirmationEmailStatus).toBe("failed");
  });

  it("case F: a pre-commit refusal returns NO management URL", async () => {
    const r = await book({ starts_at: "not-a-date" });
    expect(r.ok).toBe(false);
    expect(Object.keys(r)).not.toContain("manageUrl");
    expect(Object.keys(r)).not.toContain("confirmationEmailStatus");
    // Nothing was committed, so no command ran.
    expect(rpcCalls.filter((c) => c.fn === "create_public_appointment")).toEqual([]);
  });
});

describe("BOOK-01 T1: the returned URL is a real, route-shaped capability", () => {
  it("is the /manage entry point carrying the raw token whose SHA-256 the command stored", async () => {
    const r = await book();
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const raw = r.manageUrl.slice(`${ORIGIN}/manage/`.length);
    // 24 random bytes, base64url: the shape /manage/[token] resolves by
    // hashing and matching appointments.cancellation_token_hash.
    expect(raw).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const create = rpcCalls.find((c) => c.fn === "create_public_appointment");
    expect(create).toBeDefined();
    const storedHash = create!.args.p_cancellation_token_hash as string;
    // The command received the HASH, and it is genuinely the hash of the raw
    // token in the URL, so the returned link resolves against what was stored.
    expect(storedHash).toBe(hashAppointmentToken(raw));
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    // And the raw token itself never crossed the DB boundary.
    expect(JSON.stringify(create!.args)).not.toContain(raw);
  });
});

describe("BOOK-01 T1: the secrecy wall", () => {
  for (const [label, setup] of [
    ["email sent", () => {}],
    ["email failed", () => void (scenario.emailOk = false)],
    ["email disabled", () => void (scenario.sendConfirmationEmails = false)],
  ] as Array<[string, () => void]>) {
    it(`${label}: neither the raw token nor the manage URL reaches any durable or emitted payload`, async () => {
      setup();
      const r = await book();
      expect(r.ok, `action failed: ${r.ok ? "" : r.error}`).toBe(true);
      if (!r.ok) return;
      const raw = r.manageUrl.slice(`${ORIGIN}/manage/`.length);
      const emitted = allEmittedPayloads();

      expect(emitted, "raw token leaked into an emitted payload").not.toContain(raw);
      expect(emitted, "manage URL leaked into an emitted payload").not.toContain(r.manageUrl);
      expect(emitted, "a /manage link leaked").not.toContain("/manage/");
      expect(emitted, "a /cancel link leaked").not.toContain("/cancel/");
      expect(emitted, "a /reschedule link leaked").not.toContain("/reschedule/");

      // Analytics carries studio scope only, never client identity or tokens.
      expect(JSON.stringify(analyticsEvents)).not.toContain(EMAIL);
      // Server logs must not carry the raw email either (PR #261 fingerprints).
      expect(consoleErrors.join(" ")).not.toContain(EMAIL);
    });
  }

  it("the practitioner notification carries no management capability", async () => {
    // Staff get an internal /calendar/<id> href, never the client's bearer link.
    scenario.emailOk = false;
    const r = await book();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const payload = JSON.stringify(practitionerNotifications);
    expect(payload).not.toContain(r.manageUrl.slice(`${ORIGIN}/manage/`.length));
    expect(payload).not.toContain("/manage/");
  });

  it("the client's own delivery channels are the ONLY collaborators that receive the links", async () => {
    const r = await book();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const raw = r.manageUrl.slice(`${ORIGIN}/manage/`.length);
    // Positive control for the sweep above: prove the token really is present
    // somewhere, so a passing secrecy assertion cannot be vacuous.
    expect(JSON.stringify(confirmationEmails)).toContain(raw);
  });
});

// ===========================================================================
// The confirmation SURFACE guard.
// ===========================================================================
//
// WHY THIS ONE IS A SOURCE PIN AND THE REST ARE NOT. `PublicBookForm.tsx` is a
// `.tsx` component and the unit lane is `environment: "node"` with
// `include: ["tests/**/*.test.ts"]` (vitest.config.ts), so no test here can
// render it. Without a pin, "hide the Manage button when email failed" would be
// caught by nothing at all. The pins below are deliberately narrow and are a
// SUPPLEMENT to the behavioural tests above, not a substitute: they assert
// structural facts a renderer would otherwise prove.
describe("BOOK-01 T1: confirmation surface structure", () => {
  const SRC = readFileSync(
    join(__dirname, "..", "..", "..", "app/book/[slug]/PublicBookForm.tsx"),
    "utf8",
  );

  it("renders the management anchor from the returned URL", () => {
    expect(SRC).toContain("href={confirmation.manageUrl}");
  });

  it("branches on the email outcome NOWHERE in the component", () => {
    // Every status decision belongs to the pure copy builder, which the tests
    // above execute for real. A conditional here, including one wrapped around
    // the Manage anchor, moves an untestable rule back into the JSX.
    expect(SRC).not.toMatch(/emailStatus\s*===/);
    expect(SRC).not.toMatch(/emailStatus\s*!==/);
    expect(SRC).not.toMatch(/emailStatus\s*\?/);
  });

  it("takes its next-step lines from the copy builder rather than hardcoding them", () => {
    expect(SRC).toContain("buildBookingConfirmationCopy");
    expect(SRC).toContain("copy.steps.map");
    expect(SRC).toContain("{copy.manageLabel}");
  });

  it("no longer hardcodes the unconditional email claims", () => {
    // These two sentences used to render for every booking, including when the
    // provider had just failed and when the studio had confirmations off.
    expect(SRC).not.toContain("We sent a confirmation to");
    expect(SRC).not.toContain("The email includes links to cancel or reschedule");
  });

  it("offers the client portal as a secondary path on an EXISTING route", () => {
    // Reuses app/portal/login's ?studio=<slug> contract; invents no new URL and
    // never gates the primary Manage action behind a sign-in.
    expect(SRC).toContain("/portal/login?studio=");
  });
});

// ===========================================================================
// BOOK-01 P2-A / P2-B, the POST-COMMIT LAW.
// ===========================================================================
//
// Once `create_public_appointment` returns 'created' the appointment and its
// audit row are DURABLE. From that point NO optional secondary dependency may
// turn the response into `{ ok: false }` or an exception: the client must always
// leave with `{ ok:true, appointmentId, manageUrl, confirmationEmailStatus }`.
//
// Each case below injects a real unexpected throw into one post-commit
// dependency and asserts the law holds. The thrown messages all carry POISON, so
// every case simultaneously proves the failure evidence records the error's
// CLASS and never its message.
//
// P2-B is the mirror image: configuration that can fail deterministically is
// resolved BEFORE the durability boundary, so the same misconfiguration refuses
// with nothing committed at all.
//
// WHAT THIS DOES NOT CLAIM. A hard process death after the commit but before the
// HTTP response cannot be converted into a response by try/catch, there is no
// response. That case remains owned by the portal and the reminder passes. This
// suite is about unexpected APPLICATION EXCEPTIONS, which are now contained.

function manageToken(url: string): string {
  return url.slice(`${ORIGIN}/manage/`.length);
}

/** The committed-success shape every post-commit failure must still produce. */
async function expectSettledSuccess(overrides?: Record<string, string>) {
  const r = await book(overrides);
  expect(r.ok, `committed booking reported failure: ${r.ok ? "" : r.error}`).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  expect(r.appointmentId).toBe(APPT_ID);
  expect(r.manageUrl.startsWith(`${ORIGIN}/manage/`)).toBe(true);
  expect(manageToken(r.manageUrl)).toMatch(/^[A-Za-z0-9_-]{32}$/);
  return r;
}

/** The command ran exactly once and committed. */
function expectCommitted() {
  expect(rpcCalls.filter((c) => c.fn === "create_public_appointment").length).toBe(1);
}

/** Safe evidence for `event` exists, and no POISON anywhere in the logs. */
function expectSafeEvidence(event: string) {
  const joined = consoleErrors.join(" ");
  expect(joined, `no evidence recorded for ${event}`).toContain(event);
  expect(joined, "err.message leaked into evidence").not.toContain(POISON);
  expect(joined).not.toContain("exploded");
  // The error CLASS is what we keep, never its message.
  expect(joined).toContain("errorClass");
}

describe("BOOK-01 P2-A: a committed booking survives every post-commit failure", () => {
  it("CASE A: all post-commit dependencies succeed", async () => {
    const r = await expectSettledSuccess();
    expectCommitted();
    expect(r.confirmationEmailStatus).toBe("sent");
    // The intake link the (succeeding) helper produced reached the email.
    expect(JSON.stringify(confirmationEmails)).toContain("/intake/abc");
    expect(consoleErrors.join(" ")).not.toContain("_threw");
  });

  it("CASE B: ensureIntakeForClient throws, booking succeeds, intake omitted", async () => {
    scenario.intakeThrows = true;
    const r = await expectSettledSuccess();
    expectCommitted();
    // The email still went out, just without the intake section.
    expect(r.confirmationEmailStatus).toBe("sent");
    expect(confirmationEmails.length).toBe(1);
    expect((confirmationEmails[0] as { intakeUrl: string | null }).intakeUrl).toBeNull();
    expectSafeEvidence("public_booking_intake_threw");
  });

  it("CASE C: treatment-time context throws, booking succeeds, email still sent", async () => {
    scenario.showTreatmentTime = true;
    scenario.treatmentTimeThrows = true;
    const r = await expectSettledSuccess();
    expectCommitted();
    // Only the optional enrichment degrades: the confirmation is still delivered,
    // so the status follows the PROVIDER and stays truthful.
    expect(r.confirmationEmailStatus).toBe("sent");
    expect(confirmationEmails.length).toBe(1);
    expect(
      (confirmationEmails[0] as { treatmentTimeLine: string | null }).treatmentTimeLine,
    ).toBeNull();
    expectSafeEvidence("public_booking_treatment_time_threw");
  });

  it("CASE D: email construction/send throws, booking succeeds, status is `failed`", async () => {
    scenario.emailThrows = true;
    const r = await expectSettledSuccess();
    expectCommitted();
    // We do NOT know the client received anything, so we must not claim `sent`.
    expect(r.confirmationEmailStatus).toBe("failed");
    expectSafeEvidence("public_booking_confirmation_email_threw");
  });

  it("CASE E: provider returns failure normally, existing truthful path intact", async () => {
    scenario.emailOk = false;
    const r = await expectSettledSuccess();
    expect(r.confirmationEmailStatus).toBe("failed");
    // A normal refusal is NOT an exception, so no throw-evidence is recorded.
    expect(consoleErrors.join(" ")).not.toContain("public_booking_confirmation_email_threw");
    expect(emailAttempts).toEqual([
      { appointmentId: APPT_ID, emailType: "confirmation", success: false },
    ]);
  });

  it("CASE F: recordEmailAttempt throws after provider SUCCESS, status stays `sent`", async () => {
    scenario.attemptWriteThrows = true;
    const r = await expectSettledSuccess();
    expectCommitted();
    // Provider truth is authoritative for what the browser is told. A failed
    // bookkeeping write cannot downgrade a real delivery.
    expect(r.confirmationEmailStatus).toBe("sent");
    expectSafeEvidence("public_booking_email_attempt_write_threw");
  });

  it("CASE G: recordEmailAttempt throws after provider FAILURE, status stays `failed`", async () => {
    scenario.emailOk = false;
    scenario.attemptWriteThrows = true;
    const r = await expectSettledSuccess();
    expect(r.confirmationEmailStatus).toBe("failed");
    expectSafeEvidence("public_booking_email_attempt_write_threw");
  });

  it("CASE H: practitioner notification throws, client booking unaffected", async () => {
    scenario.practitionerNotificationThrows = true;
    const r = await expectSettledSuccess();
    expectCommitted();
    expect(r.confirmationEmailStatus).toBe("sent");
    expectSafeEvidence("public_booking_practitioner_notification_threw");
  });

  it("CASE H2: the practitioner EMAIL throws, client booking unaffected", async () => {
    scenario.notifyPractitioner = true;
    scenario.practitionerEmailThrows = true;
    const r = await expectSettledSuccess();
    expect(r.confirmationEmailStatus).toBe("sent");
    expect(practitionerEmails.length).toBe(1);
    expectSafeEvidence("public_booking_practitioner_email_threw");
  });

  it("CASE H3: revalidatePath throws, client booking unaffected", async () => {
    scenario.revalidateThrows = true;
    const r = await expectSettledSuccess();
    expect(r.confirmationEmailStatus).toBe("sent");
    expectSafeEvidence("public_booking_revalidate_threw");
  });

  it("CASE I: several post-commit failures together, still settles, still no leak", async () => {
    scenario.intakeThrows = true;
    scenario.showTreatmentTime = true;
    scenario.treatmentTimeThrows = true;
    scenario.emailThrows = true;
    scenario.attemptWriteThrows = true;
    scenario.practitionerNotificationThrows = true;
    scenario.notifyPractitioner = true;
    scenario.practitionerEmailThrows = true;
    scenario.revalidateThrows = true;

    const r = await expectSettledSuccess();
    expectCommitted();
    expect(r.confirmationEmailStatus).toBe("failed");

    // Every failure recorded its own safe evidence...
    for (const event of [
      "public_booking_intake_threw",
      "public_booking_treatment_time_threw",
      "public_booking_confirmation_email_threw",
      "public_booking_email_attempt_write_threw",
      "public_booking_practitioner_notification_threw",
      "public_booking_practitioner_email_threw",
      "public_booking_revalidate_threw",
    ]) {
      expect(consoleErrors.join(" "), `missing evidence: ${event}`).toContain(event);
    }
    // ...and none of it carried a secret, a message, or the management path.
    const raw = manageToken(r.manageUrl);
    const logs = consoleErrors.join(" ");
    expect(logs).not.toContain(POISON);
    expect(logs).not.toContain(raw);
    expect(logs).not.toContain(r.manageUrl);
    expect(logs).not.toContain("/manage/");
    expect(logs).not.toContain(EMAIL);
    expect(allEmittedPayloads()).not.toContain(raw);
  });
});

describe("BOOK-01 P2-B: required configuration resolves BEFORE the durability boundary", () => {
  it("CASE J: a missing app origin refuses with NOTHING committed", async () => {
    scenario.originThrows = true;
    const r = await book();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    // The established safe refusal: never the raw config error.
    expect(r.error).not.toContain("APPOINTMENT");
    expect(r.error).not.toContain(POISON);
    expect(Object.keys(r)).not.toContain("manageUrl");
    expect(Object.keys(r)).not.toContain("confirmationEmailStatus");
    // THE POINT: no appointment, no audit row, no token hash persisted.
    expect(rpcCalls.filter((c) => c.fn === "create_public_appointment")).toEqual([]);
    // No client-facing delivery was attempted either.
    expect(confirmationEmails).toEqual([]);
    expect(smsCalls).toEqual([]);
    // Safe evidence, error CLASS only.
    const logs = consoleErrors.join(" ");
    expect(logs).toContain("public_booking_app_origin_unresolved");
    expect(logs).toContain("errorClass");
    expect(logs).not.toContain(POISON);
  });

  it("CASE K: the booking command itself refuses, normal failure, no management URL", async () => {
    scenario.commandRefuses = true;
    const r = await book();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(Object.keys(r)).not.toContain("manageUrl");
    // The command ran and declined; nothing downstream was attempted.
    expectCommitted();
    expect(confirmationEmails).toEqual([]);
    expect(smsCalls).toEqual([]);
  });

  it("the origin is resolved before the command in the SOURCE order too", () => {
    // A behavioural test can prove "no commit when the origin fails", but not
    // "the resolution SITS above the command", a future edit could reintroduce
    // a second, later resolution and still pass CASE J. This pins the order.
    // EXECUTABLE SQL/TS ONLY. The header above the new call explains the change
    // and NAMES the helper, so a count over the raw text sees two occurrences
    // and a position check could be satisfied by the prose rather than the code.
    // Comment lines are stripped first, the repository's standing idiom.
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "app/book/[slug]/actions.ts"),
      "utf8",
    )
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    const originAt = src.indexOf("getRequiredAppOrigin()");
    const commandAt = src.indexOf('"create_public_appointment"');
    expect(originAt).toBeGreaterThan(-1);
    expect(commandAt).toBeGreaterThan(-1);
    expect(originAt).toBeLessThan(commandAt);
    // And it is resolved exactly ONCE, so no later call can throw post-commit.
    expect(src.match(/getRequiredAppOrigin\(\)/g) ?? []).toHaveLength(1);
  });
});

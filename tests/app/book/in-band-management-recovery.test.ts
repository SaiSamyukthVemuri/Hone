import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashAppointmentToken } from "@/lib/booking/appointment-token";

// ===========================================================================
// BOOK-01 Tranche 1 — behavioural proof that a COMMITTED public booking leaves
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
// secret — only its SHA-256 is persisted — so discarding it discarded the
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
const clientUpdates: unknown[] = [];

const scenario = {
  sendConfirmationEmails: true,
  emailOk: true,
};

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
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitPublicBooking: async () => ({ allowed: true }),
  limitPublicSlots: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => ORIGIN }));
vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => ({
    id: STUDIO_ID,
    name: "Test Studio",
    timezone: "America/Toronto",
    default_appointment_duration_minutes: 45,
    buffer_minutes: 0,
    public_booking_horizon_months: 6,
    send_confirmation_emails: scenario.sendConfirmationEmails,
    show_treatment_time_to_clients: false,
    notify_practitioner_on_new_booking: false,
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
  ensureIntakeForClient: async () => null,
}));
vi.mock("@/lib/treatment-time/queries", () => ({
  buildTreatmentTimeLine: () => null,
  getTreatmentTimeContextForEmail: async () => null,
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: async (payload: unknown) => {
    confirmationEmails.push(payload);
    return scenario.emailOk
      ? { ok: true }
      : { ok: false, error: "provider refused", retryable: true };
  },
  sendBookingNotificationToPractitioner: async () => ({ ok: true }),
  recordEmailAttempt: async (
    _admin: unknown,
    appointmentId: string,
    emailType: string,
    success: boolean,
  ) => {
    emailAttempts.push({ appointmentId, emailType, success });
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
  recordPractitionerNotification: async (payload: unknown) => {
    practitionerNotifications.push(payload);
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
 * EMITS — the surfaces the management URL must never reach.
 *
 * `confirmationEmails` and `smsCalls` are deliberately EXCLUDED: those are the
 * client's own delivery channels and carrying the link is their entire purpose.
 * `practitionerNotifications` IS included — that payload goes to studio staff
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
  scenario.sendConfirmationEmails = true;
  scenario.emailOk = true;
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

describe("BOOK-01 T1 — a committed booking returns an in-band management path", () => {
  it("case A: email succeeds — manageUrl returned and status is `sent`", async () => {
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

  it("case B/C: provider refuses — manageUrl STILL returned, status is `failed`", async () => {
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

  it("case C: studio has confirmations disabled — manageUrl returned, status is `disabled`", async () => {
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

describe("BOOK-01 T1 — the returned URL is a real, route-shaped capability", () => {
  it("is the /manage entry point carrying the raw token whose SHA-256 the command stored", async () => {
    const r = await book();
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const raw = r.manageUrl.slice(`${ORIGIN}/manage/`.length);
    // 24 random bytes, base64url — the shape /manage/[token] resolves by
    // hashing and matching appointments.cancellation_token_hash.
    expect(raw).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const create = rpcCalls.find((c) => c.fn === "create_public_appointment");
    expect(create).toBeDefined();
    const storedHash = create!.args.p_cancellation_token_hash as string;
    // The command received the HASH, and it is genuinely the hash of the raw
    // token in the URL — so the returned link resolves against what was stored.
    expect(storedHash).toBe(hashAppointmentToken(raw));
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    // And the raw token itself never crossed the DB boundary.
    expect(JSON.stringify(create!.args)).not.toContain(raw);
  });
});

describe("BOOK-01 T1 — the secrecy wall", () => {
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

      // Analytics carries studio scope only — never client identity or tokens.
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
describe("BOOK-01 T1 — confirmation surface structure", () => {
  const SRC = readFileSync(
    join(__dirname, "..", "..", "..", "app/book/[slug]/PublicBookForm.tsx"),
    "utf8",
  );

  it("renders the management anchor from the returned URL", () => {
    expect(SRC).toContain("href={confirmation.manageUrl}");
  });

  it("branches on the email outcome NOWHERE in the component", () => {
    // Every status decision belongs to the pure copy builder, which the tests
    // above execute for real. A conditional here — including one wrapped around
    // the Manage anchor — moves an untestable rule back into the JSX.
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

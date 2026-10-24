// ===========================================================================
// HON-47 — returning-client online booking follows the client portal flag.
// ===========================================================================
//
// Harness copied from in-band-management-recovery.test.ts. With client portal
// access off, a returning client cannot book online: neither by choosing
// "existing", nor by choosing "new" with an email that matches an active
// client. Both refuse before any write, with one neutral sentence that does
// not confirm the email is on file. New-client admission is untouched.
// Synthetic data only.

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
const practitionerEmails: unknown[] = [];
const clientUpdates: unknown[] = [];

const scenario = {
  sendConfirmationEmails: true,
  emailOk: true,
  // BOOK-01 P2-A throw injection. Each flag makes one POST-COMMIT dependency
  // raise an unexpected exception. The thrown message deliberately carries a
  // POISON string so the secrecy assertions can prove `err.message` is never
  // recorded — a real template or provider error can carry the recipient
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
  slotError: null as unknown,
  emptySlots: false,
  commandError: null as null | { code: string },
  // HON-47. The studio's persisted self-service flags; absent = today's row.
  flags: {} as Record<string, boolean>,
  // A "new" booking must name a consultation, so the new-client cases set this.
  serviceModality: "electrolysis" as string,
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
            modality: scenario.serviceModality,
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
      if (scenario.commandError) return { data: null, error: scenario.commandError };
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
    ...scenario.flags,
  }),
}));
vi.mock("@/lib/booking/slots", () => ({
  getAvailableSlots: async () => {
    if (scenario.slotError !== null) throw scenario.slotError;
    return scenario.emptySlots ? [] : [{ start: START_ISO, end: new Date(START.getTime() + 45 * 60_000).toISOString() }];
  },
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
  scenario.slotError = null; scenario.emptySlots = false; scenario.commandError = null;
  scenario.flags = {};
  scenario.serviceModality = "electrolysis";
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

// New-client admission pinned OPEN through the REAL resolver with an initialized
// stored mode, so the "new" case below reaches the existing-client lookup and
// the only rule that can refuse it is HON-47's.
vi.mock("@/lib/booking/new-client-admission", async (orig) => {
  const actual = await orig<typeof import("@/lib/booking/new-client-admission")>();
  return {
    ...actual,
    getNewClientAdmissionMode: async (studio: { slug: string | null }) =>
      actual.resolveAdmission({
        storedMode: "open",
        storedSetAt: "2026-01-01T00:00:00Z",
        readFailed: false,
        studioSlug: studio.slug,
      }),
  };
});

const PORTAL_OFF = { client_portal_enabled: false };
const NEUTRAL = "This booking can't be completed online. Please contact Test Studio directly to book.";

describe("DEFAULT: no policy columns (today's rows) books a returning client exactly as before", () => {
  it("existing client books, and the card gets the management link", async () => {
    const r = await book();
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (r.ok) expect(String(r.manageUrl).startsWith(`${ORIGIN}/manage/`)).toBe(true);
    expect(rpcCalls.map((c) => c.fn)).toContain("create_public_appointment");
  });

  it("a 'new' booking whose email matches an active client passes the HON-47 gate (portal on)", async () => {
    // Control for the refusal below: with the portal on, the same submission
    // gets past the gate and reaches the appointment command. (What the
    // command then answers is this harness's business, not HON-47's.)
    scenario.serviceModality = "consultation";
    const r = await book({ client_type: "new" });
    expect(r).not.toEqual({ ok: false, error: NEUTRAL });
    expect(rpcCalls.length).toBeGreaterThan(0);
  });

  it("cancel and reschedule off do not stop booking, and /manage is still offered (portal on)", async () => {
    scenario.flags = { client_cancellation_enabled: false, client_reschedule_enabled: false };
    const r = await book();
    expect(r.ok).toBe(true);
    if (r.ok) expect(String(r.manageUrl).startsWith(`${ORIGIN}/manage/`)).toBe(true);
  });
});

describe("client_portal_enabled = false", () => {
  beforeEach(() => {
    scenario.flags = PORTAL_OFF;
  });

  it("an 'existing client' booking refuses before ANY read or write", async () => {
    const r = await book();
    expect(r).toEqual({ ok: false, error: NEUTRAL });
    expect(rpcCalls).toEqual([]);
    expect(clientUpdates).toEqual([]);
    expect(confirmationEmails).toEqual([]);
  });

  it("a 'new' booking whose email matches an active client refuses with the SAME neutral sentence, before any write", async () => {
    scenario.serviceModality = "consultation";
    const r = await book({ client_type: "new" });
    expect(r).toEqual({ ok: false, error: NEUTRAL });
    expect(rpcCalls).toEqual([]);
    expect(clientUpdates).toEqual([]);
  });

  it("the refusal never says 'returning', 'existing' or 'on file'", () => {
    expect(NEUTRAL).not.toMatch(/returning|existing|on file/i);
  });
});

describe("source contract: the gate is NOT new-client admission", () => {
  const src = readFileSync(join(process.cwd(), "app/book/[slug]/actions.ts"), "utf8");
  it("reads the studio policy from the server-resolved studio row", () => {
    expect(src).toContain("const clientSelfService = clientSelfServicePolicyFromStudio(studio);");
  });
  it("refuses an explicit existing-client choice before the admission gate", () => {
    const gate = src.indexOf('if (clientType === "existing" && !clientSelfService.portal)');
    const admission = src.indexOf("const admission = await getNewClientAdmissionMode(studio);");
    expect(gate).toBeGreaterThan(-1);
    expect(admission).toBeGreaterThan(gate);
  });
  it("refuses a matched existing client BEFORE the invitation is consumed", () => {
    const gate = src.indexOf("if (existingClient && !clientSelfService.portal)");
    const consume = src.indexOf("const redeemed = await consumeInvitationForBooking(");
    expect(gate).toBeGreaterThan(-1);
    expect(consume).toBeGreaterThan(gate);
  });
  it("withholds the management link when no self-service path is offered", () => {
    expect(src).toContain("manageUrl: clientManagePageAllowed(clientSelfService) ? manageUrl : null,");
  });
});

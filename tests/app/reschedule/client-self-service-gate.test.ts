// ===========================================================================
// HON-47 — a studio may turn client self-service RESCHEDULING off.
// ===========================================================================
//
// Harness copied from free-consult-waitlist-only.test.ts (same fakes, same
// sentinels). Every one of the four public entry points goes through
// assertReschedulableOriginal, so all four must refuse together, with a
// bounded code, before the slot engine or the command. Synthetic data only.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { NEW_CLIENT_WAITLIST_SLUGS_ENV } from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// EMERG-01 — WAITLIST-ONLY REBOOKING, PROVED THROUGH THE REAL SERVER ACTIONS.
// ===========================================================================
//
// These are NOT source greps. Every public reschedule entry point is invoked
// for real against an in-memory admin client that records whether the slot
// engine and the reschedule COMMAND were ever reached.
//
// The negative controls this file owns, from the emergency brief:
//
//   A. policy match => the reschedule page renders NO slot picker
//   B. policy match => fetchRescheduleSlotsAction refuses
//   C. policy match => fetchNextAvailableDateForRescheduleAction refuses
//   D. policy match => a FORGED submit refuses, the original stays confirmed,
//      its reservation is untouched, no successor is created, no token rotates
//   E. paid consultation      => unchanged
//   F. $0 non-consultation    => unchanged
//   G. open studio            => unchanged
//   H. invalid token          => the EXISTING generic collapse, and no hint
//      that any studio anywhere has this policy
//   I. past / cancelled / completed / no-show => the same generic collapse
//
// The forged-submit control is the load-bearing one: the browser is not the
// authority, so the proof has to be that the RPC was never called at all.

const bulk = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/booking/public-slot-range", () => ({ loadPublicSlotsByDate: bulk.load }));

const WAITLISTED_SLUG = "e2e-waitlist-p0";
const OPEN_SLUG = "e2e-open-studio";

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const slotEngineCalls: Array<{ date: string }> = [];

const ORIGINAL = {
  id: "11111111-1111-4111-8111-111111111111",
  studio_id: "22222222-2222-4222-8222-222222222222",
  client_id: "33333333-3333-4333-8333-333333333333",
  practitioner_id: "44444444-4444-4444-8444-444444444444",
  service_id: "55555555-5555-4555-8555-555555555555",
  status: "confirmed",
  starts_at: new Date(Date.now() + 86_400_000).toISOString(),
  duration_minutes: 45,
  cancellation_token_hash: "a".repeat(64),
};

type ServiceShape = {
  id: string;
  name: string;
  default_duration_minutes: number;
  modality: string | null;
  price_cents: number | null;
};

const FREE_CONSULT: ServiceShape = {
  id: ORIGINAL.service_id,
  name: "New Client Consultation",
  default_duration_minutes: 45,
  modality: "consultation",
  price_cents: 0,
};

const PAID_CONSULT: ServiceShape = { ...FREE_CONSULT, price_cents: 5_000 };

const FREE_TREATMENT: ServiceShape = {
  ...FREE_CONSULT,
  name: "Complimentary Patch Test",
  modality: "electrolysis",
  price_cents: 0,
};

const scenario = {
  tokenResolves: true,
  status: "confirmed" as string,
  startsAt: ORIGINAL.starts_at,
  service: FREE_CONSULT as ServiceShape | null,
  studioSlug: WAITLISTED_SLUG as string | null,
  capacity: false,
  slotError: null as unknown,
  emptySlots: false,
  // HON-47. The studio's persisted self-service flags. Absent keys = a studio
  // row loaded before 0234 / the HON-47 migration (today's behaviour).
  flags: {} as Record<string, boolean>,
};

// --- the in-memory admin client -------------------------------------------

function appointmentRow() {
  return {
    ...ORIGINAL,
    status: scenario.status,
    starts_at: scenario.startsAt,
    // Both public reschedule reads embed these; the shared gate now reads them
    // to DERIVE the policy rather than trusting anything from the browser.
    service: scenario.service,
    studio: {
      id: ORIGINAL.studio_id,
      name: "Test Studio",
      slug: scenario.studioSlug,
      timezone: "UTC",
      public_booking_horizon_months: 3,
      cancellation_policy_text: null,
      no_show_policy_text: null,
      default_appointment_duration_minutes: 45,
      buffer_minutes: 0,
      practitioner_capacity_enabled: scenario.capacity,
      ...scenario.flags,
    },
  };
}

function makeQuery(table: string) {
  const chain = {
    select() {
      return chain;
    },
    eq() {
      return chain;
    },
    is() {
      return chain;
    },
    async maybeSingle() {
      if (table === "appointments") {
        if (!scenario.tokenResolves) return { data: null, error: null };
        return { data: appointmentRow(), error: null };
      }
      if (table === "studios") {
        return { data: appointmentRow().studio, error: null };
      }
      if (table === "practitioners") {
        return {
          data: { display_name: "Practitioner", email: "p@example.test" },
          error: null,
        };
      }
      if (table === "services") {
        return {
          data: {
            name: scenario.service?.name ?? "Service",
            default_duration_minutes: 45,
            pre_care_instructions: null,
          },
          error: null,
        };
      }
      if (table === "clients") {
        return {
          data: {
            name: "Test Client",
            email: "client@example.test",
            phone: null,
            sms_consent_at: null,
            sms_opted_out_at: null,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    async single() {
      return chain.maybeSingle();
    },
  };
  return chain;
}

const admin = {
  from(table: string) {
    return makeQuery(table);
  },
  async rpc(fn: string, args: Record<string, unknown>) {
    rpcCalls.push({ fn, args });
    // A STRUCTURALLY COMPLETE success row. The controls below assert only that
    // the command was reached, but a half-built row would make the action log a
    // contract violation on every one of them — noise a reader would have to
    // rule out before trusting the result.
    const successorStart = new Date(Date.now() + 172_800_000);
    return {
      data: [
        {
          result: "success",
          original_appointment_id: ORIGINAL.id,
          new_appointment_id: "66666666-6666-4666-8666-666666666666",
          studio_id: ORIGINAL.studio_id,
          client_id: ORIGINAL.client_id,
          service_id: ORIGINAL.service_id,
          practitioner_id: ORIGINAL.practitioner_id,
          original_starts_at: ORIGINAL.starts_at,
          starts_at: successorStart.toISOString(),
          ends_at: new Date(
            successorStart.getTime() + 45 * 60_000,
          ).toISOString(),
          duration_minutes: 45,
          created_at: new Date().toISOString(),
          policy_acknowledgement_id: null,
        },
      ],
      error: null,
    };
  },
};

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => admin,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitTokenRoute: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));
vi.mock("@/lib/booking/appointment-token", () => ({
  generateAppointmentToken: () => "RAW-SUCCESSOR-TOKEN",
  hashAppointmentToken: () => "a".repeat(64),
}));
vi.mock("@/lib/booking/tokens", () => ({
  verifyCancellationToken: () => ({ ok: false, error: "invalid" }),
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: () => "https://hone.test",
}));
// The controls below assert only WHETHER the command was reached. Everything
// downstream of a committed reschedule is fail-soft by design and is proved
// elsewhere (tests/app/reschedule/token-delivery-and-post-commit.test.ts), so
// it is stubbed here rather than left to log contained failures that a reader
// would have to rule out before trusting these results.
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: () => undefined,
}));
vi.mock("@/lib/intake/queries", () => ({
  ensureIntakeForClient: async () => null,
}));
vi.mock("@/lib/treatment-time/queries", () => ({
  buildTreatmentTimeLine: () => null,
  getTreatmentTimeContextForEmail: async () => null,
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: async () => ({ ok: true }),
  recordEmailAttempt: async () => undefined,
  logEmailFailure: () => undefined,
}));
vi.mock("@/lib/sms/send-appointment", () => ({
  sendBookingConfirmationSmsToClient: async () => undefined,
}));

// The slot engine is mocked so a REACHED call is unmistakable: a policy-matched
// appointment must never cause one. It returns a non-empty list precisely so
// "no slots" can never be an accident of an empty calendar.
vi.mock("@/lib/booking/slots", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/booking/slots")>(
      "@/lib/booking/slots",
    );
  return {
    ...actual,
    async getAvailableSlots(
      _admin: unknown,
      _studio: unknown,
      date: string,
    ) {
      slotEngineCalls.push({ date });
      if (scenario.slotError !== null) throw scenario.slotError;
      if (scenario.emptySlots) return [];
      const start = new Date(Date.now() + 172_800_000);
      return [
        {
          start: start.toISOString(),
          end: new Date(start.getTime() + 45 * 60_000).toISOString(),
          startLabel: "10:00 AM",
        },
      ];
    },
  };
});

// next/link + the slot picker are stubbed with SENTINELS so the render
// assertions below are about presence, not phrasing.
vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: (props: { href: string; children?: ReactNode }) =>
      react.createElement("a", { href: props.href }, props.children),
  };
});
vi.mock("@/app/reschedule/[token]/RescheduleForm", async () => {
  const react = await import("react");
  return {
    RescheduleForm: () =>
      react.createElement("div", null, "SENTINEL-RESCHEDULE-FORM"),
  };
});

const {
  fetchAppointmentForRescheduleAction,
  fetchRescheduleSlotsAction,
  fetchNextAvailableDateForRescheduleAction,
  rescheduleAppointmentViaTokenAction,
} = await import("@/app/reschedule/[token]/actions");
const ReschedulePage = (await import("@/app/reschedule/[token]/page")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const {
  FREE_CONSULT_WAITLIST_ONLY_CODE,
  FREE_CONSULT_WAITLIST_ONLY_HEADLINE,
} = await import("@/lib/booking/free-consult-reschedule-policy");

const GENERIC = "This reschedule link can't be used right now.";
const TOKEN = "raw-url-token";

function submitForm(): FormData {
  const fd = new FormData();
  fd.set("token", TOKEN);
  fd.set("starts_at", new Date(Date.now() + 172_800_000).toISOString());
  fd.set("acknowledged_policy", "true");
  return fd;
}

// react-dom escapes ' and " in text nodes, so assertions written in the copy's
// own punctuation would never match the raw markup. Decoding keeps the
// assertions readable AND keeps them about the visible text.
function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function renderPage(token = TOKEN): Promise<string> {
  const element = await ReschedulePage({ params: Promise.resolve({ token }) });
  return decode(renderToStaticMarkup(element));
}

beforeEach(() => {
  bulk.load.mockReset();
  bulk.load.mockImplementation(async (_admin: unknown, _ctx: unknown, dates: string[]) => ({
    ok: true, byDate: dates.length ? [{ date: dates[0], slots: [{ start: `${dates[0]}T10:00:00.000Z`, end: `${dates[0]}T10:45:00.000Z`, startLabel: "10:00 AM" }] }] : [], scanned: dates, skippedOutsideHorizon: [],
  }));
  rpcCalls.length = 0;
  slotEngineCalls.length = 0;
  Object.assign(scenario, {
    tokenResolves: true,
    slotError: null,
    emptySlots: false,
    capacity: false,
    status: "confirmed",
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    service: FREE_CONSULT,
    // A PAID service at a studio the EMERG-01 gate does not name, so the only
    // rule that can refuse below is HON-47's.
    studioSlug: OPEN_SLUG,
    flags: {},
  });
  scenario.service = PAID_CONSULT;
  delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
});


const TODAY_PLUS_2 = () => new Date(Date.now() + 172_800_000).toISOString().slice(0, 10);

describe("DEFAULT: no policy columns (today's rows) keeps rescheduling exactly as before", () => {
  it("page renders the picker, slots load, and submit reaches the command", async () => {
    expect(await renderPage()).toContain("SENTINEL-RESCHEDULE-FORM");
    const slots = await fetchRescheduleSlotsAction({ token: TOKEN, date: TODAY_PLUS_2() });
    expect(slots.ok).toBe(true);
    await rescheduleAppointmentViaTokenAction(submitForm());
    expect(rpcCalls.map((c) => c.fn)).toContain("reschedule_appointment_v2");
  });

  it("explicit client_reschedule_enabled = true behaves the same", async () => {
    scenario.flags = { client_reschedule_enabled: true };
    expect(await renderPage()).toContain("SENTINEL-RESCHEDULE-FORM");
    await rescheduleAppointmentViaTokenAction(submitForm());
    expect(rpcCalls.map((c) => c.fn)).toContain("reschedule_appointment_v2");
  });

  it("turning OTHER flags off does not touch rescheduling", async () => {
    scenario.flags = { client_cancellation_enabled: false, client_portal_enabled: false };
    expect(await renderPage()).toContain("SENTINEL-RESCHEDULE-FORM");
    await rescheduleAppointmentViaTokenAction(submitForm());
    expect(rpcCalls.map((c) => c.fn)).toContain("reschedule_appointment_v2");
  });
});

describe("client_reschedule_enabled = false: every entry point refuses, understandably", () => {
  beforeEach(() => {
    scenario.flags = { client_reschedule_enabled: false };
  });

  it("the page explains, says the booking stands, and offers no picker", async () => {
    const html = await renderPage();
    expect(html).not.toContain("SENTINEL-RESCHEDULE-FORM");
    expect(html).toContain("Online rescheduling isn\u2019t available.");
    expect(html).toContain("still booked");
    expect(html).toContain("contact Test Studio directly");
    expect(slotEngineCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("the summary fetch carries the bounded code and no summary", async () => {
    const r = await fetchAppointmentForRescheduleAction(TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("reschedule_disabled");
    expect("summary" in r).toBe(false);
  });

  it("the slot fetch refuses without running the slot engine", async () => {
    const r = await fetchRescheduleSlotsAction({ token: TOKEN, date: TODAY_PLUS_2() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("reschedule_disabled");
    expect(slotEngineCalls).toEqual([]);
  });

  it("next-available refuses without scanning", async () => {
    const r = await fetchNextAvailableDateForRescheduleAction({ token: TOKEN, fromDate: TODAY_PLUS_2() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("reschedule_disabled");
    expect(bulk.load).not.toHaveBeenCalled();
  });

  it("a forged direct submit refuses and never reaches the command", async () => {
    const r = await rescheduleAppointmentViaTokenAction(submitForm());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("reschedule_disabled");
      expect(r.error).toMatch(/still booked/);
    }
    expect(rpcCalls).toEqual([]);
    expect(slotEngineCalls).toEqual([]);
  });

  it("an unknown token still gets the generic collapse, never the policy", async () => {
    scenario.tokenResolves = false;
    const r = await fetchAppointmentForRescheduleAction(TOKEN);
    expect(r).toEqual({ ok: false, error: GENERIC });
  });

  it("a PAST appointment still gets the generic collapse, never the policy", async () => {
    scenario.startsAt = new Date(Date.now() - 86_400_000).toISOString();
    const r = await rescheduleAppointmentViaTokenAction(submitForm());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBeUndefined();
  });
});

describe("the command's own refusal (0234) maps to the same understandable copy", () => {
  it("reschedule_disabled from the command is not collapsed to the generic error", async () => {
    const original = admin.rpc;
    admin.rpc = (async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: [{ result: "reschedule_disabled" }], error: null };
    }) as unknown as typeof admin.rpc;
    try {
      const r = await rescheduleAppointmentViaTokenAction(submitForm());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("reschedule_disabled");
        expect(r.error).toMatch(/still booked/);
      }
    } finally {
      admin.rpc = original;
    }
  });
});

describe("an unreadable studio policy fails CLOSED", () => {
  it("refuses with the generic copy and mutates nothing", async () => {
    const originalFrom = admin.from;
    admin.from = (table: string) => {
      if (table !== "studios") return originalFrom(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: null, error: { code: "57014" } }),
      };
      return chain as unknown as ReturnType<typeof originalFrom>;
    };
    const silence = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const r = await rescheduleAppointmentViaTokenAction(submitForm());
      expect(r).toEqual({ ok: false, error: GENERIC });
      expect(rpcCalls).toEqual([]);
    } finally {
      admin.from = originalFrom;
      silence.mockRestore();
    }
  });
});

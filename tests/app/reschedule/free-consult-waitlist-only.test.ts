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
      practitioner_capacity_enabled: false,
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
  rpcCalls.length = 0;
  slotEngineCalls.length = 0;
  Object.assign(scenario, {
    tokenResolves: true,
    status: "confirmed",
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    service: FREE_CONSULT,
    studioSlug: WAITLISTED_SLUG,
  });
  process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = WAITLISTED_SLUG;
});

// ===========================================================================

describe("A — the reschedule page offers no times for a free consultation", () => {
  it("renders the policy surface instead of the slot picker", async () => {
    const html = await renderPage();
    expect(html).not.toContain("SENTINEL-RESCHEDULE-FORM");
    expect(html).toContain(FREE_CONSULT_WAITLIST_ONLY_HEADLINE);
  });

  it("offers CANCEL as the useful action, pointed at the SAME token", async () => {
    const html = await renderPage();
    expect(html).toContain(`href="/cancel/${TOKEN}"`);
    expect(html).toContain("Cancel appointment");
  });

  it("offers a KEEP MY APPOINTMENT exit that changes nothing", async () => {
    const html = await renderPage();
    expect(html).toContain("Keep my appointment");
  });

  it("never links back into available times", async () => {
    const html = await renderPage();
    expect(html).not.toContain(`href="/reschedule/${TOKEN}"`);
  });

  it("renders the page WITHOUT touching the slot engine or the command", async () => {
    await renderPage();
    expect(slotEngineCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("still shows the picker for a studio the gate does not name (control G)", async () => {
    scenario.studioSlug = OPEN_SLUG;
    const html = await renderPage();
    expect(html).toContain("SENTINEL-RESCHEDULE-FORM");
    expect(html).not.toContain(FREE_CONSULT_WAITLIST_ONLY_HEADLINE);
  });
});

describe("the summary fetch returns a BOUNDED machine code", () => {
  it("carries the free-consultation code and no slot-bearing summary", async () => {
    const r = await fetchAppointmentForRescheduleAction(TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FREE_CONSULT_WAITLIST_ONLY_CODE);
    expect("summary" in r).toBe(false);
  });
});

describe("B — fetchRescheduleSlotsAction refuses", () => {
  it("returns no slots and never runs the slot engine", async () => {
    const r = await fetchRescheduleSlotsAction({
      token: TOKEN,
      date: new Date(Date.now() + 172_800_000).toISOString().slice(0, 10),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FREE_CONSULT_WAITLIST_ONLY_CODE);
    expect("slots" in r).toBe(false);
    expect(slotEngineCalls).toEqual([]);
  });
});

describe("C — fetchNextAvailableDateForRescheduleAction refuses", () => {
  it("returns no next-available date and never runs the slot engine", async () => {
    const r = await fetchNextAvailableDateForRescheduleAction({
      token: TOKEN,
      fromDate: new Date(Date.now() + 172_800_000).toISOString().slice(0, 10),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FREE_CONSULT_WAITLIST_ONLY_CODE);
    // The refusal must not be dressed as "we looked and found nothing" — that
    // would be a next-available disclosure with an empty payload.
    expect("date" in r).toBe(false);
    expect(slotEngineCalls).toEqual([]);
  });
});

describe("D — a FORGED submit refuses and mutates nothing", () => {
  it("never reaches reschedule_appointment_v2", async () => {
    const r = await rescheduleAppointmentViaTokenAction(submitForm());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FREE_CONSULT_WAITLIST_ONLY_CODE);
    expect(rpcCalls).toEqual([]);
  });

  it("mints and delivers NO successor token, so nothing can rotate", async () => {
    await rescheduleAppointmentViaTokenAction(submitForm());
    expect(
      rpcCalls.some((c) => "p_new_cancellation_token_hash" in c.args),
    ).toBe(false);
    expect(rpcCalls.some((c) => c.fn === "reschedule_appointment_v2")).toBe(
      false,
    );
  });

  it("refuses BEFORE the slot engine, so no reservation is probed or replaced", async () => {
    await rescheduleAppointmentViaTokenAction(submitForm());
    expect(slotEngineCalls).toEqual([]);
  });

  it("refuses every submit shape a forger could try", async () => {
    for (const extra of [
      { acknowledged_policy: "false" },
      { presented_policy_hash: "f".repeat(64) },
      { starts_at: new Date(Date.now() + 604_800_000).toISOString() },
    ]) {
      const fd = submitForm();
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      const r = await rescheduleAppointmentViaTokenAction(fd);
      expect(r.ok, JSON.stringify(extra)).toBe(false);
    }
    expect(rpcCalls).toEqual([]);
  });
});

describe("the browser is never the authority", () => {
  it("a forged studio slug in the form cannot switch the policy off", async () => {
    const fd = submitForm();
    fd.set("slug", OPEN_SLUG);
    fd.set("studio_slug", OPEN_SLUG);
    fd.set("price_cents", "9900");
    fd.set("modality", "electrolysis");
    const r = await rescheduleAppointmentViaTokenAction(fd);
    expect(r.ok).toBe(false);
    expect(rpcCalls).toEqual([]);
  });
});

describe("E — a PAID consultation keeps its existing reschedule behaviour", () => {
  beforeEach(() => {
    scenario.service = PAID_CONSULT;
  });

  it("renders the slot picker", async () => {
    expect(await renderPage()).toContain("SENTINEL-RESCHEDULE-FORM");
  });

  it("returns slots", async () => {
    const r = await fetchRescheduleSlotsAction({
      token: TOKEN,
      date: new Date(Date.now() + 172_800_000).toISOString().slice(0, 10),
    });
    expect(r.ok).toBe(true);
    expect(slotEngineCalls.length).toBeGreaterThan(0);
  });

  it("reaches the command on submit", async () => {
    await rescheduleAppointmentViaTokenAction(submitForm());
    expect(rpcCalls.map((c) => c.fn)).toContain("reschedule_appointment_v2");
  });
});

describe("F — a $0 NON-consultation keeps its existing reschedule behaviour", () => {
  beforeEach(() => {
    scenario.service = FREE_TREATMENT;
  });

  it("renders the slot picker", async () => {
    expect(await renderPage()).toContain("SENTINEL-RESCHEDULE-FORM");
  });

  it("reaches the command on submit", async () => {
    await rescheduleAppointmentViaTokenAction(submitForm());
    expect(rpcCalls.map((c) => c.fn)).toContain("reschedule_appointment_v2");
  });
});

describe("G — an OPEN studio keeps its existing reschedule behaviour", () => {
  beforeEach(() => {
    scenario.studioSlug = OPEN_SLUG;
  });

  it("returns slots for a free consultation", async () => {
    const r = await fetchRescheduleSlotsAction({
      token: TOKEN,
      date: new Date(Date.now() + 172_800_000).toISOString().slice(0, 10),
    });
    expect(r.ok).toBe(true);
    expect(slotEngineCalls.length).toBeGreaterThan(0);
  });

  it("reaches the command on submit", async () => {
    await rescheduleAppointmentViaTokenAction(submitForm());
    expect(rpcCalls.map((c) => c.fn)).toContain("reschedule_appointment_v2");
  });

  it("DEFAULT OFF — clearing the gate restores rescheduling everywhere", async () => {
    delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
    scenario.studioSlug = WAITLISTED_SLUG;
    expect(await renderPage()).toContain("SENTINEL-RESCHEDULE-FORM");
  });
});

describe("H — an unknown token reveals nothing about the policy", () => {
  beforeEach(() => {
    scenario.tokenResolves = false;
  });

  it.each([
    ["summary fetch", () => fetchAppointmentForRescheduleAction(TOKEN)],
    [
      "slot fetch",
      () => fetchRescheduleSlotsAction({ token: TOKEN, date: "2099-01-01" }),
    ],
    [
      "next available",
      () =>
        fetchNextAvailableDateForRescheduleAction({
          token: TOKEN,
          fromDate: "2099-01-01",
        }),
    ],
    ["submit", () => rescheduleAppointmentViaTokenAction(submitForm())],
  ])("%s collapses to the existing generic copy", async (_label, call) => {
    const r = (await call()) as { ok: boolean; error?: string; code?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe(GENERIC);
    // No bearer-token oracle: the policy code is NEVER attached to a token
    // that did not resolve, so probing cannot enumerate which studios have it.
    expect(r.code).toBeUndefined();
  });

  it("the page renders the existing collapsed surface", async () => {
    const html = await renderPage();
    expect(html).toContain(GENERIC);
    expect(html).not.toContain(FREE_CONSULT_WAITLIST_ONLY_HEADLINE);
    expect(html).not.toContain("SENTINEL-RESCHEDULE-FORM");
  });
});

describe("I — a non-reschedulable appointment collapses first", () => {
  it.each([["cancelled"], ["completed"], ["no_show"]])(
    "status=%s never reaches the policy branch",
    async (status) => {
      scenario.status = status;
      const r = await fetchAppointmentForRescheduleAction(TOKEN);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe(GENERIC);
        expect(r.code).toBeUndefined();
      }
      const html = await renderPage();
      expect(html).toContain(GENERIC);
      expect(html).not.toContain(FREE_CONSULT_WAITLIST_ONLY_HEADLINE);
    },
  );

  it("a PAST appointment never reaches the policy branch", async () => {
    scenario.startsAt = new Date(Date.now() - 3_600_000).toISOString();
    const r = await fetchAppointmentForRescheduleAction(TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(GENERIC);
      expect(r.code).toBeUndefined();
    }
    const html = await renderPage();
    expect(html).not.toContain(FREE_CONSULT_WAITLIST_ONLY_HEADLINE);
  });
});

describe("a missing service row is not a free consultation", () => {
  it("an appointment with no resolvable service keeps existing behaviour", async () => {
    // The policy protects FREE CONSULTATIONS. An appointment whose service row
    // cannot be resolved is not one, so it must not be swept into a refusal.
    scenario.service = null;
    const r = await fetchRescheduleSlotsAction({
      token: TOKEN,
      date: new Date(Date.now() + 172_800_000).toISOString().slice(0, 10),
    });
    expect(r.ok).toBe(true);
  });
});

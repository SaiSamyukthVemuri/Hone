// ===========================================================================
// HON-47 — a studio may turn client self-service CANCELLATION off.
// ===========================================================================
//
// Harness copied from free-consult-waitlist-only.test.ts. The page, the fetch
// action and the submit action must all refuse, understandably, and the submit
// must refuse BEFORE the command so nothing is mutated on a database where 0234
// has not applied. Synthetic data only.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { NEW_CLIENT_WAITLIST_SLUGS_ENV } from "@/lib/booking/new-client-waitlist";
import { CANCELLATION_REASONS } from "@/lib/booking/cancellation-reasons";

// ===========================================================================
// EMERG-01 — THE CANCELLATION SIDE OF WAITLIST-ONLY REBOOKING.
// ===========================================================================
//
// Cancellation itself stays ALLOWED, for every studio and every service. What
// changes for a policy-matched free consultation is what the visitor is TOLD:
//
//   J. the cancel page warns, BEFORE the destructive action, that this
//      appointment cannot be rescheduled
//   K. a scheduling-shaped reason NEVER offers "Reschedule instead"; it
//      explains the waitlist instead
//   L. an ordinary treatment cancellation keeps the existing nudge, verbatim
//   M. after a successful cancellation the visitor is pointed at the waitlist
//   N. NOTHING joins a waitlist on the visitor's behalf — no row, no PII copy
//
// The copy assertions render the REAL components through react-dom/server, so
// a refactor that reintroduces a reschedule link under a different phrasing
// still fails here.

const WAITLISTED_SLUG = "e2e-waitlist-p0";
const OPEN_SLUG = "e2e-open-studio";
const TOKEN = "raw-url-token";

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const writes: Array<{ table: string; op: string }> = [];

type ServiceShape = {
  name: string;
  modality: string | null;
  price_cents: number | null;
};

const FREE_CONSULT: ServiceShape = {
  name: "New Client Consultation",
  modality: "consultation",
  price_cents: 0,
};
const PAID_CONSULT: ServiceShape = { ...FREE_CONSULT, price_cents: 5_000 };
const TREATMENT: ServiceShape = {
  name: "Full Face",
  modality: "electrolysis",
  price_cents: 9_000,
};

const scenario = {
  tokenResolves: true,
  status: "confirmed" as string,
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  service: FREE_CONSULT as ServiceShape,
  studioSlug: WAITLISTED_SLUG as string | null,
  cancelResult: "cancelled" as string,
  // HON-47. The studio's persisted self-service flags; absent = today's row.
  flags: {} as Record<string, boolean>,
  ownerMissing: false,
  ownerLookupThrows: false,
  contextMissing: false,
  contextThrows: false,
  rpcError: null as null | { code: string; message: string },
  fetchError: null as null | { code: string; message: string },
};

const ownerEmail = vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string; retryable: boolean }> => ({ ok: true }));
const recoveryAlert = vi.fn(async () => undefined);

// --- the in-memory admin client -------------------------------------------

function studioRow() {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Test Studio",
    slug: scenario.studioSlug,
    timezone: "UTC",
    cancellation_policy_text: null,
    no_show_policy_text: null,
    send_confirmation_emails: false,
    ...scenario.flags,
  };
}

function makeQuery(table: string) {
  let columns = "";
  const chain = {
    select(value: string) {
      columns = value;
      return chain;
    },
    eq() {
      return chain;
    },
    insert() {
      writes.push({ table, op: "insert" });
      return chain;
    },
    update() {
      writes.push({ table, op: "update" });
      return chain;
    },
    upsert() {
      writes.push({ table, op: "upsert" });
      return chain;
    },
    delete() {
      writes.push({ table, op: "delete" });
      return chain;
    },
    async maybeSingle() {
      if (table === "appointments") {
        if (columns.startsWith("id, status, starts_at") && scenario.fetchError) return { data: null, error: scenario.fetchError };
        if (columns.startsWith("studio_id, client_id, practitioner_id")) {
          if (scenario.contextThrows) throw new Error("PRIVATE context token=" + TOKEN);
          if (scenario.contextMissing) return { data: null, error: { message: "PRIVATE context" } };
        }
        if (!scenario.tokenResolves) return { data: null, error: null };
        return {
          data: {
            id: "11111111-1111-4111-8111-111111111111",
            studio_id: studioRow().id,
            client_id: "33333333-3333-4333-8333-333333333333",
            practitioner_id: null,
            status: scenario.status,
            starts_at: scenario.startsAt,
            duration_minutes: 45,
            cancellation_token_hash: "a".repeat(64),
            studio: studioRow(),
            service: scenario.service,
            client: { name: "Test Client" },
          },
          error: null,
        };
      }
      // HON-47: the studio policy read. No policy column, so the studio has
      // today's defaults and every existing assertion keeps its meaning.
      if (table === "studios") return { data: studioRow(), error: null };
      if (table === "practitioners") {
        if (scenario.ownerLookupThrows) throw new Error("PRIVATE owner lookup");
        return { data: scenario.ownerMissing ? null : { display_name: "Synthetic owner", email: "owner@example.invalid" }, error: null };
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
    return scenario.rpcError ? { data: null, error: scenario.rpcError } : { data: [{ result: scenario.cancelResult }], error: null };
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
  hashAppointmentToken: () => "a".repeat(64),
}));
vi.mock("@/lib/booking/tokens", () => ({
  verifyCancellationToken: () => ({ ok: false, error: "invalid" }),
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendCancellationEmail: ownerEmail,
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: recoveryAlert }));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: () => undefined,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: (props: { href: string; children?: ReactNode }) =>
      react.createElement("a", { href: props.href }, props.children),
  };
});

const { publicCancelAppointmentAction, fetchAppointmentForCancelAction } =
  await import("@/app/cancel/[token]/actions");
const CancelPage = (await import("@/app/cancel/[token]/page")).default;
const { CancellationNudge, CancelledSuccess } = await import(
  "@/app/cancel/[token]/CancelForm"
);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const {
  FREE_CONSULT_WAITLIST_ONLY_CANCEL_HEADING,
  FREE_CONSULT_WAITLIST_ONLY_CANCEL_WARNING,
} = await import("@/lib/booking/free-consult-reschedule-policy");

const SCHEDULING_REASONS = ["schedule_changed", "prefer_reschedule"] as const;
const NON_SCHEDULING_REASONS = CANCELLATION_REASONS.map((r) => r.value).filter(
  (v) => !SCHEDULING_REASONS.includes(v as (typeof SCHEDULING_REASONS)[number]),
);

// react-dom escapes ' and " in text nodes, so assertions written in the copy's
// own punctuation would never match the raw markup.
function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function renderCancelPage(): Promise<string> {
  const element = await CancelPage({ params: Promise.resolve({ token: TOKEN }) });
  return decode(renderToStaticMarkup(element));
}

function renderNudge(
  reason: string,
  freeConsultationWaitlistOnly: boolean,
  rescheduleEnabled = true,
): string {
  return decode(
    renderToStaticMarkup(
      createElement(CancellationNudge, {
        reason,
        freeConsultationWaitlistOnly,
        rescheduleEnabled,
        rescheduleHref: `/reschedule/${TOKEN}`,
      }),
    ),
  );
}

function renderSuccess(waitlistBookingSlug: string | null, notificationUnconfirmed = false): string {
  return decode(
    renderToStaticMarkup(
      createElement(CancelledSuccess, { waitlistBookingSlug, notificationUnconfirmed }),
    ),
  );
}

function countCheckboxes(html: string): number {
  return html.split('type="checkbox"').length - 1;
}

beforeEach(() => {
  rpcCalls.length = 0;
  writes.length = 0;
  ownerEmail.mockReset().mockResolvedValue({ ok: true }); recoveryAlert.mockReset().mockResolvedValue(undefined);
  Object.assign(scenario, {
    tokenResolves: true,
    status: "confirmed",
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    // An ordinary paid treatment at a studio EMERG-01 does not name, so the
    // only rule in play below is HON-47's.
    service: TREATMENT,
    studioSlug: OPEN_SLUG,
    flags: {},
    cancelResult: "cancelled",
    ownerMissing: false, ownerLookupThrows: false, contextMissing: false, contextThrows: false,
    rpcError: null, fetchError: null,
  });
  delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
});


function cancelForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("token", TOKEN);
  fd.set("presented_policy_hash", "b".repeat(64));
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

describe("DEFAULT: no policy columns (today's rows) keeps cancellation exactly as before", () => {
  it("the page renders the cancel form and the submit reaches the command", async () => {
    const html = await renderCancelPage();
    expect(html).toMatch(/<button[^>]*type="submit"/);
    const r = await publicCancelAppointmentAction(cancelForm());
    expect(r.ok).toBe(true);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["public_cancel_appointment_with_token"]);
  });

  it("turning OTHER flags off does not touch cancellation", async () => {
    scenario.flags = { client_reschedule_enabled: false, client_portal_enabled: false };
    const r = await publicCancelAppointmentAction(cancelForm());
    expect(r.ok).toBe(true);
    expect(rpcCalls).toHaveLength(1);
  });
});

describe("client_cancellation_enabled = false", () => {
  beforeEach(() => {
    scenario.flags = { client_cancellation_enabled: false };
  });

  it("the page explains, says the booking stands, and offers no Cancel button", async () => {
    const html = await renderCancelPage();
    expect(html).not.toMatch(/<button[^>]*type="submit"/);
    expect(html).toContain("Online cancellation isn't available.");
    expect(html).toContain("still booked");
    expect(html).toContain("contact Test Studio directly");
  });

  it("the fetch action returns the bounded code instead of a summary", async () => {
    const r = await fetchAppointmentForCancelAction(TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cancellation_disabled");
  });

  it("a forged direct submit refuses BEFORE the command and writes nothing", async () => {
    const r = await publicCancelAppointmentAction(cancelForm({ acknowledged_policy: "true" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("cancellation_disabled");
      expect(r.error).toMatch(/still booked/);
    }
    expect(rpcCalls).toEqual([]);
    expect(writes).toEqual([]);
    expect(ownerEmail).not.toHaveBeenCalled();
  });

  it("an unknown token still gets the generic collapse, never the policy", async () => {
    scenario.tokenResolves = false;
    const r = await publicCancelAppointmentAction(cancelForm());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBeUndefined();
    expect(rpcCalls).toEqual([]);
  });

  it("a PAST or already-cancelled appointment gets the generic collapse, never the policy", async () => {
    for (const patch of [
      { startsAt: new Date(Date.now() - 86_400_000).toISOString() },
      { status: "cancelled" },
    ]) {
      Object.assign(scenario, patch);
      const r = await publicCancelAppointmentAction(cancelForm());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code, JSON.stringify(patch)).toBeUndefined();
      const f = await fetchAppointmentForCancelAction(TOKEN);
      expect(f.ok).toBe(false);
      if (!f.ok) expect(f.code, JSON.stringify(patch)).toBeUndefined();
      scenario.startsAt = new Date(Date.now() + 86_400_000).toISOString();
      scenario.status = "confirmed";
    }
    expect(rpcCalls).toEqual([]);
  });
});

describe("the command's own refusal (0234) maps to the same understandable copy", () => {
  it("cancellation_disabled from the command is not collapsed to the generic error", async () => {
    scenario.cancelResult = "cancellation_disabled";
    const r = await publicCancelAppointmentAction(cancelForm());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cancellation_disabled");
    expect(ownerEmail).not.toHaveBeenCalled();
  });
});

describe("an unreadable studio policy fails CLOSED", () => {
  it("refuses with the generic copy and never reaches the command", async () => {
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
      const r = await publicCancelAppointmentAction(cancelForm());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBeUndefined();
      expect(rpcCalls).toEqual([]);
    } finally {
      admin.from = originalFrom;
      silence.mockRestore();
    }
  });
});


// Codex P2 4370339945. With cancellation ON and rescheduling OFF, the cancel form
// must not tell the client they can reschedule, nor link to a route that refuses.
describe("client_reschedule_enabled drives the cancel form's reschedule nudge", () => {
  it.each([true, false])("the fetch summary carries rescheduleEnabled=%s", async (on) => {
    scenario.flags = on ? {} : { client_reschedule_enabled: false };
    const r = await fetchAppointmentForCancelAction(TOKEN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.summary.rescheduleEnabled).toBe(on);
  });

  it("the page hands the summary's flag to the form (not a constant)", () => {
    const page = readFileSync(join(process.cwd(), "app/cancel/[token]/page.tsx"), "utf8");
    expect(page).toMatch(/rescheduleEnabled=\{result\.summary\.rescheduleEnabled\}/);
  });

  it("each scheduling reason x rescheduling on/off: the text and the link are shown only when it is on", () => {
    for (const reason of SCHEDULING_REASONS) {
      const on = renderNudge(reason, false, true);
      expect(on, `${reason} on`).toContain("You can reschedule this appointment instead of cancelling.");
      expect(on, `${reason} on`).toContain(`href="/reschedule/${TOKEN}"`);
      const off = renderNudge(reason, false, false);
      expect(off, `${reason} off`).toBe("");
    }
  });

  it("a reason that never nudged still shows nothing, on or off", () => {
    for (const reason of NON_SCHEDULING_REASONS) {
      expect(renderNudge(reason, false, true)).toBe("");
      expect(renderNudge(reason, false, false)).toBe("");
    }
  });

  it("the free-consultation explanation is unaffected by the flag (it is about the consultation, not the studio)", () => {
    for (const on of [true, false]) {
      const html = renderNudge("schedule_changed", true, on);
      expect(html).toContain("Free consultations can’t be rescheduled");
      expect(html).not.toContain("/reschedule/");
    }
  });
});

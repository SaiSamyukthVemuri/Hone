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
};

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
      if (table === "practitioners") return { data: null, error: null };
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
    return { data: [{ result: scenario.cancelResult }], error: null };
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
  sendCancellationEmail: async () => ({ ok: true }),
}));
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
): string {
  return decode(
    renderToStaticMarkup(
      createElement(CancellationNudge, {
        reason,
        freeConsultationWaitlistOnly,
        rescheduleHref: `/reschedule/${TOKEN}`,
      }),
    ),
  );
}

function renderSuccess(waitlistBookingSlug: string | null): string {
  return decode(
    renderToStaticMarkup(
      createElement(CancelledSuccess, { waitlistBookingSlug }),
    ),
  );
}

function countCheckboxes(html: string): number {
  return html.split('type="checkbox"').length - 1;
}

beforeEach(() => {
  rpcCalls.length = 0;
  writes.length = 0;
  Object.assign(scenario, {
    tokenResolves: true,
    status: "confirmed",
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    service: FREE_CONSULT,
    studioSlug: WAITLISTED_SLUG,
    cancelResult: "cancelled",
  });
  process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = WAITLISTED_SLUG;
});

// ===========================================================================

describe("the cancel fetch surface derives the policy server-side", () => {
  it("flags a waitlisted studio's free consultation and carries its booking slug", async () => {
    const r = await fetchAppointmentForCancelAction(TOKEN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.freeConsultationWaitlistOnly).toBe(true);
    expect(r.summary.waitlistBookingSlug).toBe(WAITLISTED_SLUG);
  });

  it.each([
    ["paid consultation", PAID_CONSULT, WAITLISTED_SLUG],
    ["free treatment", { ...TREATMENT, price_cents: 0 }, WAITLISTED_SLUG],
    ["open studio", FREE_CONSULT, OPEN_SLUG],
  ])("%s is NOT flagged, and leaks no slug", async (_l, service, slug) => {
    scenario.service = service as ServiceShape;
    scenario.studioSlug = slug;
    const r = await fetchAppointmentForCancelAction(TOKEN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.freeConsultationWaitlistOnly).toBe(false);
    // The slug rides ONLY with the policy it serves, so this field can never
    // become a general studio-slug disclosure on a public token surface.
    expect(r.summary.waitlistBookingSlug).toBeNull();
  });

  it("an unknown token still collapses, and exposes no policy field at all", async () => {
    scenario.tokenResolves = false;
    const r = await fetchAppointmentForCancelAction(TOKEN);
    expect(r.ok).toBe(false);
    expect("summary" in r).toBe(false);
  });
});

describe("J — the cancel page warns BEFORE the destructive action", () => {
  it("shows the waitlist warning for a free consultation", async () => {
    const html = await renderCancelPage();
    expect(html).toContain(FREE_CONSULT_WAITLIST_ONLY_CANCEL_HEADING);
    expect(html).toContain(FREE_CONSULT_WAITLIST_ONLY_CANCEL_WARNING);
  });

  it("places the warning ABOVE the cancel button", async () => {
    const html = await renderCancelPage();
    const warning = html.indexOf(FREE_CONSULT_WAITLIST_ONLY_CANCEL_HEADING);
    const button = html.indexOf("Cancel appointment</button>");
    expect(warning).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(button);
  });

  it("still offers cancellation — the warning is not a block", async () => {
    const html = await renderCancelPage();
    expect(html).toContain("<button");
    expect(html).toContain("Cancel appointment</button>");
  });

  it("adds NO second acknowledgement checkbox", async () => {
    // The brief asked for a clear warning, not a new consent contract. Proved
    // by DIFFERENCE against the same page without the policy, so the existing
    // follow-up and acknowledgement checkboxes are not mistaken for new ones.
    const warned = await renderCancelPage();
    scenario.service = TREATMENT;
    const ordinary = await renderCancelPage();
    expect(countCheckboxes(warned)).toBe(countCheckboxes(ordinary));
  });

  it("does not disable or block the cancel button", async () => {
    const html = await renderCancelPage();
    // The studio has no policy text, so nothing may disable the submit.
    // React emits the attribute as `disabled=""`; the class list's
    // `disabled:opacity-50` is a style hook, not an attribute.
    expect(html).toMatch(/<button[^>]*type="submit"/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=/);
  });

  it.each([
    ["paid consultation", PAID_CONSULT, WAITLISTED_SLUG],
    ["ordinary treatment", TREATMENT, WAITLISTED_SLUG],
    ["open studio", FREE_CONSULT, OPEN_SLUG],
  ])("%s sees NO warning", async (_l, service, slug) => {
    scenario.service = service as ServiceShape;
    scenario.studioSlug = slug;
    const html = await renderCancelPage();
    expect(html).not.toContain(FREE_CONSULT_WAITLIST_ONLY_CANCEL_HEADING);
  });
});

describe("K — a scheduling-shaped reason never offers a way back into times", () => {
  it.each(SCHEDULING_REASONS)(
    "reason=%s shows the waitlist explanation, not 'Reschedule instead'",
    (reason) => {
      const html = renderNudge(reason, true);
      expect(html).not.toContain("Reschedule instead");
      expect(html).not.toContain("Would another time work better?");
      expect(html).not.toContain("/reschedule/");
      expect(html).toContain("waitlist");
    },
  );

  it.each(NON_SCHEDULING_REASONS)(
    "reason=%s shows no nudge at all under the policy",
    (reason) => {
      expect(renderNudge(reason, true)).toBe("");
    },
  );

  it("no reason picked shows nothing", () => {
    expect(renderNudge("", true)).toBe("");
  });
});

describe("L — an ordinary cancellation keeps the existing nudge verbatim", () => {
  it.each(SCHEDULING_REASONS)("reason=%s still offers Reschedule instead", (reason) => {
    const html = renderNudge(reason, false);
    expect(html).toContain("Would another time work better?");
    expect(html).toContain("Reschedule instead");
    expect(html).toContain(`href="/reschedule/${TOKEN}"`);
    expect(html).toContain("or continue cancelling below");
  });

  it.each(NON_SCHEDULING_REASONS)("reason=%s shows no nudge, as before", (reason) => {
    expect(renderNudge(reason, false)).toBe("");
  });
});

describe("M — after a successful free-consult cancellation, the waitlist is the way back", () => {
  it("confirms the cancellation and points at the studio's public booking surface", () => {
    const html = renderSuccess(WAITLISTED_SLUG);
    expect(html).toContain("Your appointment is cancelled.");
    expect(html).toContain("join the waitlist");
    expect(html).toContain("Join the waitlist");
    expect(html).toContain(`href="/book/${WAITLISTED_SLUG}"`);
  });

  it("the ordinary success surface is unchanged when the policy does not apply", () => {
    const html = renderSuccess(null);
    expect(html).toContain("Your appointment is cancelled.");
    expect(html).toContain("The studio has been notified.");
    expect(html).toContain('href="/portal"');
    expect(html).not.toContain("Join the waitlist");
  });
});

describe("N — nothing joins a waitlist on the visitor's behalf", () => {
  it("a successful cancellation writes no waitlist row and calls no waitlist command", async () => {
    const r = await publicCancelAppointmentAction(cancelForm());
    expect(r.ok).toBe(true);
    expect(writes).toEqual([]);
    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "public_cancel_appointment_with_token",
    ]);
  });

  it("no cancel or reschedule source path can reach the waitlist commit point", () => {
    for (const file of [
      join("app", "cancel", "[token]", "actions.ts"),
      join("app", "cancel", "[token]", "CancelForm.tsx"),
      join("app", "cancel", "[token]", "page.tsx"),
      join("app", "reschedule", "[token]", "actions.ts"),
      join("app", "reschedule", "[token]", "page.tsx"),
    ]) {
      const src = readFileSync(join(__dirname, "..", "..", "..", file), "utf8");
      expect(src, file).not.toContain("new_client_waitlist_entries");
      expect(src, file).not.toContain("waitlist-actions");
      expect(src, file).not.toContain("submitNewClientWaitlist");
    }
  });

  it("the waitlist CTA is a plain link — it carries no client PII", () => {
    const html = renderSuccess(WAITLISTED_SLUG);
    expect(html).toContain(`href="/book/${WAITLISTED_SLUG}"`);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("@");
  });
});

describe("cancellation is never blocked by this policy", () => {
  it("a policy-matched free consultation still cancels", async () => {
    const r = await publicCancelAppointmentAction(cancelForm());
    expect(r.ok).toBe(true);
    expect(rpcCalls).toHaveLength(1);
  });

  it("the cancel command is called with the SAME arguments as before", async () => {
    await publicCancelAppointmentAction(cancelForm({ reason: "schedule_changed" }));
    expect(Object.keys(rpcCalls[0].args).sort()).toEqual([
      "p_acknowledged_policy",
      "p_follow_up_allowed",
      "p_note",
      "p_presented_policy_hash",
      "p_reason",
      "p_reason_label",
      "p_token",
    ]);
  });
});

function cancelForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("token", TOKEN);
  fd.set("presented_policy_hash", "b".repeat(64));
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

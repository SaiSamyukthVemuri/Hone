// ===========================================================================
// HON-47 — /manage offers only the self-service paths the studio allows.
// ===========================================================================
//
// Harness copied from free-consult-waitlist-only.test.ts. /manage mutates
// nothing; each CTA it withdraws is ALSO refused by its own route (see the
// cancel and reschedule client-self-service-gate tests). Synthetic data only.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { NEW_CLIENT_WAITLIST_SLUGS_ENV } from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// EMERG-01 — /manage IS A PUBLIC RESCHEDULE ENTRY POINT.
// ===========================================================================
//
// It performs no mutation, so it is not a bypass of the server authority. But
// it is the button a client actually taps from a confirmation or reminder
// message, and offering "Reschedule appointment" to someone the policy will
// then refuse is the same defect the /reschedule page fixes, one screen
// earlier. So the CTA is withdrawn for a policy-matched appointment and the
// reason is stated once, from the same shared string.
//
// Cancellation stays offered here, exactly as before, for every studio.

const WAITLISTED_SLUG = "e2e-waitlist-p0";
const OPEN_SLUG = "e2e-open-studio";
const TOKEN = "raw-url-token";

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
  // HON-47. The studio's persisted self-service flags; absent = today's row.
  flags: {} as Record<string, boolean>,
};

// THE FAKE HONOURS THE PROJECTION, because a fake that returns columns the
// route never asked for cannot fail the way the route does. `select()` used to
// ignore its argument entirely, so this fixture handed back a studio `id` while
// the real query embedded `studios(slug)` - which is exactly how a P1 shipped
// past a suite that was green.
function embeddedColumns(select: string, alias: string): string[] | null {
  const m = new RegExp(`${alias}:[a-z_]+\\(([^)]*)\\)`).exec(select);
  return m ? m[1].split(",").map((c) => c.trim()) : null;
}

function projectEmbed<T extends Record<string, unknown>>(
  select: string,
  alias: string,
  full: T,
): Partial<T> {
  const columns = embeddedColumns(select, alias);
  if (!columns) return full;
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    if (column in full) out[column] = full[column];
  }
  return out as Partial<T>;
}

function makeQuery(table: string) {
  let projection = "";
  const chain = {
    select(columns?: string) {
      projection = columns ?? "";
      return chain;
    },
    eq() {
      return chain;
    },
    async maybeSingle() {
      if (table === "appointments") {
        if (!scenario.tokenResolves) return { data: null, error: null };
        return {
          data: {
            id: "11111111-1111-4111-8111-111111111111",
            status: scenario.status,
            starts_at: scenario.startsAt,
            studio: projectEmbed(projection, "studio", {
              id: "22222222-2222-4222-8222-222222222222",
              name: "Test Studio",
              slug: scenario.studioSlug,
              timezone: "UTC",
              cancellation_policy_text: null,
              no_show_policy_text: null,
            }),
            service: scenario.service,
          },
          error: null,
        };
      }
      // HON-47: the studio policy read. No policy column, so the studio has
      // today's defaults and every existing assertion keeps its meaning.
      if (table === "studios") {
        return {
          data: { id: "22222222-2222-4222-8222-222222222222", name: "Test Studio", ...scenario.flags },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
  return chain;
}

// NEW-CLIENT-MODE-01: admission now comes from the canonical authority.
// Delegating to the REAL resolver with no stored value routes it through the
// transition bridge, so the env stubbing below keeps meaning what it meant.
vi.mock("@/lib/booking/new-client-admission", async (orig) => {
  const actual =
    await orig<typeof import("@/lib/booking/new-client-admission")>();
  return {
    ...actual,
    getNewClientAdmissionMode: vi.fn(async (studio: { slug: string | null }) =>
      actual.resolveAdmission({
        storedMode: null,
          storedSetAt: null,
        readFailed: false,
        studioSlug: studio.slug,
      }),
    ),
    // MIRRORS THE REAL CONTRACT, INCLUDING WHAT IT REQUIRES. The previous mock
    // resolved from `slug` alone, so it stayed capable after the real resolver
    // moved to reading the canonical mode by studio ID - and this suite went on
    // passing while /manage, /cancel and /reschedule all embedded the studio as
    // `studios(slug)`, handed the resolver `undefined`, and were told "not
    // waitlisted". A free consultation at a WAITLISTED studio was offered,
    // unwarned, and reschedulable. A mock more capable than the thing it stands
    // in for cannot fail the way production does, so this one refuses too.
    studioIsInWaitlistMode: vi.fn(
      async (studio: { id?: string | null; slug?: string | null }) => {
        if (!studio?.id) {
          throw new Error(
            "studioIsInWaitlistMode was called without a studio id - the route's " +
              "studio projection must include `id`",
          );
        }
        const a = actual.resolveAdmission({
          storedMode: null,
          storedSetAt: null,
          readFailed: false,
          studioSlug: studio?.slug ?? null,
        });
        return a.ok && a.mode === "waitlist";
      },
    ),
  };
});

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ from: (t: string) => makeQuery(t) }),
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
vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: (props: { href: string; children?: ReactNode }) =>
      react.createElement("a", { href: props.href }, props.children),
  };
});

const ManagePage = (await import("@/app/manage/[token]/page")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const { FREE_CONSULT_WAITLIST_ONLY_HEADLINE } = await import(
  "@/lib/booking/free-consult-reschedule-policy"
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

async function render(): Promise<string> {
  const element = await ManagePage({ params: Promise.resolve({ token: TOKEN }) });
  return decode(renderToStaticMarkup(element));
}

beforeEach(() => {
  Object.assign(scenario, {
    tokenResolves: true,
    status: "confirmed",
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    // A paid treatment at a studio EMERG-01 does not name: only HON-47 applies.
    service: TREATMENT,
    studioSlug: OPEN_SLUG,
    flags: {},
  });
  delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
});

const RESCHEDULE = `href="/reschedule/${TOKEN}"`;
const CANCEL = `href="/cancel/${TOKEN}"`;
const PORTAL = `href="/portal"`;

describe("DEFAULT: no policy columns (today's rows) renders all three CTAs", () => {
  it("Reschedule, Cancel and Back to portal, and no contact line", async () => {
    const html = await render();
    expect(html).toContain(RESCHEDULE);
    expect(html).toContain(CANCEL);
    expect(html).toContain(PORTAL);
    expect(html).not.toContain("please contact Test Studio directly");
  });
});

describe("each flag withdraws only its own CTA", () => {
  it("rescheduling off", async () => {
    scenario.flags = { client_reschedule_enabled: false };
    const html = await render();
    expect(html).not.toContain(RESCHEDULE);
    expect(html).toContain(CANCEL);
    expect(html).toContain(PORTAL);
    expect(html).toContain("To change the time of this appointment, please contact Test Studio directly.");
  });

  it("cancellation off", async () => {
    scenario.flags = { client_cancellation_enabled: false };
    const html = await render();
    expect(html).toContain(RESCHEDULE);
    expect(html).not.toContain(CANCEL);
    expect(html).toContain("To cancel this appointment, please contact Test Studio directly.");
  });

  it("portal off", async () => {
    scenario.flags = { client_portal_enabled: false };
    const html = await render();
    expect(html).toContain(RESCHEDULE);
    expect(html).toContain(CANCEL);
    expect(html).not.toContain(PORTAL);
  });

  it("cancel AND reschedule off, portal on: the page stays, with the contact line and the portal link", async () => {
    scenario.flags = { client_cancellation_enabled: false, client_reschedule_enabled: false };
    const html = await render();
    expect(html).not.toContain(RESCHEDULE);
    expect(html).not.toContain(CANCEL);
    expect(html).toContain(PORTAL);
    expect(html).toContain("To change or cancel this appointment, please contact Test Studio directly.");
  });
});

describe("all three off (the selected initial policy)", () => {
  beforeEach(() => {
    scenario.flags = {
      client_cancellation_enabled: false,
      client_reschedule_enabled: false,
      client_portal_enabled: false,
    };
  });

  it("the page explains that the studio manages appointments, with no CTA", async () => {
    const html = await render();
    expect(html).toContain("Appointments are managed by the studio.");
    expect(html).toContain("Your appointment is unchanged.");
    expect(html).not.toContain(RESCHEDULE);
    expect(html).not.toContain(CANCEL);
    expect(html).not.toContain(PORTAL);
  });

  it("an unknown token still gets the generic collapse, never the policy", async () => {
    scenario.tokenResolves = false;
    const html = await render();
    expect(html).toContain("This manage link can't be used right now.");
    expect(html).not.toContain("Appointments are managed by the studio.");
  });

  it("a PAST appointment still gets the generic collapse, never the policy", async () => {
    scenario.startsAt = new Date(Date.now() - 86_400_000).toISOString();
    const html = await render();
    expect(html).toContain("This manage link can't be used right now.");
    expect(html).not.toContain("Appointments are managed by the studio.");
  });
});

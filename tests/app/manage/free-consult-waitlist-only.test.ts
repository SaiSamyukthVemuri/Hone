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
};

function makeQuery(table: string) {
  const chain = {
    select() {
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
            studio: {
              name: "Test Studio",
              slug: scenario.studioSlug,
              timezone: "UTC",
              cancellation_policy_text: null,
              no_show_policy_text: null,
            },
            service: scenario.service,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
  return chain;
}

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
    service: FREE_CONSULT,
    studioSlug: WAITLISTED_SLUG,
  });
  process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = WAITLISTED_SLUG;
});

describe("a policy-matched free consultation is not invited to reschedule", () => {
  it("withdraws the reschedule CTA and its link", async () => {
    const html = await render();
    expect(html).not.toContain(`href="/reschedule/${TOKEN}"`);
    expect(html).not.toContain("Reschedule appointment");
  });

  it("states the reason once, from the shared string", async () => {
    expect(await render()).toContain(FREE_CONSULT_WAITLIST_ONLY_HEADLINE);
  });

  it("still offers cancellation", async () => {
    const html = await render();
    expect(html).toContain(`href="/cancel/${TOKEN}"`);
    expect(html).toContain("Cancel appointment");
  });
});

describe("every other appointment keeps the existing manage surface", () => {
  it.each([
    ["paid consultation", PAID_CONSULT, WAITLISTED_SLUG],
    ["ordinary treatment", TREATMENT, WAITLISTED_SLUG],
    ["free consultation at an open studio", FREE_CONSULT, OPEN_SLUG],
  ])("%s still offers both actions", async (_l, service, slug) => {
    scenario.service = service as ServiceShape;
    scenario.studioSlug = slug;
    const html = await render();
    expect(html).toContain(`href="/reschedule/${TOKEN}"`);
    expect(html).toContain("Reschedule appointment");
    expect(html).toContain(`href="/cancel/${TOKEN}"`);
    expect(html).not.toContain(FREE_CONSULT_WAITLIST_ONLY_HEADLINE);
  });

  it("DEFAULT OFF — an unset gate restores both actions", async () => {
    delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
    const html = await render();
    expect(html).toContain(`href="/reschedule/${TOKEN}"`);
  });
});

describe("the collapse is unchanged", () => {
  it("an unknown token reveals nothing about the policy", async () => {
    scenario.tokenResolves = false;
    const html = await render();
    expect(html).toContain("This manage link can't be used right now.");
    expect(html).not.toContain(FREE_CONSULT_WAITLIST_ONLY_HEADLINE);
  });

  it.each([["cancelled"], ["completed"], ["no_show"]])(
    "status=%s reveals nothing about the policy",
    async (status) => {
      scenario.status = status;
      const html = await render();
      expect(html).toContain("This manage link can't be used right now.");
      expect(html).not.toContain(FREE_CONSULT_WAITLIST_ONLY_HEADLINE);
    },
  );
});

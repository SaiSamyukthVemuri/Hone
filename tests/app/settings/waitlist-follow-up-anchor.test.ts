import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { returnToDestination } from "@/lib/auth/return-to";

// HON-7. The sign-in return and the owner email both end on /settings/waitlist#follow-up. The browser only scrolls if the RENDERED page has
// an element with that id, so the target is checked as rendered (not only as a Location header), and only on the owner path.

const h = vi.hoisted(() => ({ practitioner: vi.fn(), attention: vi.fn() }));

vi.mock("server-only", () => ({}));
// The page reads its lifecycle flash cookie; outside a request there is no store, so give it an empty one.
vi.mock("next/headers", async (orig) => ({ ...(await orig<Record<string, unknown>>()), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/queries", async (orig) => ({ ...(await orig<Record<string, unknown>>()), requirePractitionerWithStudio: h.practitioner }));
// The page reads the one-shot lifecycle notice cookie (#1401); there is no request scope here, so it is empty.
vi.mock("next/headers", async (orig) => ({ ...(await orig<Record<string, unknown>>()), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("@/lib/waitlist/needs-attention", async (orig) => ({ ...(await orig<Record<string, unknown>>()), loadNeedsAttention: h.attention }));
vi.mock("@/lib/waitlist/declined-attention", () => ({ loadDeclinedAttention: async () => ({ kind: "ok", total: 0, shown: [], ids: new Set() }) }));

// A client whose every query resolves to an empty, error-free result, however it is chained.
function emptyClient(): unknown {
  const query = emptyQuery();
  // Wrapped in an object: returning the thenable itself from an async factory would resolve it away.
  return { from: () => query, rpc: () => query, auth: { admin: {} } };
}
function emptyQuery(): unknown {
  const result = { data: [], error: null, count: 0 };
  const node: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? (res: (v: unknown) => unknown) => Promise.resolve(result).then(res) : node),
    apply: () => node,
  });
  return node;
}
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => emptyClient() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => emptyClient() }));

import WaitlistSettingsPage from "@/app/(app)/settings/waitlist/page";

const studio = { id: "11111111-1111-4111-8111-111111111111", timezone: "UTC", slug: "synthetic" };
async function render(role: "owner" | "practitioner"): Promise<string> {
  h.practitioner.mockResolvedValue({ practitioner: { id: "p1", role, user_id: "u1" }, studio });
  return renderToStaticMarkup(await WaitlistSettingsPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.attention.mockResolvedValue({ kind: "ok", total: 1, shown: [{ id: "e1", name: "Synthetic Person" }] });
});

describe("the follow-up anchor", () => {
  it("the allowlisted destination names the id", () => {
    expect(returnToDestination("waitlist_followup")).toBe("/settings/waitlist#follow-up");
  });
  it("the owner page renders exactly one element with id follow-up", async () => {
    const html = await render("owner");
    expect(html.match(/id="follow-up"/g)).toHaveLength(1);
  });
  it("with the decline-answers flag on, still exactly one id follow-up: the new section owns it and the old attention section drops it", async () => {
    vi.stubEnv("WAITLIST_DECLINE_ANSWERS", "1");
    try {
      const html = await render("owner");
      expect(html.match(/id="follow-up"/g)).toHaveLength(1);
      expect(html).toContain('data-testid="decline-follow-up"');
      expect(html).toContain('id="needs-attention-heading"');
      expect(html).toMatch(/<section id="follow-up"[^>]*data-testid="decline-follow-up"/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("with the flag on and ZERO responses and nothing needing attention, the section still renders, once, with an empty state (the email CTA lands on it)", async () => {
    h.attention.mockResolvedValue({ kind: "ok", total: 0, shown: [] });
    vi.stubEnv("WAITLIST_DECLINE_ANSWERS", "1");
    try {
      const html = await render("owner");
      expect(html.match(/id="follow-up"/g)).toHaveLength(1);
      expect(html).toContain('data-testid="decline-follow-up"');
      expect(html).toContain("No responses need follow-up.");
      expect(html).not.toContain('id="needs-attention-heading"');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("with the flag off the old attention section keeps the id and no new section renders", async () => {
    const html = await render("owner");
    expect(html).not.toContain('data-testid="decline-follow-up"');
    expect(html).toMatch(/<section id="follow-up" aria-labelledby="needs-attention-heading"/);
  });
  it("a non-owner gets the notice and no such element", async () => {
    const html = await render("practitioner");
    expect(html).not.toContain('id="follow-up"');
    expect(html).toContain("Only studio owners can see the new-client waitlist.");
  });
});
